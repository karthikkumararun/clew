# Security policy

Clew connects to databases with real credentials, so security reports are welcome and taken seriously.

## Reporting a vulnerability

Please **do not open a public issue**. Report it privately:

1. Go to <https://github.com/karthikkumararun/clew/security/advisories/new> (GitHub's private vulnerability reporting).
2. Describe what you found, how to reproduce it, the version (About › Version and commit) and the platform.
3. Attach the diagnostics report if it helps (About › Copy diagnostics). It contains no passwords, tokens, hostnames or query text.

You can expect an acknowledgement within a few days and a fix or a plan for one within 30 days for confirmed issues. You will be credited in the release notes unless you prefer not to be.

## Supported versions

Only the latest release receives security fixes.

## What counts

Of particular interest: secrets (database passwords, SSH passphrases, AI API keys) leaving the OS keychain, anything that runs SQL the user did not ask for, the AI assistant sending data its settings forbid, update or download verification being bypassed, and the WebView reaching the network or the file system more than the app intends.

## How Clew handles secrets

Passwords, SSH passphrases and AI keys live only in the operating system's keychain (macOS Keychain, Windows Credential Manager). They are never written to files, logs, error messages or IPC payloads sent to the WebView. Clew makes no network requests of its own except to databases and SSH hosts you configure, AI endpoints you configure, the GitHub Copilot component download you consent to, and the update check if you turn it on. There is no telemetry.
