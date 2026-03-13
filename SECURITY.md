# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| 0.1.x   | Yes       |

## Reporting a Vulnerability

If you discover a security vulnerability in repo-mem, please report it responsibly.

**Do not open a public GitHub issue for security vulnerabilities.**

Instead, email **timo.sieber@trendingmedia.ch** with:

- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if any)

You will receive a response within 48 hours. We will work with you to understand the issue and coordinate a fix before any public disclosure.

## Security Considerations

repo-mem stores data as SQLite files committed to your Git repository. Keep in mind:

- **Database contents are visible** to anyone with repo access. Do not save secrets, passwords, or API keys as observations.
- **Hook scripts execute automatically** during Claude Code sessions. Review `.claude/settings.json` and `.repo-mem/hooks/` after cloning any repo.
- **No network calls.** repo-mem makes zero outbound network requests. All data stays local and in Git.
- **Dependencies.** The runtime uses two npm packages: `better-sqlite3` and `@modelcontextprotocol/sdk`. Keep them updated.
