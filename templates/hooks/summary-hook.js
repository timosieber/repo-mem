#!/usr/bin/env node

/**
 * repo-mem Stop Hook
 *
 * Called at the end of a Claude Code session.
 * Uses Haiku via `claude` CLI to generate a meaningful session summary.
 *
 * Input (stdin JSON):
 *   { session_id, cwd, transcript_path }
 *
 * Output (stdout JSON):
 *   { continue: true, suppressOutput: true }
 */

import { createRequire } from 'module';
import { execSync, fork } from 'child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
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
    console.log(JSON.stringify({ continue: true, suppressOutput: true }));
    process.exit(0);
  }
}

function respond() {
  console.log(JSON.stringify({ continue: true, suppressOutput: true }));
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

function getChangedFiles(cwd) {
  try {
    const diff = execSync('git diff --name-only HEAD 2>/dev/null || git diff --name-only --cached 2>/dev/null || true', {
      encoding: 'utf-8', timeout: 5000, cwd: cwd || process.cwd()
    }).trim();
    if (!diff) return [];
    return [...new Set(diff.split('\n').filter(Boolean))].slice(0, 50);
  } catch {
    return [];
  }
}

/**
 * Extract all user+assistant text messages from transcript (JSONL).
 * Returns compressed conversation for Haiku input.
 * Max ~6000 chars to stay within reasonable token limits.
 */
function extractTranscript(transcriptPath) {
  if (!transcriptPath || !existsSync(transcriptPath)) return null;

  try {
    const content = readFileSync(transcriptPath, 'utf-8').trim();
    if (!content) return null;

    const cleanTags = s => s
      .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
      .replace(/<function_calls>[\s\S]*?<\/antml:function_calls>/g, '[tool call]')
      .trim();

    const messages = [];
    for (const line of content.split('\n')) {
      try {
        const entry = JSON.parse(line);
        if (!entry.message?.content) continue;

        const role = entry.type; // 'user' or 'assistant'
        if (role !== 'user' && role !== 'assistant') continue;

        const msgContent = entry.message.content;
        let text = '';
        if (typeof msgContent === 'string') {
          text = msgContent;
        } else if (Array.isArray(msgContent)) {
          text = msgContent.filter(c => c.type === 'text').map(c => c.text).join('\n');
        }

        text = cleanTags(text).trim();
        if (!text || text.length < 3) continue;

        messages.push(`[${role.toUpperCase()}]: ${text.substring(0, 800)}`);
      } catch { continue; }
    }

    if (!messages.length) return null;

    // Join and cap at ~6000 chars — keep start (task) and end (result)
    const full = messages.join('\n\n');
    if (full.length <= 6000) return full;

    // Keep first 2000 (context/task) + last 4000 (results)
    const start = full.substring(0, 2000);
    const end = full.substring(full.length - 4000);
    return `${start}\n\n[... middle truncated ...]\n\n${end}`;
  } catch {
    return null;
  }
}

/**
 * Call Haiku via `claude` CLI to summarize the session.
 * Returns parsed JSON or null on failure.
 */
function callHaiku(transcript) {
  const prompt = `You are summarizing a Claude Code development session for a team knowledge base.

Analyze this conversation and return a JSON object (no markdown, raw JSON only) with these fields:
- "title": Short descriptive title of what was done (max 80 chars, e.g. "V163: Fix iOS midnight reset bug")
- "request": What the user asked for (1-2 sentences, max 150 chars)
- "completed": What was actually done/fixed (2-4 sentences, technical detail)
- "learned": Key technical insights, root causes, or gotchas discovered (null if none)
- "next_steps": Any mentioned follow-up work (null if none)
- "type": One of: bugfix, feature, refactor, discovery, decision, change

CONVERSATION:
${transcript}

Return only valid JSON, no explanation.`;

  try {
    // Escape for shell — use stdin via echo pipe to avoid arg length limits
    const escaped = prompt.replace(/'/g, `'\\''`);
    const result = execSync(
      `echo '${escaped}' | claude -p --model claude-haiku-4-5-20251001`,
      { encoding: 'utf-8', timeout: 30000 }
    ).trim();

    // Strip markdown code fences if present
    const cleaned = result.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();
    return JSON.parse(cleaned);
  } catch {
    return null;
  }
}

/**
 * Fallback: rule-based summary if Haiku call fails.
 */
function fallbackSummary(transcriptPath) {
  if (!transcriptPath || !existsSync(transcriptPath)) return { request: null, completed: null };

  try {
    const content = readFileSync(transcriptPath, 'utf-8').trim();
    const lines = content.split('\n');
    const cleanTags = s => s.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();

    let firstUser = null;
    let lastAssistant = null;

    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if (!firstUser && entry.type === 'user' && entry.message?.content) {
          const c = entry.message.content;
          firstUser = typeof c === 'string' ? c : (Array.isArray(c) ? c.filter(x => x.type === 'text').map(x => x.text).join('\n') : '');
        }
        if (entry.type === 'assistant' && entry.message?.content) {
          const c = entry.message.content;
          lastAssistant = typeof c === 'string' ? c : (Array.isArray(c) ? c.filter(x => x.type === 'text').map(x => x.text).join('\n') : '');
        }
      } catch { continue; }
    }

    return {
      request: firstUser ? cleanTags(firstUser).substring(0, 200) : null,
      completed: lastAssistant ? cleanTags(lastAssistant).substring(0, 300) : null,
    };
  } catch {
    return { request: null, completed: null };
  }
}

/**
 * Background worker entry point.
 * Called via fork() with --background flag + JSON payload file.
 * Runs Haiku summarization + DB writes without blocking session end.
 */
async function backgroundWorker() {
  const payloadPath = process.argv[3];
  if (!payloadPath || !existsSync(payloadPath)) process.exit(0);

  let payload;
  try {
    payload = JSON.parse(readFileSync(payloadPath, 'utf-8'));
  } catch { process.exit(0); }

  // Clean up payload file
  try { require('fs').unlinkSync(payloadPath); } catch {}

  const { session_id, transcript_path, user, project, changedFiles, nowISO, nowEpoch } = payload;

  try {
    // Try Haiku summarization, fall back to rule-based
    const transcript = extractTranscript(transcript_path);
    let summary = null;
    if (transcript) {
      summary = callHaiku(transcript);
    }

    let title, request, completed, learned, next_steps, obsType;
    if (summary) {
      title = summary.title || 'Session summary';
      request = summary.request || null;
      completed = summary.completed || null;
      learned = summary.learned || null;
      next_steps = summary.next_steps || null;
      obsType = summary.type || 'change';
    } else {
      const fb = fallbackSummary(transcript_path);
      title = 'Session summary';
      request = fb.request;
      completed = fb.completed;
      learned = null;
      next_steps = null;
      obsType = 'change';
    }

    const { openDb, initDb } = await import('../lib/schema-manager.js');
    const dataDir = join(REPO_MEM_ROOT, 'data');
    mkdirSync(dataDir, { recursive: true });

    const dbPath = join(dataDir, `${user}.db`);
    const db = openDb(dbPath);
    initDb(db);

    // Update session status
    try {
      db.prepare(`
        UPDATE sessions SET status = 'completed', completed_at = ?, completed_at_epoch = ?
        WHERE claude_session_id = ?
      `).run(nowISO, nowEpoch, session_id);
    } catch { /* session may not exist */ }

    // Insert summary
    db.prepare(`
      INSERT INTO session_summaries (session_id, user, project, request, investigated, learned, completed, next_steps, files_read, files_edited, notes, discovery_tokens, created_at, created_at_epoch)
      VALUES (@session_id, @user, @project, @request, @investigated, @learned, @completed, @next_steps, @files_read, @files_edited, @notes, @discovery_tokens, @created_at, @created_at_epoch)
    `).run({
      session_id: session_id || null,
      user,
      project,
      request,
      investigated: null,
      learned,
      completed,
      next_steps,
      files_read: null,
      files_edited: changedFiles.length ? JSON.stringify(changedFiles) : null,
      notes: title,
      discovery_tokens: Math.ceil(((request?.length || 0) + (completed?.length || 0) + (learned?.length || 0)) / 4),
      created_at: nowISO,
      created_at_epoch: nowEpoch
    });

    // Also save as observation so it's searchable
    if (title && title !== 'Session summary') {
      db.prepare(`
        INSERT INTO observations (session_id, user, project, text, type, title, narrative, facts, files_modified, discovery_tokens, created_at, created_at_epoch)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        session_id || null,
        user,
        project,
        `${title}. ${completed || ''}`.trim(),
        obsType,
        title,
        [request, completed, learned].filter(Boolean).join('\n\n'),
        next_steps ? JSON.stringify([next_steps]) : null,
        changedFiles.length ? JSON.stringify(changedFiles) : null,
        Math.ceil((title.length + (completed?.length || 0)) / 4),
        nowISO,
        nowEpoch
      );
    }

    // Backfill missing embeddings for this session's observations
    try {
      const unembedded = db.prepare(
        "SELECT id, title, subtitle, narrative FROM observations WHERE embedding IS NULL AND session_id = ?"
      ).all(session_id);

      if (unembedded.length > 0) {
        const { pipeline } = await import('@xenova/transformers');
        const embedder = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', {
          cache_dir: join(REPO_MEM_ROOT, '.model-cache'),
        });

        let count = 0;
        for (const obs of unembedded) {
          const text = [obs.title, obs.subtitle, obs.narrative].filter(Boolean).join(' ');
          if (!text.trim()) continue;
          const result = await embedder(text, { pooling: 'mean', normalize: true });
          const buffer = Buffer.from(result.data.buffer);
          db.prepare('UPDATE observations SET embedding = ? WHERE id = ?').run(buffer, obs.id);
          count++;
        }
        if (count > 0) {
          console.error(`[repo-mem] Backfilled ${count} embeddings for session.`);
        }
      }
    } catch (err) {
      console.error('[repo-mem] Embedding backfill failed:', err.message);
    }

    // Phase 2: Pattern recompute
    try {
      const { fullRecompute } = await import('../lib/pattern-engine.js');

      // cosineSimilarity needs to be available locally (not exported from server.js)
      function cosineSimilarity(bufA, bufB) {
        if (!bufA || !bufB || bufA.length !== bufB.length) return 0;
        const a = new Float32Array(bufA.buffer, bufA.byteOffset, bufA.byteLength / 4);
        const b = new Float32Array(bufB.buffer, bufB.byteOffset, bufB.byteLength / 4);
        let dot = 0;
        for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
        return dot;
      }

      const result = fullRecompute(db, cosineSimilarity);
      if (result.assigned > 0 || result.newPatterns > 0) {
        console.error(`[repo-mem] Pattern recompute: ${result.assigned} assigned, ${result.newPatterns} new patterns`);
      }
    } catch (err) {
      console.error('[repo-mem] Pattern recompute failed:', err.message);
    }

    db.close();
  } catch {
    // Silent failure — never leave zombie processes
  }

  process.exit(0);
}

// If launched as background worker, run worker logic
if (process.argv[2] === '--background') {
  backgroundWorker();
} else {
  // Main hook entry point — respond immediately, fork background worker
  (async () => {
    let raw = '';
    for await (const chunk of process.stdin) raw += chunk;

    if (!raw.trim()) { respond(); return; }

    let input;
    try { input = JSON.parse(raw); } catch { respond(); return; }

    // Respond IMMEDIATELY so Claude Code session ends without delay
    respond();

    const { session_id, cwd, transcript_path } = input;

    try {
      const user = getUser();
      const project = getProject(cwd);
      const now = new Date();
      const changedFiles = getChangedFiles(cwd);

      // Write payload to temp file for the background worker
      const tmpDir = join(REPO_MEM_ROOT, 'data');
      mkdirSync(tmpDir, { recursive: true });
      const payloadPath = join(tmpDir, `.summary-payload-${Date.now()}.json`);
      writeFileSync(payloadPath, JSON.stringify({
        session_id, transcript_path, user, project, changedFiles,
        nowISO: now.toISOString(), nowEpoch: Math.floor(now.getTime() / 1000)
      }));

      // Fork detached background worker
      const child = fork(fileURLToPath(import.meta.url), ['--background', payloadPath], {
        detached: true,
        stdio: 'ignore',
        cwd: cwd || process.cwd()
      });
      child.unref();
    } catch {
      // Never block session end
    }
  })();
}
