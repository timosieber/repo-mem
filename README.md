<p align="center">
  <h1 align="center">repo-mem</h1>
  <p align="center">
    <strong>Team memory for Git repos.</strong><br>
    Auto-captures Claude Code sessions into searchable SQLite databases, shared across your team via Git.
  </p>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/repo-mem"><img src="https://img.shields.io/npm/v/repo-mem.svg" alt="npm version"></a>
  <a href="https://github.com/timosieber/repo-mem/blob/main/LICENSE"><img src="https://img.shields.io/npm/l/repo-mem.svg" alt="license"></a>
  <a href="https://www.npmjs.com/package/repo-mem"><img src="https://img.shields.io/npm/dm/repo-mem.svg" alt="downloads"></a>
  <a href="https://github.com/timosieber/repo-mem/issues"><img src="https://img.shields.io/github/issues/timosieber/repo-mem.svg" alt="issues"></a>
</p>

<p align="center">
  <a href="#quick-start">Quick Start</a> &bull;
  <a href="#how-it-works">How It Works</a> &bull;
  <a href="#mcp-tools">MCP Tools</a> &bull;
  <a href="#team-workflow">Team Workflow</a> &bull;
  <a href="#contributing">Contributing</a>
</p>

---

## Why repo-mem exists

Real projects have multiple developers working with Claude Code on the same codebase — sometimes for months. Every session produces valuable knowledge: why something was built a certain way, what broke and how it was fixed, which approaches were tried and abandoned.

**Without repo-mem, all of that disappears when the session ends.**

Developer A spends an afternoon restructuring the payment flow and discovers that the webhook handler has a subtle race condition. She fixes it, commits, moves on. Two weeks later, Developer B needs to add retry logic to the same webhook handler. Claude starts from zero — no idea about the race condition, the fix, or why certain code looks the way it does. B's Claude might even reintroduce the bug that A already solved.

This isn't about finding "the same bug twice." It's about **connected knowledge**. When B works on something related to what A did, Claude should know:

- What A changed and *why* (not just the diff, but the reasoning)
- What problems A ran into along the way
- What architectural decisions were made and what trade-offs were considered
- What A explicitly wanted to preserve for future sessions

**repo-mem makes this automatic.** Every session's key discoveries, bug fixes, and decisions are captured and searchable by every team member's Claude instance. When B starts working on that webhook, Claude can instantly find A's observations about the race condition — complete with root cause analysis, the fix, and lessons learned.

### Built for real teams

We built repo-mem for our own 3-person team working on a GPS-based time tracking system ([AURON](https://github.com/timosieber/AURON)). With 4,000+ observations across iOS, Android, backend, and admin dashboard — repo-mem is how our Claude instances share context about entry/exit detection edge cases, Supabase RLS policies, offline sync bugs, and hundreds of other decisions that would be impossible to maintain in a CLAUDE.md file.

## Key features

- **Zero effort** — Knowledge is captured via hooks, no manual steps needed
- **Team-wide** — Everyone's discoveries are searchable by everyone else
- **Git-native** — Data lives in the repo, shared via normal `git push`/`pull`
- **Token-efficient** — Compact indexes (~50 tokens/result), load full details on demand
- **Lightweight** — SQLite + FTS5, only 2 npm dependencies, no external services

## Quick Start

```bash
cd your-repo
npx repo-mem init
```

That's it. Restart Claude Code and it works.

### What happens during init

1. Creates `.repo-mem/` with MCP server, hooks, and SQLite schema
2. Installs runtime dependencies (`better-sqlite3`, `@modelcontextprotocol/sdk`)
3. Registers the MCP server in `.mcp.json`
4. Configures Claude Code hooks in `.claude/settings.json`
5. Adds usage instructions to `CLAUDE.md`

### New team member setup

After cloning a repo that already uses repo-mem:

```bash
npx repo-mem init
```

It detects the existing `.repo-mem/` directory and only installs dependencies + configures local settings. No data is overwritten.

## How It Works

```
Session Start
  → context-hook loads recent team activity (~200 tokens)
  → Claude sees what happened since last session

During Work
  → save-hook captures commits, deploys, test runs automatically
  → Claude can search({query: "auth bug"}) for past knowledge
  → Claude can save({type: "bugfix", title: "..."}) important findings

Session End
  → summary-hook records what was done + files changed
  → Knowledge persists for the next session
```

### Architecture

repo-mem adds three components to your repo:

| Component | What it does |
|-----------|-------------|
| **MCP Server** | Gives Claude Code 8 new tools (`search`, `save`, `get`, `timeline`, etc.) |
| **Auto-capture hooks** | Records commits, deploys, test runs, and session summaries automatically |
| **Session context** | Injects recent team activity at the start of each new session |

All data is stored as SQLite files in `.repo-mem/data/`, committed to the repo so your whole team shares knowledge.

### Data model

Each collaborator gets their own SQLite database (`data/{email}.db`), but everyone can search across all databases.

The schema tracks three entities:

- **Observations** — Individual knowledge entries (bug fixes, discoveries, decisions, etc.) with full-text search via FTS5
- **Session summaries** — Automatic end-of-session records with files changed
- **Sessions** — Session lifecycle tracking

## Team Workflow

**Monday:** Alice refactors the payment service. She discovers that the webhook handler has a race condition with concurrent requests. Claude saves the finding:

```
save({
  type: "bugfix",
  title: "Payment webhook race condition with concurrent retries",
  narrative: "When Stripe sends multiple webhooks within 100ms, the handler creates
    duplicate records because the DB check and insert aren't atomic. Fixed with
    SELECT FOR UPDATE + unique constraint on idempotency_key.",
  facts: ["Stripe can send duplicate webhooks within 100ms",
          "Must use DB-level uniqueness, not application-level checks"],
  files_modified: ["src/webhooks/payment.ts", "migrations/add_idempotency_key.sql"]
})
```

**Wednesday:** Bob needs to add retry logic to the same webhook handler. His Claude starts a new session, and **automatically finds Alice's observation**:

```
search({query: "webhook payment"})
→ #847 | Alice | bugfix | Payment webhook race condition with concurrent retries
```

Bob's Claude now knows about the race condition, the idempotency key pattern, and why the code looks the way it does — before writing a single line.

**This is the difference.** Without repo-mem, Bob's Claude would have started blind, potentially reintroducing the concurrency bug or spending time rediscovering what Alice already solved.

Each person's SQLite database is small (typically < 1 MB) and merges cleanly via Git since each collaborator writes only to their own file.

## MCP Tools

| Tool | Purpose | Tokens |
|------|---------|--------|
| `search` | Full-text search across all team databases | ~50/result |
| `get` | Load single observation with full detail | ~200–800 |
| `get_batch` | Load multiple observations efficiently | batched |
| `timeline` | Chronological view around a specific event | ~50/entry |
| `save` | Save a structured observation | — |
| `save_summary` | Save a session summary | — |
| `team_activity` | Recent work by other collaborators | ~50/entry |
| `help` | Show documentation and current config | — |

### Search examples

```javascript
// Full-text search
search({ query: "redis connection timeout" })

// Filter by type
search({ query: "*", obs_type: "bugfix", limit: 50 })

// Filter by author
search({ query: "auth", user: "alice@company.com" })

// Date range
search({ query: "deploy", dateStart: "2025-03-01", dateEnd: "2025-03-15" })

// Search session summaries
search({ query: "refactor", type: "summaries" })
```

### Save examples

```javascript
save({
  type: "bugfix",
  title: "Fix Redis connection loss after TTL expiry",
  narrative: "Root cause: company_id was being lost from Redis state after the 30-minute TTL. The updateUserState function was merging with null instead of preserving existing fields.",
  facts: ["Redis TTL is 30min", "updateUserState merges with null on expiry"],
  files_modified: ["src/redis-state.js", "src/user-context.ts"]
})
```

## Auto-Captured Events

The hooks automatically record high-signal events while skipping noise:

| Event | What's captured | How |
|-------|----------------|-----|
| Git commit | Commit message + result | `save-hook` (PostToolUse) |
| Git push/merge | Operation record | `save-hook` (PostToolUse) |
| Test runs | Test results summary | `save-hook` (PostToolUse) |
| Deploys | Deploy command + output | `save-hook` (PostToolUse) |
| Migrations | Migration execution | `save-hook` (PostToolUse) |
| Session end | Summary + files changed | `summary-hook` (Stop) |
| Session start | Team activity context | `context-hook` (SessionStart) |

Read-only tools (Read, Glob, Grep) and individual file edits are deliberately skipped to keep the signal-to-noise ratio high. File changes are captured in bulk at session end via `git diff`.

## File Structure

After `npx repo-mem init`, your repo gets:

```
your-repo/
├── .repo-mem/
│   ├── server.js          # MCP server (8 tools)
│   ├── start-server.js    # Auto-install wrapper
│   ├── schema.sql         # SQLite schema (FTS5)
│   ├── package.json       # Runtime dependencies
│   ├── hooks/
│   │   ├── save-hook.js   # Auto-capture (PostToolUse)
│   │   ├── summary-hook.js # Session summary (Stop)
│   │   └── context-hook.js # Team context (SessionStart)
│   └── data/
│       ├── alice@co.com.db # Alice's observations
│       └── bob@co.com.db   # Bob's observations
├── .mcp.json              # MCP server registration
├── .claude/
│   └── settings.json      # Hook registration
└── CLAUDE.md              # Updated with usage instructions
```

## Check Status

```bash
npx repo-mem status
```

Shows initialization state, installed dependencies, configured hooks, and observation counts per user.

## Configuration

### User identity

repo-mem identifies users in this order:

1. `REPO_MEM_USER` environment variable (highest priority)
2. `git config user.email`
3. OS username mapped via `.repo-mem/users.json`

### Custom user mapping

For environments where git email isn't configured, create `.repo-mem/users.json`:

```json
{
  "deploy-bot": "ci@company.com",
  "shared-dev": "team@company.com"
}
```

## How It Compares

| | repo-mem | claude-mem | CLAUDE.md |
|---|---------|-----------|-----------|
| **Team shared** | Yes (via Git) | No (local only) | No |
| **Auto-capture** | Yes (hooks) | Yes (hooks) | Manual |
| **Search** | FTS5 full-text | ChromaDB vector | Ctrl+F |
| **Storage** | SQLite in repo | Local ChromaDB | Markdown files |
| **Dependencies** | 2 packages | Many (Chroma, Bun, etc.) | None |
| **Setup** | `npx repo-mem init` | Plugin install | Manual editing |
| **Token cost** | ~50/result (compact) | Variable | Full file each time |

## Requirements

- **Node.js** 18 or later
- **Git** repository
- **Claude Code** (any version with MCP + hooks support)

## Privacy & Security

- All data stays in your repository — no external services, no cloud sync
- Each user's database is a plain SQLite file you can inspect, export, or delete at any time
- The `.repo-mem/data/` directory is committed to Git, so your organization's Git access controls apply
- No telemetry, no analytics, no network calls

## Troubleshooting

**MCP server not loading?**
Run `npx repo-mem status` to check if dependencies are installed and config files are in place. Restart Claude Code after running `init`.

**"No observations yet" after working?**
Observations are created on commits, deploys, and test runs — not on every file edit. Try making a git commit and check again.

**Database locked errors?**
repo-mem uses WAL mode for concurrent reads. If you see lock errors, ensure only one Claude Code instance writes to the same user database at a time.

**Want to reset your data?**
Delete your personal database file: `rm .repo-mem/data/your@email.db`

## Contributing

Contributions are welcome! Please see [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## License

[MIT](LICENSE) — Timo Sieber
