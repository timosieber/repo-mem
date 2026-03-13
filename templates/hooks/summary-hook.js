#!/usr/bin/env node

/**
 * repo-mem Stop Hook
 *
 * Called at the end of a Claude Code session.
 * Creates a concise session summary with:
 * - What the user requested (from transcript)
 * - What was completed (from transcript)
 * - Which files were edited (from git diff, not individual observations)
 *
 * This is the ONLY place file edits are recorded — the save-hook
 * deliberately skips individual Edit/Write calls to avoid DB bloat.
 *
 * No AI calls — purely rule-based extraction.
 *
 * Input (stdin JSON):
 *   { session_id, cwd, transcript_path }
 *
 * Output (stdout JSON):
 *   { continue: true, suppressOutput: true }
 */

import { createRequire } from 'module';
import { execSync } from 'child_process';
import { existsSync, mkdirSync, readFileSync } from 'fs';
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

/**
 * Get files changed since session start via git.
 * Much more reliable than tracking individual Edit calls.
 */
function getChangedFiles(cwd) {
  try {
    // Staged + unstaged changes
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
 * Extract the last message of a given role from a transcript file.
 * Transcript is JSONL — one JSON object per line.
 */
function extractLastMessage(transcriptPath, role) {
  if (!transcriptPath || !existsSync(transcriptPath)) return '';
  try {
    const content = readFileSync(transcriptPath, 'utf-8').trim();
    if (!content) return '';

    const lines = content.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const entry = JSON.parse(lines[i]);
        if (entry.type === role && entry.message?.content) {
          const msgContent = entry.message.content;
          if (typeof msgContent === 'string') return msgContent;
          if (Array.isArray(msgContent)) {
            return msgContent
              .filter(c => c.type === 'text')
              .map(c => c.text)
              .join('\n');
          }
        }
      } catch { continue; }
    }
  } catch { /* silent */ }
  return '';
}

/**
 * Build a rule-based session summary from transcript.
 */
function buildSummary(userMessage, assistantMessage) {
  const cleanTags = s => s.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();

  const request = userMessage
    ? cleanTags(userMessage).substring(0, 200)
    : null;

  let completed = null;
  if (assistantMessage) {
    const cleaned = cleanTags(assistantMessage);
    // Take first meaningful paragraph (skip code blocks)
    const paragraphs = cleaned.split(/\n\n+/).filter(p => !p.startsWith('```'));
    completed = (paragraphs[0] || cleaned).substring(0, 300);
  }

  return { request, completed };
}

async function main() {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;

  if (!raw.trim()) { respond(); return; }

  let input;
  try { input = JSON.parse(raw); } catch { respond(); return; }

  const { session_id, cwd, transcript_path } = input;

  try {
    const user = getUser();
    const project = getProject(cwd);
    const now = new Date();

    const userMessage = extractLastMessage(transcript_path, 'user');
    const assistantMessage = extractLastMessage(transcript_path, 'assistant');
    const { request, completed } = buildSummary(userMessage, assistantMessage);

    // Get changed files from git (replaces per-edit tracking)
    const changedFiles = getChangedFiles(cwd);

    const Database = require('better-sqlite3');
    const dataDir = join(REPO_MEM_ROOT, 'data');
    mkdirSync(dataDir, { recursive: true });

    const dbPath = join(dataDir, `${user}.db`);
    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');

    const schemaPath = join(REPO_MEM_ROOT, 'schema.sql');
    if (existsSync(schemaPath)) {
      db.exec(readFileSync(schemaPath, 'utf-8'));
    }

    // Update session status
    try {
      db.prepare(`
        UPDATE sessions SET status = 'completed', completed_at = ?, completed_at_epoch = ?
        WHERE claude_session_id = ?
      `).run(now.toISOString(), now.getTime(), session_id);
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
      learned: null,
      completed,
      next_steps: null,
      files_read: null,
      files_edited: changedFiles.length ? JSON.stringify(changedFiles) : null,
      notes: null,
      discovery_tokens: Math.ceil(((request?.length || 0) + (completed?.length || 0)) / 4),
      created_at: now.toISOString(),
      created_at_epoch: now.getTime()
    });

    db.close();
  } catch {
    // Never block session end
  }

  respond();
}

main();
