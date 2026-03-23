# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0] - 2026-03-23

### Added

- **Learning Loop**: Self-learning feedback cycle for team memory
- **Schema centralization**: `lib/schema-manager.js` — single source of truth for all table definitions
- **Embedding backfill**: Summary-hook background worker auto-embeds observations at session end
- **Usage tracking**: `observation_usage` table tracks which observations get retrieved and used
- **Implicit feedback**: `get()` → `save()` within 30min marks observations as "contributed"
- **`rate` tool**: Explicit helpful/unhelpful rating for observations (`helpful_count` incremented)
- **Root-cause auto-categorization**: 10 categories (race-condition, state-loss, async-overwrite, timing-issue, null-reference, config-error, permission-error, ui-state-sync, offline-batch, geofence-logic)
- **Proactive similarity**: "Possibly Related" section injected at SessionStart via FTS keyword matching
- **`save()` returns related observations**: Semantically similar observations via embedding cosine similarity
- **Pattern clustering**: Auto-discovers clusters of semantically similar observations
- **`patterns` tool**: View discovered meta-patterns with member counts
- **`recommend_agent` tool**: Smart agent routing — suggests best agent type based on past successes
- **Pattern engine**: Incremental clustering on save (O(k)), batch recompute at session-end
- **Smart agent routing**: Keyword-based (instant) + embedding-based (on-demand)
- **Routing Suggestion**: In SessionStart context when keywords match
- **`last_used_at`**: Updated on every `get()` call
- **`resolution_agent_type`**: Accepted as optional param on `save()`
- **Auto-generated pattern titles**: From common words across member observations
- **Pattern merging**: Near-duplicate patterns (similarity >0.92) auto-merged
- New modules: `lib/schema-manager.js`, `lib/root-cause-detector.js`, `lib/similarity.js`, `lib/pattern-engine.js`, `lib/agent-router.js`
- `generate-embeddings.js` backfill script
- `tests/test-learning-loop.js`

### Fixed

- Timestamp inconsistency: hooks stored milliseconds, server stored seconds — all normalized to seconds
- Existing millisecond epochs auto-migrated on DB open
- context-hook epoch comparison fixed (seconds not milliseconds)

### Changed

- Schema management centralized into `lib/schema-manager.js`
- MCP server now exposes 12 tools (was 8): added `rate`, `patterns`, `recommend_agent`

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

[Unreleased]: https://github.com/timosieber/repo-mem/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/timosieber/repo-mem/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/timosieber/repo-mem/releases/tag/v0.1.0
