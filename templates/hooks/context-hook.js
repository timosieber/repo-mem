#!/usr/bin/env node

/**
 * repo-mem SessionStart Hook
 *
 * Injects minimal team context at session start. Designed for token efficiency:
 * - Only shows a brief activity summary (not full observation details)
 * - Points Claude to the `search` MCP tool for detailed knowledge
 * - Keeps injection under ~200 tokens total
 *
 * Input (stdin JSON):
 *   { session_id, cwd }
 *
 * Output (stdout JSON):
 *   { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "..." } }
 */

import { createRequire } from 'module';
import { execSync } from 'child_process';
import { existsSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_MEM_ROOT = join(__dirname, '..');
const require = createRequire(import.meta.url);

// Auto-install dependencies if missing
if (!existsSync(join(REPO_MEM_ROOT, 'node_modules', 'better-sqlite3'))) {
  try {
    execSync('npm install --silent', { cwd: REPO_MEM_ROOT, timeout: 30000, stdio: 'ignore' });
  } catch {
    console.log(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: '# [repo-mem] Installing dependencies... restart session to load context.'
      }
    }));
    process.exit(0);
  }
}

function emit(text) {
  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: text
    }
  }));
}

function getUser() {
  try {
    return execSync('git config user.email', { encoding: 'utf-8', timeout: 2000 }).trim() || 'unknown';
  } catch {
    return 'unknown';
  }
}

function shortUser(email) {
  return email.split('@')[0] || email;
}

function findSimilarByFTS(recentTitles, dbFiles, Database, dataDir) {
  const STOP_WORDS = new Set([
    'der','die','das','ein','eine','ist','und','oder','nicht',
    'the','is','are','and','or','not','fix','bug','please',
    'kann','wie','was','wir','ich','hat','haben','mach','zeig',
  ]);
  const words = recentTitles.join(' ')
    .split(/[\s,.!?:;()\[\]{}]+/)
    .filter(w => w.length > 3 && !STOP_WORDS.has(w.toLowerCase()))
    .slice(0, 6);
  if (words.length === 0) return [];

  const ftsQuery = words.map(w => `"${w}"`).join(' OR ');
  const results = [];

  for (const file of dbFiles) {
    try {
      const db = new Database(join(dataDir, file), { readonly: true });
      db.pragma('journal_mode = WAL');
      const user = file.replace('.db', '');

      const rows = db.prepare(`
        SELECT o.id, o.title, o.type, rank
        FROM observations_fts fts
        JOIN observations o ON o.id = fts.rowid
        WHERE observations_fts MATCH ?
        AND o.type IN ('bugfix', 'feature', 'decision', 'discovery')
        ORDER BY rank
        LIMIT 5
      `).all(ftsQuery);

      for (const r of rows) {
        results.push({ id: r.id, title: r.title, type: r.type, user, _rank: r.rank });
      }
      db.close();
    } catch { /* skip broken/locked DBs */ }
  }

  results.sort((a, b) => a._rank - b._rank);
  return results.slice(0, 3);
}

async function main() {
  // Consume stdin (required by hook protocol)
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;

  try {
    const Database = require('better-sqlite3');
    const dataDir = join(REPO_MEM_ROOT, 'data');

    if (!existsSync(dataDir)) {
      emit('# [repo-mem] Ready. No observations yet.');
      return;
    }

    const dbFiles = readdirSync(dataDir).filter(f =>
      f.endsWith('.db') && !f.includes('-wal') && !f.includes('-shm') && !f.includes('-journal')
    );

    if (dbFiles.length === 0) {
      emit('# [repo-mem] Ready. No observations yet.');
      return;
    }

    const currentUser = getUser();
    const cutoff24h = Math.floor(Date.now() / 1000) - (24 * 60 * 60);

    // Collect stats + last 5 high-signal events per user
    const userStats = [];
    let totalObs = 0;
    let lastSummaryRequest = null;
    const recentEvents = []; // max 5 across all users

    for (const file of dbFiles) {
      const user = file.replace('.db', '');
      try {
        const db = new Database(join(dataDir, file), { readonly: true });
        db.pragma('journal_mode = WAL');

        // Count recent observations (last 24h)
        let recentCount = 0;
        try {
          const row = db.prepare(
            'SELECT COUNT(*) as cnt FROM observations WHERE created_at_epoch > ?'
          ).get(cutoff24h);
          recentCount = row?.cnt || 0;
        } catch { /* table might not exist */ }

        // Total count
        let total = 0;
        try {
          const row = db.prepare('SELECT COUNT(*) as cnt FROM observations').get();
          total = row?.cnt || 0;
        } catch { /* */ }

        // Get last 5 non-edit observations (high-signal: commits, deploys, manual saves)
        try {
          const rows = db.prepare(`
            SELECT id, type, title, created_at_epoch
            FROM observations
            WHERE created_at_epoch > ? AND type != 'change'
            ORDER BY created_at_epoch DESC LIMIT 5
          `).all(cutoff24h);
          for (const r of rows) recentEvents.push({ ...r, user: shortUser(user) });
        } catch { /* */ }

        // If no non-change events, get last 3 of any type
        if (recentEvents.filter(e => e.user === shortUser(user)).length === 0) {
          try {
            const rows = db.prepare(`
              SELECT id, type, title, created_at_epoch
              FROM observations
              WHERE created_at_epoch > ?
              ORDER BY created_at_epoch DESC LIMIT 3
            `).all(cutoff24h);
            for (const r of rows) recentEvents.push({ ...r, user: shortUser(user) });
          } catch { /* */ }
        }

        // Get last summary for current user only
        if (user === currentUser || user === shortUser(currentUser)) {
          try {
            const summary = db.prepare(
              'SELECT request FROM session_summaries ORDER BY created_at_epoch DESC LIMIT 1'
            ).get();
            if (summary) lastSummaryRequest = summary.request;
          } catch { /* */ }
        }

        db.close();

        totalObs += total;
        if (recentCount > 0 || total > 0) {
          userStats.push({ user: shortUser(user), recent: recentCount, total });
        }
      } catch { /* skip broken DBs */ }
    }

    // Sort events by time, keep top 5
    recentEvents.sort((a, b) => b.created_at_epoch - a.created_at_epoch);
    const topEvents = recentEvents.slice(0, 5);

    // Build compact but visible context (~200-400 tokens)
    let ctx = '# [repo-mem] Team Memory Active\n\n';
    ctx += `${userStats.length} contributor${userStats.length === 1 ? '' : 's'}, ${totalObs} total observations.\n`;

    // One-line per user with recent activity
    const activeUsers = userStats.filter(u => u.recent > 0);
    if (activeUsers.length > 0) {
      ctx += 'Recent (24h): ' + activeUsers.map(u => `${u.user} (${u.recent})`).join(', ') + '\n';
    }

    // Last session summary
    if (lastSummaryRequest) {
      ctx += `\nLast session: ${lastSummaryRequest.substring(0, 120)}\n`;
    }

    // Mini table of recent high-signal events (max 5 rows)
    if (topEvents.length > 0) {
      ctx += '\n## Recent\n';
      for (const e of topEvents) {
        const time = new Date(e.created_at_epoch * 1000).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
        ctx += `- ${time} ${e.user}: ${e.title || '(untitled)'}\n`;
      }
    }

    // Proactive similarity: find related observations based on recent event titles
    const recentTitles = topEvents.map(e => e.title || '').filter(Boolean);
    const similar = findSimilarByFTS(recentTitles, dbFiles, Database, dataDir);

    if (similar.length > 0) {
      const emoji = { bugfix: '\u{1F534}', feature: '\u{1F7E3}', decision: '\u2696\uFE0F', discovery: '\u{1F535}' };
      ctx += '\n## Possibly Related\n';
      for (const s of similar) {
        ctx += `- ${emoji[s.type] || '\u2705'} #${s.id} (${s.user}): ${s.title} → \`get({id: ${s.id}, user: "${s.user}"})\`\n`;
      }
      ctx += '_Keyword matches. Use `search` for semantic similarity._\n';
    }

    // Smart routing suggestion based on recent titles
    try {
      const { keywordRoute } = await import('../lib/agent-router.js');
      const routingText = [lastSummaryRequest, ...recentTitles].filter(Boolean).join(' ');
      const route = keywordRoute(routingText);
      if (route && route.confidence !== 'low') {
        ctx += `\n## Routing Suggestion\nRecommended agent: **${route.agent}** (${route.confidence})\n`;
      }
    } catch { /* non-blocking */ }

    ctx += '\nUse `search` from repo-mem MCP to find past knowledge before starting work.\n';

    emit(ctx);
  } catch {
    emit('# [repo-mem] Context loading failed (non-critical).');
  }
}

main();
