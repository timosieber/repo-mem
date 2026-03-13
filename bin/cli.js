#!/usr/bin/env node

/**
 * repo-mem CLI — Team Memory for any Git repository
 *
 * Usage:
 *   npx repo-mem init      Initialize repo-mem in current git repo
 *   npx repo-mem status    Show current repo-mem status
 *   npx repo-mem help      Show help
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, appendFileSync, readdirSync } from 'fs';
import { execSync } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATES_DIR = join(__dirname, '..', 'templates');

// ─── Helpers ────────────────────────────────────────────────────────────────

function log(symbol, msg) {
  console.log(`${symbol} ${msg}`);
}

function logError(msg) {
  console.error(`\n  ERROR: ${msg}\n`);
}

function getGitRoot() {
  try {
    return execSync('git rev-parse --show-toplevel', { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch {
    return null;
  }
}

function readJSON(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

function writeJSON(filePath, data) {
  writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf-8');
}

function deepMergeHooks(existing, incoming) {
  // Deep merge hooks config: append incoming hook entries without duplicating
  if (!existing.hooks) existing.hooks = {};

  for (const [eventName, incomingEntries] of Object.entries(incoming.hooks)) {
    if (!existing.hooks[eventName]) {
      existing.hooks[eventName] = incomingEntries;
      continue;
    }

    // Check if repo-mem hook already exists for this event
    const existingCommands = existing.hooks[eventName]
      .flatMap(entry => (entry.hooks || []).map(h => h.command || ''));

    for (const entry of incomingEntries) {
      const entryCommands = (entry.hooks || []).map(h => h.command || '');
      const alreadyExists = entryCommands.every(cmd =>
        existingCommands.some(existing => existing.includes('.repo-mem/hooks/'))
      );

      if (!alreadyExists) {
        existing.hooks[eventName].push(entry);
      }
    }
  }

  return existing;
}

// ─── Template files to copy ─────────────────────────────────────────────────

const TEMPLATE_FILES = [
  'server.js',
  'start-server.js',
  'schema.sql',
  'package.json',
  '.gitignore',
];

const HOOK_FILES = [
  'hooks/save-hook.js',
  'hooks/summary-hook.js',
  'hooks/context-hook.js',
];

// ─── MCP Server config ─────────────────────────────────────────────────────

const MCP_CONFIG = {
  mcpServers: {
    'repo-mem': {
      type: 'stdio',
      command: 'node',
      args: ['.repo-mem/start-server.js'],
    },
  },
};

// ─── Hooks config ───────────────────────────────────────────────────────────

function makeWalkUpCommand(hookFile) {
  return `D=$(pwd); while [ "$D" != "/" ]; do [ -f "$D/.repo-mem/hooks/${hookFile}" ] && exec node "$D/.repo-mem/hooks/${hookFile}"; D=$(dirname "$D"); done; echo '{"continue":true}'`;
}

const HOOKS_CONFIG = {
  hooks: {
    PostToolUse: [{
      matcher: '',
      hooks: [{
        type: 'command',
        command: makeWalkUpCommand('save-hook.js'),
        timeout: 10,
      }],
    }],
    Stop: [{
      matcher: '',
      hooks: [{
        type: 'command',
        command: makeWalkUpCommand('summary-hook.js'),
        timeout: 30,
      }],
    }],
    SessionStart: [{
      matcher: '',
      hooks: [{
        type: 'command',
        command: makeWalkUpCommand('context-hook.js'),
        timeout: 15,
      }],
    }],
  },
};

// ─── CLAUDE.md section ──────────────────────────────────────────────────────

const CLAUDE_MD_SECTION = `
## Team Memory (repo-mem)

This project uses \`repo-mem\` — a shared knowledge management system stored in the repo. Each collaborator has their own SQLite database, but all can search across all databases.

### Workflow

**Before working — search existing knowledge:**
\`\`\`
search({query: "exit detection bug"})
\`\`\`
Returns a compact index (~50 tokens per entry). Use \`get\` for full details.

**Fetch details for relevant entries:**
\`\`\`
get({id: 123, user: "user@email.com"})
get_batch({ids: [{id: 1, user: "a@b.com"}, {id: 2, user: "c@d.com"}]})
\`\`\`

**After important work — save knowledge:**
\`\`\`
save({
  type: "bugfix",        // bugfix | feature | discovery | decision | refactor | change
  title: "Fix race condition in auth flow",
  narrative: "Detailed explanation with root cause, fix, and lessons learned",
  facts: ["Fact 1", "Fact 2"],
  files_modified: ["src/auth.js"]
})
\`\`\`

### Available MCP Tools
| Tool | Purpose |
|------|---------|
| \`search\` | Search across all user databases |
| \`get\` | Load a single observation (full detail) |
| \`get_batch\` | Load multiple observations efficiently |
| \`timeline\` | Chronological view around a point in time |
| \`save\` | Save a new observation |
| \`save_summary\` | Save a session summary |
| \`team_activity\` | See what other collaborators did recently |
| \`help\` | Show documentation |
`;

// ─── Commands ───────────────────────────────────────────────────────────────

function cmdInit() {
  const gitRoot = getGitRoot();
  if (!gitRoot) {
    logError('Not inside a git repository.\n  Run this command from inside a git repo, or run "git init" first.');
    process.exit(1);
  }

  const repoMemDir = join(gitRoot, '.repo-mem');
  const results = { succeeded: [], failed: [] };

  // ── Step 1: Create .repo-mem/ directory and copy templates ──────────────

  try {
    mkdirSync(repoMemDir, { recursive: true });
    mkdirSync(join(repoMemDir, 'hooks'), { recursive: true });
    mkdirSync(join(repoMemDir, 'data'), { recursive: true });

    // Copy template files
    for (const file of TEMPLATE_FILES) {
      const src = join(TEMPLATES_DIR, file);
      const dest = join(repoMemDir, file);
      if (!existsSync(src)) {
        results.failed.push(`Template not found: templates/${file}`);
        continue;
      }
      copyFileSync(src, dest);
    }

    // Copy hook files
    for (const file of HOOK_FILES) {
      const src = join(TEMPLATES_DIR, file);
      const dest = join(repoMemDir, file);
      if (!existsSync(src)) {
        results.failed.push(`Template not found: templates/${file}`);
        continue;
      }
      copyFileSync(src, dest);
    }

    // Create data/.gitkeep
    const gitkeep = join(repoMemDir, 'data', '.gitkeep');
    if (!existsSync(gitkeep)) {
      writeFileSync(gitkeep, '', 'utf-8');
    }

    results.succeeded.push('.repo-mem/ created with templates');
  } catch (err) {
    results.failed.push(`.repo-mem/ creation failed: ${err.message}`);
  }

  // ── Step 2: npm install ─────────────────────────────────────────────────

  try {
    log('\u2699\uFE0F ', 'Installing dependencies...');
    execSync('npm install --silent', {
      cwd: repoMemDir,
      timeout: 120000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    results.succeeded.push('Dependencies installed');
  } catch (err) {
    results.failed.push(`npm install failed: ${err.message}`);
  }

  // ── Step 3: Configure .mcp.json ─────────────────────────────────────────

  try {
    const mcpPath = join(gitRoot, '.mcp.json');
    let mcpConfig = readJSON(mcpPath) || {};

    if (!mcpConfig.mcpServers) mcpConfig.mcpServers = {};
    mcpConfig.mcpServers['repo-mem'] = MCP_CONFIG.mcpServers['repo-mem'];

    writeJSON(mcpPath, mcpConfig);
    results.succeeded.push('MCP server configured in .mcp.json');
  } catch (err) {
    results.failed.push(`.mcp.json configuration failed: ${err.message}`);
  }

  // ── Step 4: Configure .claude/settings.json ─────────────────────────────

  try {
    const claudeDir = join(gitRoot, '.claude');
    mkdirSync(claudeDir, { recursive: true });

    const settingsPath = join(claudeDir, 'settings.json');
    let settings = readJSON(settingsPath) || {};

    settings = deepMergeHooks(settings, HOOKS_CONFIG);

    writeJSON(settingsPath, settings);
    results.succeeded.push('Hooks configured in .claude/settings.json');
  } catch (err) {
    results.failed.push(`Hooks configuration failed: ${err.message}`);
  }

  // ── Step 5: Update root .gitignore ──────────────────────────────────────

  try {
    const gitignorePath = join(gitRoot, '.gitignore');
    const entry = '.repo-mem/node_modules/';
    let content = '';

    if (existsSync(gitignorePath)) {
      content = readFileSync(gitignorePath, 'utf-8');
    }

    if (!content.includes(entry)) {
      const separator = content.length > 0 && !content.endsWith('\n') ? '\n' : '';
      appendFileSync(gitignorePath, `${separator}\n# repo-mem\n${entry}\n`, 'utf-8');
    }

    results.succeeded.push('.gitignore updated');
  } catch (err) {
    results.failed.push(`.gitignore update failed: ${err.message}`);
  }

  // ── Step 6: Add CLAUDE.md instructions ──────────────────────────────────

  try {
    const claudeMdPath = join(gitRoot, 'CLAUDE.md');

    if (existsSync(claudeMdPath)) {
      const content = readFileSync(claudeMdPath, 'utf-8');
      if (!content.includes('## Team Memory (repo-mem)')) {
        const separator = content.endsWith('\n') ? '' : '\n';
        appendFileSync(claudeMdPath, `${separator}${CLAUDE_MD_SECTION}`, 'utf-8');
        results.succeeded.push('CLAUDE.md updated with repo-mem section');
      } else {
        results.succeeded.push('CLAUDE.md already has repo-mem section');
      }
    } else {
      writeFileSync(claudeMdPath, `# CLAUDE.md\n${CLAUDE_MD_SECTION}`, 'utf-8');
      results.succeeded.push('CLAUDE.md created with repo-mem section');
    }
  } catch (err) {
    results.failed.push(`CLAUDE.md update failed: ${err.message}`);
  }

  // ── Print results ───────────────────────────────────────────────────────

  console.log('');

  if (results.failed.length === 0) {
    log('\u2705', 'repo-mem initialized');
  } else {
    log('\u26A0\uFE0F ', 'repo-mem partially initialized');
  }

  for (const msg of results.succeeded) {
    log('\u2705', msg);
  }

  for (const msg of results.failed) {
    log('\u274C', msg);
  }

  console.log('');
  log('\uD83D\uDCA1', 'Restart Claude Code to activate');
  log('\uD83D\uDCD6', 'See CLAUDE.md for usage instructions');
  console.log('');
}

function cmdStatus() {
  const gitRoot = getGitRoot();
  if (!gitRoot) {
    logError('Not inside a git repository.');
    process.exit(1);
  }

  const repoMemDir = join(gitRoot, '.repo-mem');

  console.log('');
  console.log('  repo-mem status');
  console.log('  ' + '\u2500'.repeat(40));

  // Check if initialized
  if (!existsSync(repoMemDir)) {
    log('  \u274C', 'Not initialized. Run "npx repo-mem init" to set up.');
    console.log('');
    return;
  }

  log('  \u2705', `Initialized at ${repoMemDir}`);

  // Check server.js exists
  const serverExists = existsSync(join(repoMemDir, 'server.js'));
  log(serverExists ? '  \u2705' : '  \u274C', `server.js ${serverExists ? 'present' : 'missing'}`);

  // Check node_modules
  const depsInstalled = existsSync(join(repoMemDir, 'node_modules', 'better-sqlite3'));
  log(depsInstalled ? '  \u2705' : '  \u274C', `Dependencies ${depsInstalled ? 'installed' : 'not installed'}`);

  // Check .mcp.json
  const mcpPath = join(gitRoot, '.mcp.json');
  const mcpConfig = readJSON(mcpPath);
  const mcpConfigured = mcpConfig?.mcpServers?.['repo-mem'] != null;
  log(mcpConfigured ? '  \u2705' : '  \u274C', `MCP config ${mcpConfigured ? 'present' : 'missing'} in .mcp.json`);

  // Check hooks
  const settingsPath = join(gitRoot, '.claude', 'settings.json');
  const settings = readJSON(settingsPath);
  const hooksConfigured = settings?.hooks?.PostToolUse != null;
  log(hooksConfigured ? '  \u2705' : '  \u274C', `Hooks ${hooksConfigured ? 'configured' : 'not configured'} in .claude/settings.json`);

  // Count databases and observations
  const dataDir = join(repoMemDir, 'data');
  if (existsSync(dataDir)) {
    try {
      const files = readdirSync(dataDir).filter(f => f.endsWith('.db'));

      if (files.length === 0) {
        log('  \u2139\uFE0F ', 'No user databases yet (observations will appear after first use)');
      } else {
        log('  \uD83D\uDCCA', `${files.length} user database${files.length === 1 ? '' : 's'}:`);

        for (const file of files) {
          const user = file.replace('.db', '');
          let count = '?';
          try {
            // Try to count observations using sqlite3 CLI
            const result = execSync(
              `sqlite3 "${join(dataDir, file)}" "SELECT COUNT(*) FROM observations;" 2>/dev/null`,
              { encoding: 'utf-8', timeout: 5000 }
            ).trim();
            count = result;
          } catch {
            // sqlite3 CLI not available or DB locked, that's fine
          }
          log('     ', `${user} (${count} observations)`);
        }
      }
    } catch {
      // readdirSync might fail
    }
  }

  console.log('');
}

function cmdHelp() {
  console.log(`
  repo-mem - Team Memory for Git repositories

  USAGE
    npx repo-mem <command>

  COMMANDS
    init      Initialize repo-mem in the current git repository
    status    Show current repo-mem status and statistics
    help      Show this help message

  WHAT IT DOES
    repo-mem adds a shared knowledge base to your repo that works with
    Claude Code. Team members' bug fixes, architecture decisions, and
    discoveries are automatically captured and searchable across sessions.

  AFTER INIT
    1. Restart Claude Code to activate the MCP server and hooks
    2. Claude will automatically search existing knowledge before working
    3. Important findings are saved automatically via hooks
    4. Use "save" tool for structured, high-value observations

  MORE INFO
    https://github.com/AuronTM/repo-mem
`);
}

// ─── Main ───────────────────────────────────────────────────────────────────

const command = process.argv[2];

switch (command) {
  case 'init':
    cmdInit();
    break;
  case 'status':
    cmdStatus();
    break;
  case 'help':
  case '--help':
  case '-h':
    cmdHelp();
    break;
  case undefined:
    cmdHelp();
    break;
  default:
    logError(`Unknown command: ${command}`);
    cmdHelp();
    process.exit(1);
}
