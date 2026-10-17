use crate::error::{AppError, AppResult};

/// Pages the app may open in the user's browser: where an AI API key is created and GitHub's
/// device-code page. Nothing else is opened on the WebView's say-so.
const ALLOWED: &[(&str, &str)] = &[
    ("github.com", "/login/device"),
    ("console.anthropic.com", "/"),
    ("platform.openai.com", "/"),
];

pub fn is_allowed(url: &str) -> bool {
    let Ok(u) = url::Url::parse(url) else {
        return false;
    };
    u.scheme() == "https"
        && u.username().is_empty()
        && u.port().is_none()
        && ALLOWED
            .iter()
            .any(|(host, prefix)| u.host_str() == Some(*host) && u.path().starts_with(prefix))
}

/// Open an allowed page in the default browser.
#[tauri::command]
pub fn open_external(url: String) -> AppResult<()> {
    if !is_allowed(&url) {
        return Err(AppError::new(
            "not_allowed",
            "That page can't be opened from here",
        ));
    }
    open::that(&url).map_err(|e| {
        AppError::new("open_failed", "Couldn't open the browser").with_detail(e.to_string())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_known_https_pages_are_allowed() {
        assert!(is_allowed("https://github.com/login/device"));
        assert!(is_allowed("https://console.anthropic.com/settings/keys"));
        assert!(is_allowed("https://platform.openai.com/api-keys"));
        assert!(!is_allowed("http://github.com/login/device"));
        assert!(!is_allowed("https://github.com/karthikkumararun/clew"));
        assert!(!is_allowed("https://github.com.evil.example/login/device"));
        assert!(!is_allowed("https://user@github.com/login/device"));
        assert!(!is_allowed("https://github.com:8443/login/device"));
        assert!(!is_allowed("file:///etc/passwd"));
        assert!(!is_allowed("javascript:alert(1)"));
        assert!(!is_allowed("not a url"));
    }
}
