//! The command line of the app binary: `clew --version` and `clew --help` answer and exit before
//! any window, keychain or network access (spec: homebrew-packaging › Command-line version flag).

/// What to do with the process arguments (the first is the program name).
#[derive(Debug, PartialEq, Eq)]
pub enum CliAction {
    /// Print this text and exit with status 0.
    Print(String),
    /// Start the app.
    Run,
}

pub fn parse(args: &[String], version: &str) -> CliAction {
    match args.get(1).map(String::as_str) {
        Some("--version" | "-V") => CliAction::Print(format!("clew {version}")),
        Some("--help" | "-h") => CliAction::Print(format!(
            "clew {version}\nClew: an open-source database IDE.\n\nUsage: clew [--version] [--help]"
        )),
        _ => CliAction::Run,
    }
}

/// Where Homebrew puts casks, on Apple Silicon and on Intel. GUI apps do not see the shell's
/// `HOMEBREW_PREFIX`, so both are checked.
const CASKROOMS: [&str; 2] = ["/opt/homebrew/Caskroom/clew", "/usr/local/Caskroom/clew"];

/// True when one of `roots` exists (a Homebrew cask install of Clew).
pub fn installed_with_homebrew_in(roots: &[&str]) -> bool {
    roots.iter().any(|r| std::path::Path::new(r).is_dir())
}

#[tauri::command]
pub fn installed_with_homebrew() -> bool {
    installed_with_homebrew_in(&CASKROOMS)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(a: &[&str]) -> Vec<String> {
        a.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn version_flags_print_the_version() {
        for flag in ["--version", "-V"] {
            assert_eq!(
                parse(&args(&["clew", flag]), "0.1.0"),
                CliAction::Print("clew 0.1.0".into())
            );
        }
    }

    #[test]
    fn help_names_the_version_and_the_usage() {
        let CliAction::Print(text) = parse(&args(&["clew", "--help"]), "0.1.0") else {
            panic!("help prints");
        };
        assert!(text.starts_with("clew 0.1.0\n") && text.contains("Usage:"));
    }

    #[test]
    fn no_arguments_and_unknown_ones_start_the_app() {
        assert_eq!(parse(&args(&["clew"]), "0.1.0"), CliAction::Run);
        // macOS passes -psn_… and the OS may pass file paths; neither is ours to refuse.
        assert_eq!(parse(&args(&["clew", "-psn_0_1"]), "0.1.0"), CliAction::Run);
    }

    #[test]
    fn homebrew_install_is_a_caskroom_directory() {
        let dir = std::env::temp_dir().join(format!("clew-caskroom-{}", std::process::id()));
        let path = dir.to_string_lossy().to_string();
        assert!(!installed_with_homebrew_in(&[&path]));
        std::fs::create_dir_all(&dir).unwrap();
        assert!(installed_with_homebrew_in(&["/nonexistent/x", &path]));
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
