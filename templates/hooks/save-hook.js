#!/usr/bin/env node

/**
 * repo-mem PostToolUse Hook
 *
 * Called after every tool use. Filters for high-signal events only:
 * - Git commits (captures commit message)
 * - Deploys
 * - Test runs
 *
 * File edits are NOT recorded individually. Instead, they are batched
 * by the summary-hook at session end (files_edited list). This prevents
 * DB bloat from "Edit foo.js" x50 low-value observations.
 *
 * Input (stdin JSON):
 *   { session_id, cwd, tool_name, tool_input, tool_response }
 *
 * Output (stdout JSON):
 *   { continue: true, suppressOutput: true }
 *
 * MUST be fast (<50ms for skipped tools). No AI calls.
 */

import { createRequire } from 'module';
import { execSync } from 'child_process';
import { existsSync, mkdirSync } from 'fs';
import { join, dirname, basename } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_MEM_ROOT = join(__dirname, '..');
const require = createRequire(import.meta.url);

// Auto-install dependencies if missing
if (!existsSync(join(REPO_MEM_ROOT, 'node_modules', 'better-sqlite3'))) {
  try {
    execSync('npm install --silent', { cwd: REPO_MEM_ROOT, timeout: 30000, stdio: 'ignore' });
  } catch {
    console.log(JSON.stringify({ continue: true, suppressOutput: true }));
    process.exit(0);
  }
}

function respond() {
  console.log(JSON.stringify({ continue: true, suppressOutput: true }));
}

/**
 * Only record HIGH-SIGNAL events. Skip everything else.
 * File edits are captured in bulk at session end by summary-hook.
 */
function isHighSignal(toolName, toolInput) {
  if (toolName === 'Bash') {
    const cmd = toolInput?.command || '';
    if (cmd.includes('git commit')) return 'commit';
    if (cmd.includes('git push')) return 'push';
    if (cmd.includes('git merge')) return 'merge';
    if (/\b(npm|yarn|pnpm)\s+test\b/.test(cmd)) return 'test';
    if (/\b(deploy|supabase\s+functions\s+deploy)\b/.test(cmd)) return 'deploy';
    if (/\b(migrate|migration)\b/i.test(cmd)) return 'migration';
    return null;
  }

  // MCP tools that write to external systems (skip read-only queries)
  if (toolName.startsWith('mcp__supabase__')) {
    if (/apply_migration|deploy_edge_function/.test(toolName)) return 'supabase';
    if (toolName === 'mcp__supabase__execute_sql') {
      const sql = (toolInput?.query || '').trim().toUpperCase();
      // Only capture write operations, skip SELECT/WITH/EXPLAIN
      if (/^(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|TRUNCATE)/.test(sql)) return 'supabase';
      return null; // Skip read-only queries
    }
    return null;
  }

  return null;
}

function getUser() {
  try {
    return execSync('git config user.email', { encoding: 'utf-8', timeout: 2000 }).trim() || 'unknown';
  } catch {
    return 'unknown';
  }
}

function getProject(cwd) {
  try {
    const root = execSync('git rev-parse --show-toplevel', {
      encoding: 'utf-8', timeout: 2000, cwd: cwd || process.cwd()
    }).trim();
    return root.split('/').pop() || 'unknown';
  } catch {
    return (cwd || process.cwd()).split('/').pop() || 'unknown';
  }
}

function generateTitle(signal, toolInput) {
  const cmd = toolInput?.command || '';

  switch (signal) {
    case 'commit': {
      // Extract commit message from various formats
      const heredocMatch = cmd.match(/<<'?EOF'?\n([\s\S]*?)\nEOF/);
      if (heredocMatch) return `Commit: ${heredocMatch[1].split('\n')[0].trim().substring(0, 80)}`;
      const mMatch = cmd.match(/-m\s+["']([^"']+)["']/);
      return mMatch ? `Commit: ${mMatch[1].substring(0, 80)}` : 'Git commit';
    }
    case 'push': return 'Git push';
    case 'merge': return 'Git merge';
    case 'test': return 'Run tests';
    case 'deploy': return 'Deploy';
    case 'migration': return 'Run migration';
    case 'supabase': {
      // apply_migration has .name, execute_sql has .query, deploy_edge_function has .name
      const label = toolInput?.name || (toolInput?.query ? toolInput.query.trim().split(/\s+/).slice(0, 6).join(' ') : null) || 'operation';
      return `Supabase: ${label.substring(0, 80)}`;
    }
    default: return cmd.substring(0, 60);
  }
}

async function main() {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;

  if (!raw.trim()) { respond(); return; }

  let input;
  try { input = JSON.parse(raw); } catch { respond(); return; }

  const { session_id, tool_name, tool_input, tool_response } = input;

  // Parse tool_input if string
  let parsedInput = tool_input;
  if (typeof tool_input === 'string') {
    try { parsedInput = JSON.parse(tool_input); } catch { parsedInput = {}; }
  }

  // Fast exit for non-signal events (vast majority)
  const signal = isHighSignal(tool_name, parsedInput);
  if (!signal) { respond(); return; }

  try {
    const user = getUser();
    const project = getProject(input.cwd);
    const now = new Date();
    const title = generateTitle(signal, parsedInput);

    // Build concise narrative
    const cmd = parsedInput?.command || '';
    const resp = typeof tool_response === 'string' ? tool_response : (tool_response ? JSON.stringify(tool_response).substring(0, 200) : '');
    let narrative = cmd.substring(0, 200);
    if (signal === 'commit' && resp) {
      narrative += ` -> ${resp.split('\n')[0].substring(0, 100)}`;
    }
    if (signal === 'test' && resp) {
      // Capture test result summary (last 3 lines)
      const lines = resp.trim().split('\n');
      narrative = lines.slice(-3).join(' | ').substring(0, 300);
    }
    if (signal === 'supabase') {
      // Build narrative from MCP tool input fields
      const parts = [];
      if (parsedInput?.name) parts.push(`name: ${parsedInput.name}`);
      if (parsedInput?.query) parts.push(`sql: ${parsedInput.query.substring(0, 300)}`);
      if (parsedInput?.function_name) parts.push(`function: ${parsedInput.function_name}`);
      narrative = parts.join(' | ').substring(0, 400);
    }

    const { openDb, initDb } = await import('../lib/schema-manager.js');
    const dataDir = join(REPO_MEM_ROOT, 'data');
    mkdirSync(dataDir, { recursive: true });

    const dbPath = join(dataDir, `${user}.db`);
    const db = openDb(dbPath);
    initDb(db);

    db.prepare(`
      INSERT INTO observations (session_id, user, project, text, type, title, narrative, discovery_tokens, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      session_id || null,
      user,
      project,
      title,
      signal === 'test' ? 'discovery' : 'change',
      title,
      narrative,
      Math.ceil((title.length + (narrative?.length || 0)) / 4),
      now.toISOString(),
      Math.floor(now.getTime() / 1000)
    );

    db.close();
  } catch {
    // Never block the session
  }

  respond();
}

main();
