# Contributing to repo-mem

Thanks for your interest in contributing to repo-mem! This document covers everything you need to get started.

## Development Setup

### Prerequisites

- Node.js 18+
- Git
- Claude Code (for end-to-end testing)

### Getting started

```bash
# Clone the repo
git clone https://github.com/timosieber/repo-mem.git
cd repo-mem

# No install needed — repo-mem has zero dev dependencies.
# The runtime dependencies (better-sqlite3, MCP SDK) are installed
# inside .repo-mem/ during `npx repo-mem init`, not at the top level.
```

### Project structure

```
repo-mem/
├── bin/cli.js          # CLI entry point (init, status, help)
├── templates/          # Files copied into .repo-mem/ during init
│   ├── server.js       # MCP server with 8 tools
│   ├── start-server.js # Auto-install launcher
│   ├── schema.sql      # SQLite schema (FTS5)
│   ├── package.json    # Runtime dependencies
│   ├── .gitignore      # Ignores node_modules inside .repo-mem
│   └── hooks/
│       ├── save-hook.js    # PostToolUse hook
│       ├── summary-hook.js # Stop hook
│       └── context-hook.js # SessionStart hook
├── package.json        # npm package config
├── LICENSE
└── README.md
```

### Testing locally

To test your changes end-to-end:

```bash
# Create a test repo
mkdir /tmp/test-repo && cd /tmp/test-repo
git init

# Run your local version of repo-mem
node /path/to/repo-mem/bin/cli.js init

# Verify
node /path/to/repo-mem/bin/cli.js status

# Open Claude Code in the test repo and verify:
# 1. MCP server loads (check with `help` tool)
# 2. Hooks fire on commits
# 3. Search returns results
```

## How to Contribute

### Reporting bugs

Open a [GitHub issue](https://github.com/timosieber/repo-mem/issues/new?template=bug_report.md) with:

- Your Node.js version (`node --version`)
- Your OS
- Steps to reproduce
- Expected vs. actual behavior
- Output of `npx repo-mem status`

### Suggesting features

Open a [GitHub issue](https://github.com/timosieber/repo-mem/issues/new?template=feature_request.md) describing:

- The problem you're trying to solve
- Your proposed solution
- Any alternatives you've considered

### Submitting changes

1. Fork the repository
2. Create a feature branch: `git checkout -b feat/your-feature`
3. Make your changes
4. Test locally (see above)
5. Commit with a clear message: `git commit -m "feat: add observation export command"`
6. Push to your fork: `git push origin feat/your-feature`
7. Open a Pull Request

### Commit messages

We follow [Conventional Commits](https://www.conventionalcommits.org/):

```
feat: add new CLI command for exporting observations
fix: handle empty transcript in summary hook
docs: clarify user identity detection order
refactor: extract DB helpers into shared module
chore: update MCP SDK to v1.13
```

## Code Style

### General principles

- **Keep it simple.** repo-mem succeeds because it's lightweight. Think twice before adding dependencies.
- **Be fast.** Hooks run on every tool use. The save-hook must exit in <50ms for skipped events.
- **Fail silently.** Hooks and the MCP server should never block Claude Code. Wrap everything in try/catch.
- **Be token-efficient.** Every byte the MCP server returns costs tokens. Keep responses compact.

### JavaScript conventions

- ES modules (`import`/`export`), not CommonJS
- No transpilation — code runs directly on Node.js 18+
- No external linter config (keep it dependency-free)
- Use `const` by default, `let` when reassignment is needed
- Prefer early returns over nested conditions

### What makes a good PR

- **Focused.** One feature or fix per PR.
- **Tested.** Include steps to verify the change works end-to-end.
- **Documented.** Update README.md if the change affects user-facing behavior.
- **Backwards-compatible.** Existing `.repo-mem/` directories should keep working after updates.

## Architecture Decisions

### Why SQLite instead of a vector database?

Full-text search (FTS5) handles the repo-mem use case well: developers search for specific terms like error messages, function names, and file paths. Vector similarity search adds complexity (embedding models, chunking, distance metrics) without clear benefit for structured, keyword-heavy technical content.

### Why per-user databases?

Git doesn't handle concurrent writes to the same file well. Separate databases per user means no merge conflicts — each person only writes to their own `.db` file.

### Why no AI in hooks?

Hooks must be fast and deterministic. Adding LLM calls would make them slow, expensive, and unpredictable. The MCP server handles the "smart" part; hooks are purely mechanical.

### Why committed to the repo?

This is the core design choice. By storing data in Git, team knowledge follows the code. No external service to configure, no sync to manage, no access controls to duplicate. Your Git hosting (GitHub, GitLab, etc.) handles everything.

## Getting Help

- Open an issue on [GitHub](https://github.com/timosieber/repo-mem/issues)
- Check existing issues and discussions for solutions

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
