//! Getting GitHub's Copilot language server onto this machine (spec: ai-providers › Component
//! download consent). It is downloaded only after the user agrees, from the npm registry, for one
//! pinned version; the registry's `sha512` integrity value is checked before anything is unpacked.

use std::path::{Path, PathBuf};

use base64::Engine;
use futures::StreamExt;
use sha2::{Digest, Sha512};
use tokio::io::AsyncWriteExt;
use tokio_util::sync::CancellationToken;

/// The pinned version of `@github/copilot-language-server`.
pub const VERSION: &str = "1.554.0";
pub const REGISTRY: &str = "https://registry.npmjs.org";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum InstallError {
    /// This platform has no build of the component.
    Unsupported,
    Network(String),
    /// The download doesn't match the registry's checksum.
    Integrity,
    /// The archive doesn't hold the component.
    Missing,
    Io(String),
    Cancelled,
}

impl std::fmt::Display for InstallError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Unsupported => f.write_str("GitHub Copilot isn't available for this platform"),
            Self::Network(m) => write!(f, "Couldn't download the Copilot component: {m}"),
            Self::Integrity => {
                f.write_str("The Copilot download didn't match its checksum, so it was discarded")
            }
            Self::Missing => f.write_str("The Copilot download didn't contain the component"),
            Self::Io(m) => write!(f, "Couldn't install the Copilot component: {m}"),
            Self::Cancelled => f.write_str("Cancelled"),
        }
    }
}

/// `darwin-arm64`, `win32-x64`, ...: the suffix of the platform package.
pub fn platform() -> Option<&'static str> {
    Some(match (std::env::consts::OS, std::env::consts::ARCH) {
        ("macos", "aarch64") => "darwin-arm64",
        ("macos", "x86_64") => "darwin-x64",
        ("windows", "x86_64") => "win32-x64",
        ("windows", "aarch64") => "win32-arm64",
        ("linux", "x86_64") => "linux-x64",
        ("linux", "aarch64") => "linux-arm64",
        _ => return None,
    })
}

pub fn binary_name() -> &'static str {
    if cfg!(windows) {
        "copilot-language-server.exe"
    } else {
        "copilot-language-server"
    }
}

/// `<data dir>/copilot/<version>/`
pub fn install_dir(data_dir: &Path, version: &str) -> PathBuf {
    data_dir.join("copilot").join(version)
}

/// The component, when it has been installed.
pub fn installed(data_dir: &Path, version: &str) -> Option<PathBuf> {
    let p = install_dir(data_dir, version).join(binary_name());
    p.is_file().then_some(p)
}

/// What the registry says about the pinned platform package.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Release {
    pub tarball: String,
    /// `sha512-<base64>`.
    pub integrity: String,
    /// Bytes to download, as far as the registry says.
    pub download_bytes: Option<u64>,
}

pub async fn lookup(
    client: &reqwest::Client,
    registry: &str,
    platform: &str,
    version: &str,
) -> Result<Release, InstallError> {
    let url = format!("{registry}/@github/copilot-language-server-{platform}/{version}");
    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| InstallError::Network(e.without_url().to_string()))?;
    if !resp.status().is_success() {
        return Err(InstallError::Network(format!(
            "the registry answered {}",
            resp.status().as_u16()
        )));
    }
    let v: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| InstallError::Network(e.without_url().to_string()))?;
    let dist = &v["dist"];
    let tarball = dist["tarball"]
        .as_str()
        .ok_or(InstallError::Missing)?
        .to_string();
    let integrity = dist["integrity"]
        .as_str()
        .ok_or(InstallError::Missing)?
        .to_string();
    // The tarball's own size, for the consent dialog.
    let download_bytes = match client.head(&tarball).send().await {
        Ok(r) => r
            .headers()
            .get(reqwest::header::CONTENT_LENGTH)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.parse().ok()),
        Err(_) => None,
    };
    Ok(Release {
        tarball,
        integrity,
        download_bytes,
    })
}

/// `sha512-<base64>` of the file at `path`.
pub fn sha512_integrity(path: &Path) -> std::io::Result<String> {
    use std::io::Read;
    let mut f = std::fs::File::open(path)?;
    let mut hasher = Sha512::new();
    let mut buf = vec![0u8; 1 << 16];
    loop {
        let n = f.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(format!(
        "sha512-{}",
        base64::engine::general_purpose::STANDARD.encode(hasher.finalize())
    ))
}

/// Download the release to a temporary file, check its integrity, and unpack the component into
/// `dest` (the version directory). `progress` hears (bytes so far, total when known).
pub async fn install(
    client: &reqwest::Client,
    release: &Release,
    dest: &Path,
    progress: &(dyn Fn(u64, Option<u64>) + Send + Sync),
    cancel: &CancellationToken,
) -> Result<PathBuf, InstallError> {
    let io = |e: std::io::Error| InstallError::Io(e.to_string());
    std::fs::create_dir_all(dest).map_err(io)?;
    let tmp = dest.join("download.tgz.partial");
    let result = match download(client, release, &tmp, progress, cancel).await {
        Ok(()) => {
            let path = tmp.clone();
            let expected = release.integrity.clone();
            let dest = dest.to_path_buf();
            tokio::task::spawn_blocking(move || verify_and_unpack(&path, &expected, &dest))
                .await
                .map_err(|e| InstallError::Io(e.to_string()))?
        }
        Err(e) => Err(e),
    };
    let _ = std::fs::remove_file(&tmp);
    if result.is_err() {
        // Leave nothing half-installed behind.
        let _ = std::fs::remove_file(dest.join(binary_name()));
    }
    result
}

async fn download(
    client: &reqwest::Client,
    release: &Release,
    tmp: &Path,
    progress: &(dyn Fn(u64, Option<u64>) + Send + Sync),
    cancel: &CancellationToken,
) -> Result<(), InstallError> {
    let io = |e: std::io::Error| InstallError::Io(e.to_string());
    let resp = client
        .get(&release.tarball)
        .send()
        .await
        .map_err(|e| InstallError::Network(e.without_url().to_string()))?;
    if !resp.status().is_success() {
        return Err(InstallError::Network(format!(
            "the registry answered {}",
            resp.status().as_u16()
        )));
    }
    let total = resp.content_length().or(release.download_bytes);
    let mut file = tokio::fs::File::create(tmp).await.map_err(io)?;
    let mut stream = resp.bytes_stream();
    let mut done = 0u64;
    loop {
        let next = tokio::select! {
            biased;
            _ = cancel.cancelled() => return Err(InstallError::Cancelled),
            n = stream.next() => n,
        };
        match next {
            None => break,
            Some(Err(e)) => return Err(InstallError::Network(e.without_url().to_string())),
            Some(Ok(chunk)) => {
                file.write_all(&chunk).await.map_err(io)?;
                done += chunk.len() as u64;
                progress(done, total);
            }
        }
    }
    file.flush().await.map_err(io)
}

fn verify_and_unpack(archive: &Path, expected: &str, dest: &Path) -> Result<PathBuf, InstallError> {
    let io = |e: std::io::Error| InstallError::Io(e.to_string());
    if sha512_integrity(archive).map_err(io)? != expected {
        return Err(InstallError::Integrity);
    }
    let file = std::fs::File::open(archive).map_err(io)?;
    let mut tar = tar::Archive::new(flate2::read::GzDecoder::new(file));
    let wanted = binary_name();
    for entry in tar.entries().map_err(io)? {
        let mut entry = entry.map_err(io)?;
        let is_binary = entry
            .path()
            .map_err(io)?
            .file_name()
            .is_some_and(|n| n == wanted);
        if !is_binary {
            continue;
        }
        let out = dest.join(wanted);
        let partial = dest.join(format!("{wanted}.partial"));
        entry.unpack(&partial).map_err(io)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&partial, std::fs::Permissions::from_mode(0o755))
                .map_err(io)?;
        }
        std::fs::rename(&partial, &out).map_err(io)?;
        return Ok(out);
    }
    Err(InstallError::Missing)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::copilot::testing::{integrity_of, package};
    use crate::ai::test_server::{serve, Canned};
    use std::io::Write;

    fn release(server: &str, bytes: &[u8]) -> Release {
        Release {
            tarball: format!("{server}/pkg.tgz"),
            integrity: integrity_of(bytes),
            download_bytes: Some(bytes.len() as u64),
        }
    }

    #[tokio::test]
    async fn downloads_verifies_and_unpacks_the_component() {
        let tgz = package(b"#!fake server");
        let server = serve(vec![Canned::bytes(
            200,
            "application/octet-stream",
            tgz.clone(),
        )])
        .await;
        let dir = tempfile::tempdir().unwrap();
        let dest = install_dir(dir.path(), "9.9.9");
        let seen = std::sync::Mutex::new(Vec::new());
        let bin = install(
            &reqwest::Client::new(),
            &release(&server.url, &tgz),
            &dest,
            &|done, total| seen.lock().unwrap().push((done, total)),
            &CancellationToken::new(),
        )
        .await
        .unwrap();
        assert_eq!(std::fs::read(&bin).unwrap(), b"#!fake server");
        assert_eq!(installed(dir.path(), "9.9.9"), Some(bin.clone()));
        let seen = seen.lock().unwrap();
        assert_eq!(seen.last().unwrap().0, tgz.len() as u64);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&bin).unwrap().permissions().mode() & 0o111,
                0o111
            );
        }
        assert!(
            !dest.join("download.tgz.partial").exists(),
            "the temporary file is gone"
        );
    }

    /// (spec: ai-providers › Component download consent: verifies its checksum)
    #[tokio::test]
    async fn a_download_that_doesnt_match_its_checksum_is_discarded() {
        let tgz = package(b"real");
        let tampered = package(b"evil");
        let server = serve(vec![Canned::bytes(
            200,
            "application/octet-stream",
            tampered,
        )])
        .await;
        let dir = tempfile::tempdir().unwrap();
        let dest = install_dir(dir.path(), "9.9.9");
        let err = install(
            &reqwest::Client::new(),
            &release(&server.url, &tgz),
            &dest,
            &|_, _| {},
            &CancellationToken::new(),
        )
        .await
        .unwrap_err();
        assert_eq!(err, InstallError::Integrity);
        assert!(
            installed(dir.path(), "9.9.9").is_none(),
            "nothing was installed"
        );
        assert!(!dest.join("download.tgz.partial").exists());
    }

    #[tokio::test]
    async fn an_archive_without_the_component_is_rejected() {
        let mut tar_bytes = Vec::new();
        {
            let mut b = tar::Builder::new(&mut tar_bytes);
            let mut h = tar::Header::new_gnu();
            h.set_size(2);
            h.set_cksum();
            b.append_data(&mut h, "package/README.md", b"hi".as_slice())
                .unwrap();
            b.finish().unwrap();
        }
        let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
        gz.write_all(&tar_bytes).unwrap();
        let tgz = gz.finish().unwrap();
        let server = serve(vec![Canned::bytes(
            200,
            "application/octet-stream",
            tgz.clone(),
        )])
        .await;
        let dir = tempfile::tempdir().unwrap();
        let err = install(
            &reqwest::Client::new(),
            &release(&server.url, &tgz),
            &install_dir(dir.path(), "1"),
            &|_, _| {},
            &CancellationToken::new(),
        )
        .await
        .unwrap_err();
        assert_eq!(err, InstallError::Missing);
    }

    #[tokio::test]
    async fn a_server_error_is_a_network_error_and_cancelling_stops_the_download() {
        let server = serve(vec![Canned::json(503, "{}")]).await;
        let dir = tempfile::tempdir().unwrap();
        let rel = release(&server.url, b"x");
        let err = install(
            &reqwest::Client::new(),
            &rel,
            &install_dir(dir.path(), "1"),
            &|_, _| {},
            &CancellationToken::new(),
        )
        .await
        .unwrap_err();
        assert!(matches!(err, InstallError::Network(m) if m.contains("503")));

        let tgz = package(b"x");
        let server = serve(vec![Canned::bytes(
            200,
            "application/octet-stream",
            tgz.clone(),
        )])
        .await;
        let cancel = CancellationToken::new();
        cancel.cancel();
        let err = install(
            &reqwest::Client::new(),
            &release(&server.url, &tgz),
            &install_dir(dir.path(), "2"),
            &|_, _| {},
            &cancel,
        )
        .await
        .unwrap_err();
        assert_eq!(err, InstallError::Cancelled);
    }

    #[tokio::test]
    async fn lookup_reads_the_integrity_and_tolerates_an_unknown_size() {
        let meta = r#"{"dist":{"tarball":"http://127.0.0.1:1/x.tgz","integrity":"sha512-abc"}}"#;
        let server = serve(vec![Canned::json(200, meta)]).await;
        // The HEAD of an unreachable tarball just leaves the size unknown.
        let r = lookup(
            &reqwest::Client::new(),
            &server.url,
            "darwin-arm64",
            "1.2.3",
        )
        .await
        .unwrap();
        assert_eq!(r.integrity, "sha512-abc");
        assert_eq!(r.download_bytes, None);
        let seen = server.requests.lock().unwrap();
        assert_eq!(
            seen[0].path,
            "/@github/copilot-language-server-darwin-arm64/1.2.3"
        );
    }

    #[test]
    fn this_platform_has_a_build() {
        assert!(platform().is_some());
    }
}
