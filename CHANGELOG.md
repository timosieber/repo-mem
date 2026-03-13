# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-03-13

### Added

- Initial release
- CLI with `init`, `status`, and `help` commands
- MCP server with 8 tools: `search`, `get`, `get_batch`, `timeline`, `save`, `save_summary`, `team_activity`, `help`
- SQLite storage with FTS5 full-text search
- Per-user databases to avoid Git merge conflicts
- Auto-capture hooks:
  - `save-hook` (PostToolUse) — captures commits, deploys, test runs, migrations
  - `summary-hook` (Stop) — records session summary with files changed via git diff
  - `context-hook` (SessionStart) — injects recent team activity (~200 tokens)
- Auto-install wrapper (`start-server.js`) for zero-friction onboarding
- Deep-merge logic for hook configuration (preserves existing hooks)
- CLAUDE.md auto-update with usage instructions
- User identity detection: env var > git email > OS username mapping

[Unreleased]: https://github.com/AuronTM/repo-mem/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/AuronTM/repo-mem/releases/tag/v0.1.0
