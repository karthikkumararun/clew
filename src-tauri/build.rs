fn main() {
    // The commit shown in the About dialog and the diagnostics report.
    let commit = std::process::Command::new("git")
        .args(["rev-parse", "--short", "HEAD"])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_else(|| "unknown".into());
    println!("cargo:rustc-env=CLEW_COMMIT={commit}");
    println!("cargo:rerun-if-changed=../.git/HEAD");
    tauri_build::build()
}
