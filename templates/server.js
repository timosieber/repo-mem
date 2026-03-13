#!/usr/bin/env node

/**
 * repo-mem MCP Server
 *
 * A lightweight team memory system that stores observations, session summaries,
 * and knowledge in per-user SQLite databases. Provides full-text search (FTS5)
 * across all team members' databases.
 *
 * Tools: search, get, get_batch, save, save_summary, timeline, team_activity, help
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import Database from 'better-sqlite3';
import { execSync } from 'child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, 'data');

// ── Project Detection ────────────────────────────────────────────────────────

function detectProject() {
  try {
    const toplevel = execSync('git rev-parse --show-toplevel', {
      encoding: 'utf-8',
      timeout: 3000,
    }).trim();
    return toplevel.split('/').pop() || 'unknown';
  } catch {
    // Fallback: use the parent directory name
    return dirname(__dirname).split('/').pop() || 'unknown';
  }
}

const PROJECT_NAME = detectProject();

// ── Schema ──────────────────────────────────────────────────────────────────

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  claude_session_id TEXT UNIQUE NOT NULL,
  user TEXT NOT NULL,
  project TEXT NOT NULL,
  user_prompt TEXT,
  started_at TEXT NOT NULL,
  started_at_epoch INTEGER NOT NULL,
  completed_at TEXT,
  completed_at_epoch INTEGER,
  status TEXT CHECK(status IN ('active', 'completed', 'failed')) DEFAULT 'active'
);

CREATE TABLE IF NOT EXISTS observations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT,
  user TEXT NOT NULL,
  project TEXT NOT NULL,
  text TEXT NOT NULL,
  type TEXT CHECK(type IN ('decision', 'bugfix', 'feature', 'refactor', 'discovery', 'change')),
  title TEXT,
  subtitle TEXT,
  facts TEXT,
  narrative TEXT,
  concepts TEXT,
  files_read TEXT,
  files_modified TEXT,
  prompt_number INTEGER,
  discovery_tokens INTEGER DEFAULT 0,
  created_at TEXT NOT NULL,
  created_at_epoch INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS session_summaries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT,
  user TEXT NOT NULL,
  project TEXT NOT NULL,
  request TEXT,
  investigated TEXT,
  learned TEXT,
  completed TEXT,
  next_steps TEXT,
  files_read TEXT,
  files_edited TEXT,
  notes TEXT,
  discovery_tokens INTEGER DEFAULT 0,
  created_at TEXT NOT NULL,
  created_at_epoch INTEGER NOT NULL
);

CREATE VIRTUAL TABLE IF NOT EXISTS observations_fts USING fts5(
  title, subtitle, narrative, text, facts, concepts,
  content=observations, content_rowid=id
);

CREATE VIRTUAL TABLE IF NOT EXISTS summaries_fts USING fts5(
  request, investigated, learned, completed, next_steps, notes,
  content=session_summaries, content_rowid=id
);

CREATE TRIGGER IF NOT EXISTS observations_ai AFTER INSERT ON observations BEGIN
  INSERT INTO observations_fts(rowid, title, subtitle, narrative, text, facts, concepts)
  VALUES (new.id, new.title, new.subtitle, new.narrative, new.text, new.facts, new.concepts);
END;

CREATE TRIGGER IF NOT EXISTS summaries_ai AFTER INSERT ON session_summaries BEGIN
  INSERT INTO summaries_fts(rowid, request, investigated, learned, completed, next_steps, notes)
  VALUES (new.id, new.request, new.investigated, new.learned, new.completed, new.next_steps, new.notes);
END;

CREATE INDEX IF NOT EXISTS idx_obs_user ON observations(user);
CREATE INDEX IF NOT EXISTS idx_obs_project ON observations(project);
CREATE INDEX IF NOT EXISTS idx_obs_type ON observations(type);
CREATE INDEX IF NOT EXISTS idx_obs_epoch ON observations(created_at_epoch DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user);
CREATE INDEX IF NOT EXISTS idx_summaries_user ON session_summaries(user);
`;

// ── User Detection ──────────────────────────────────────────────────────────

function detectUser() {
  // 1. Explicit env var (highest priority)
  if (process.env.REPO_MEM_USER) return process.env.REPO_MEM_USER;

  // 2. Git config email
  try {
    const email = execSync('git config user.email', { encoding: 'utf-8' }).trim();
    if (email) return email;
  } catch { /* no git config */ }

  // 3. OS username -> email mapping from users.json
  try {
    const usersPath = join(__dirname, 'users.json');
    if (existsSync(usersPath)) {
      const mapping = JSON.parse(readFileSync(usersPath, 'utf-8'));
      const osUser = execSync('whoami', { encoding: 'utf-8' }).trim();
      if (mapping[osUser]) return mapping[osUser];
    }
  } catch { /* no mapping */ }

  return 'unknown';
}

const CURRENT_USER = detectUser();

// ── DB Helpers ──────────────────────────────────────────────────────────────

function ensureDataDir() {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
}

function openDb(dbPath) {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}

function getOwnDb() {
  ensureDataDir();
  const dbPath = join(DATA_DIR, `${CURRENT_USER}.db`);
  const db = openDb(dbPath);
  db.exec(SCHEMA);
  return db;
}

function getAllDbFiles() {
  ensureDataDir();
  const files = readdirSync(DATA_DIR).filter(f => f.endsWith('.db'));
  return files.map(f => ({
    user: f.replace('.db', ''),
    path: join(DATA_DIR, f),
  }));
}

// ── Type Emojis ─────────────────────────────────────────────────────────────

const TYPE_EMOJI = {
  bugfix: '\u{1F534}',
  feature: '\u{1F7E3}',
  refactor: '\u{1F504}',
  discovery: '\u{1F535}',
  decision: '\u2696\uFE0F',
  change: '\u2705',
};

function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

function formatTime(isoString) {
  if (!isoString) return '';
  try {
    const d = new Date(isoString);
    return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
  } catch {
    return isoString;
  }
}

// ── Search across all DBs ──────────────────────────────────────────────────

function searchObservations(params) {
  const { query, user, obs_type, limit = 20, offset = 0, dateStart, dateEnd, orderBy = 'relevance' } = params;
  const dbFiles = getAllDbFiles();
  if (dbFiles.length === 0) return { results: [], total: 0 };

  const allResults = [];

  for (const dbFile of dbFiles) {
    if (user && dbFile.user !== user) continue;

    let db;
    try {
      db = openDb(dbFile.path);
      db.exec(SCHEMA);
    } catch {
      continue;
    }

    try {
      if (query) {
        // FTS5 full-text search
        const ftsQuery = query.split(/\s+/).map(w => `"${w}"`).join(' OR ');
        let sql = `
          SELECT o.id, o.title, o.type, o.text, o.created_at, o.user,
                 rank
          FROM observations_fts fts
          JOIN observations o ON o.id = fts.rowid
          WHERE observations_fts MATCH ?
        `;
        const bindings = [ftsQuery];

        if (obs_type) {
          sql += ' AND o.type = ?';
          bindings.push(obs_type);
        }
        if (dateStart) {
          sql += ' AND o.created_at_epoch >= ?';
          bindings.push(Math.floor(new Date(dateStart).getTime() / 1000));
        }
        if (dateEnd) {
          sql += ' AND o.created_at_epoch <= ?';
          bindings.push(Math.floor(new Date(dateEnd).getTime() / 1000));
        }

        const rows = db.prepare(sql).all(...bindings);
        for (const row of rows) {
          allResults.push({
            ...row,
            _user: dbFile.user,
            _rank: row.rank || 0,
          });
        }
      } else {
        // No query — list all observations
        let sql = 'SELECT id, title, type, text, created_at, user FROM observations WHERE 1=1';
        const bindings = [];

        if (obs_type) {
          sql += ' AND type = ?';
          bindings.push(obs_type);
        }
        if (dateStart) {
          sql += ' AND created_at_epoch >= ?';
          bindings.push(Math.floor(new Date(dateStart).getTime() / 1000));
        }
        if (dateEnd) {
          sql += ' AND created_at_epoch <= ?';
          bindings.push(Math.floor(new Date(dateEnd).getTime() / 1000));
        }

        const rows = db.prepare(sql).all(...bindings);
        for (const row of rows) {
          allResults.push({
            ...row,
            _user: dbFile.user,
            _rank: 0,
          });
        }
      }
    } catch {
      // Skip DBs that fail
    } finally {
      db.close();
    }
  }

  // Sort
  if (orderBy === 'date_asc') {
    allResults.sort((a, b) => (a.created_at || '').localeCompare(b.created_at || ''));
  } else if (orderBy === 'date_desc') {
    allResults.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
  } else {
    // relevance (lower _rank = better)
    allResults.sort((a, b) => (a._rank || 0) - (b._rank || 0));
  }

  const total = allResults.length;
  const paged = allResults.slice(offset, offset + limit);

  // Format as compact markdown table
  let table = '| ID | Time | User | T | Title | Read |\n';
  table += '|----|------|------|---|-------|------|\n';
  for (const r of paged) {
    const emoji = TYPE_EMOJI[r.type] || '';
    const tokens = estimateTokens(r.text);
    table += `| #${r.id} | ${formatTime(r.created_at)} | ${r._user} | ${emoji} | ${r.title || '(untitled)'} | ~${tokens} |\n`;
  }

  return { table, total, showing: paged.length, offset };
}

function searchSummaries(params) {
  const { query, user, limit = 20, offset = 0 } = params;
  const dbFiles = getAllDbFiles();
  if (dbFiles.length === 0) return { results: [], total: 0 };

  const allResults = [];

  for (const dbFile of dbFiles) {
    if (user && dbFile.user !== user) continue;

    let db;
    try {
      db = openDb(dbFile.path);
      db.exec(SCHEMA);
    } catch {
      continue;
    }

    try {
      let rows;
      if (query) {
        const ftsQuery = query.split(/\s+/).map(w => `"${w}"`).join(' OR ');
        rows = db.prepare(`
          SELECT s.id, s.request, s.completed, s.created_at, s.user, rank
          FROM summaries_fts fts
          JOIN session_summaries s ON s.id = fts.rowid
          WHERE summaries_fts MATCH ?
        `).all(ftsQuery);
      } else {
        rows = db.prepare('SELECT id, request, completed, created_at, user FROM session_summaries').all();
      }

      for (const row of rows) {
        allResults.push({ ...row, _user: dbFile.user });
      }
    } catch {
      // skip
    } finally {
      db.close();
    }
  }

  allResults.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
  const total = allResults.length;
  const paged = allResults.slice(offset, offset + limit);

  let table = '| ID | Time | User | Request | Completed |\n';
  table += '|----|------|------|---------|-----------|\n';
  for (const r of paged) {
    const req = (r.request || '').substring(0, 60);
    const comp = (r.completed || '').substring(0, 60);
    table += `| #${r.id} | ${formatTime(r.created_at)} | ${r._user} | ${req} | ${comp} |\n`;
  }

  return { table, total, showing: paged.length, offset };
}

// ── Tool Implementations ────────────────────────────────────────────────────

function handleSearch(params) {
  const searchType = params.type || 'observations';

  if (searchType === 'summaries') {
    return searchSummaries(params);
  }
  // sessions
  if (searchType === 'sessions') {
    const dbFiles = getAllDbFiles();
    const allResults = [];
    for (const dbFile of dbFiles) {
      if (params.user && dbFile.user !== params.user) continue;
      let db;
      try {
        db = openDb(dbFile.path);
        db.exec(SCHEMA);
        const rows = db.prepare('SELECT id, claude_session_id, user, project, status, started_at FROM sessions ORDER BY started_at_epoch DESC').all();
        for (const row of rows) allResults.push({ ...row, _user: dbFile.user });
      } catch { /* skip */ } finally { db?.close(); }
    }
    const paged = allResults.slice(params.offset || 0, (params.offset || 0) + (params.limit || 20));
    let table = '| ID | User | Project | Status | Started |\n';
    table += '|----|------|---------|--------|---------|\n';
    for (const r of paged) {
      table += `| #${r.id} | ${r._user} | ${r.project || ''} | ${r.status} | ${formatTime(r.started_at)} |\n`;
    }
    return { table, total: allResults.length, showing: paged.length };
  }

  return searchObservations(params);
}

function handleGet(params) {
  const { id, user } = params;
  if (!id || !user) return { error: 'Both id and user are required' };

  const dbPath = join(DATA_DIR, `${user}.db`);
  if (!existsSync(dbPath)) return { error: `No database found for user: ${user}` };

  const db = openDb(dbPath);
  try {
    db.exec(SCHEMA);
    const row = db.prepare('SELECT * FROM observations WHERE id = ?').get(id);
    if (!row) return { error: `Observation #${id} not found for user ${user}` };
    return row;
  } finally {
    db.close();
  }
}

function handleGetBatch(params) {
  const { ids, limit = 50 } = params;
  if (!ids || !Array.isArray(ids)) return { error: 'ids must be an array of {id, user}' };

  const results = [];
  const grouped = {};
  for (const item of ids.slice(0, limit)) {
    if (!grouped[item.user]) grouped[item.user] = [];
    grouped[item.user].push(item.id);
  }

  for (const [user, idList] of Object.entries(grouped)) {
    const dbPath = join(DATA_DIR, `${user}.db`);
    if (!existsSync(dbPath)) continue;

    const db = openDb(dbPath);
    try {
      db.exec(SCHEMA);
      const placeholders = idList.map(() => '?').join(',');
      const rows = db.prepare(`SELECT * FROM observations WHERE id IN (${placeholders})`).all(...idList);
      for (const row of rows) results.push({ ...row, _user: user });
    } catch { /* skip */ } finally {
      db.close();
    }
  }

  return { results, count: results.length };
}

function handleTimeline(params) {
  const { anchor, user, depth_before = 5, depth_after = 5 } = params;
  if (!anchor || !user) return { error: 'Both anchor (id) and user are required' };

  const dbPath = join(DATA_DIR, `${user}.db`);
  if (!existsSync(dbPath)) return { error: `No database found for user: ${user}` };

  const db = openDb(dbPath);
  try {
    db.exec(SCHEMA);
    const anchorRow = db.prepare('SELECT created_at_epoch FROM observations WHERE id = ?').get(anchor);
    if (!anchorRow) return { error: `Observation #${anchor} not found` };

    const before = db.prepare(
      'SELECT id, title, type, text, created_at, user FROM observations WHERE created_at_epoch < ? ORDER BY created_at_epoch DESC LIMIT ?'
    ).all(anchorRow.created_at_epoch, depth_before).reverse();

    const current = db.prepare(
      'SELECT id, title, type, text, created_at, user FROM observations WHERE id = ?'
    ).get(anchor);

    const after = db.prepare(
      'SELECT id, title, type, text, created_at, user FROM observations WHERE created_at_epoch > ? ORDER BY created_at_epoch ASC LIMIT ?'
    ).all(anchorRow.created_at_epoch, depth_after);

    const all = [...before, current, ...after];

    let table = '| ID | Time | T | Title | Read |\n';
    table += '|----|------|---|-------|------|\n';
    for (const r of all) {
      const emoji = TYPE_EMOJI[r.type] || '';
      const tokens = estimateTokens(r.text);
      const marker = r.id === anchor ? ' **>>**' : '';
      table += `| #${r.id} | ${formatTime(r.created_at)} | ${emoji} | ${r.title || '(untitled)'}${marker} | ~${tokens} |\n`;
    }

    return { table, anchor_id: anchor, total: all.length };
  } finally {
    db.close();
  }
}

function handleSave(params) {
  const { type, title, subtitle, narrative, facts, concepts, files_read, files_modified, session_id } = params;

  const now = new Date();
  const created_at = now.toISOString();
  const created_at_epoch = Math.floor(now.getTime() / 1000);

  const factsStr = Array.isArray(facts) ? facts.join('\n') : (facts || '');
  const conceptsStr = Array.isArray(concepts) ? concepts.join(', ') : (concepts || '');
  const filesReadStr = Array.isArray(files_read) ? files_read.join(', ') : (files_read || '');
  const filesModStr = Array.isArray(files_modified) ? files_modified.join(', ') : (files_modified || '');

  // Concatenate text from all fields
  const textParts = [title, subtitle, narrative, factsStr, conceptsStr].filter(Boolean);
  const text = textParts.join('\n\n');

  const db = getOwnDb();
  try {
    const result = db.prepare(`
      INSERT INTO observations (session_id, user, project, text, type, title, subtitle, facts, narrative, concepts, files_read, files_modified, discovery_tokens, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      session_id || null,
      CURRENT_USER,
      PROJECT_NAME,
      text,
      type || 'change',
      title || null,
      subtitle || null,
      factsStr || null,
      narrative || null,
      conceptsStr || null,
      filesReadStr || null,
      filesModStr || null,
      estimateTokens(text),
      created_at,
      created_at_epoch
    );

    return {
      id: result.lastInsertRowid,
      user: CURRENT_USER,
      title,
      type: type || 'change',
      created_at,
      message: `Observation #${result.lastInsertRowid} saved.`,
    };
  } finally {
    db.close();
  }
}

function handleSaveSummary(params) {
  const { request, investigated, learned, completed, next_steps, files_read, files_edited, notes, session_id } = params;

  const now = new Date();
  const created_at = now.toISOString();
  const created_at_epoch = Math.floor(now.getTime() / 1000);

  const filesReadStr = Array.isArray(files_read) ? files_read.join(', ') : (files_read || '');
  const filesEditedStr = Array.isArray(files_edited) ? files_edited.join(', ') : (files_edited || '');

  const textParts = [request, investigated, learned, completed, next_steps, notes].filter(Boolean);
  const discoveryTokens = estimateTokens(textParts.join('\n\n'));

  const db = getOwnDb();
  try {
    const result = db.prepare(`
      INSERT INTO session_summaries (session_id, user, project, request, investigated, learned, completed, next_steps, files_read, files_edited, notes, discovery_tokens, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      session_id || null,
      CURRENT_USER,
      PROJECT_NAME,
      request || null,
      investigated || null,
      learned || null,
      completed || null,
      next_steps || null,
      filesReadStr || null,
      filesEditedStr || null,
      notes || null,
      discoveryTokens,
      created_at,
      created_at_epoch
    );

    return {
      id: result.lastInsertRowid,
      user: CURRENT_USER,
      message: `Session summary #${result.lastInsertRowid} saved.`,
    };
  } finally {
    db.close();
  }
}

function handleTeamActivity(params) {
  const { limit = 10, exclude_self = true } = params;
  const dbFiles = getAllDbFiles();
  const allResults = [];

  for (const dbFile of dbFiles) {
    if (exclude_self && dbFile.user === CURRENT_USER) continue;

    let db;
    try {
      db = openDb(dbFile.path);
      db.exec(SCHEMA);
      const rows = db.prepare(
        'SELECT id, title, type, text, created_at, user FROM observations ORDER BY created_at_epoch DESC LIMIT ?'
      ).all(limit);
      for (const row of rows) allResults.push({ ...row, _user: dbFile.user });
    } catch { /* skip */ } finally {
      db?.close();
    }
  }

  allResults.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
  const paged = allResults.slice(0, limit);

  if (paged.length === 0) {
    return { table: 'No team activity found.', total: 0 };
  }

  let table = '| ID | Time | User | T | Title | Read |\n';
  table += '|----|------|------|---|-------|------|\n';
  for (const r of paged) {
    const emoji = TYPE_EMOJI[r.type] || '';
    const tokens = estimateTokens(r.text);
    table += `| #${r.id} | ${formatTime(r.created_at)} | ${r._user} | ${emoji} | ${r.title || '(untitled)'} | ~${tokens} |\n`;
  }

  return { table, total: paged.length };
}

function handleHelp() {
  return {
    text: `# repo-mem -- Team Memory MCP Server

**Current user:** ${CURRENT_USER}
**Project:** ${PROJECT_NAME}
**Data directory:** ${DATA_DIR}

## Tools

### search
Search observations across all team members' databases.
- \`query\`: Search text (FTS5 full-text search)
- \`user\`: Filter to specific user
- \`type\`: observations | sessions | summaries
- \`obs_type\`: bugfix | feature | refactor | discovery | decision | change
- \`limit\`, \`offset\`: Pagination
- \`dateStart\`, \`dateEnd\`: ISO date filters
- \`orderBy\`: relevance | date_desc | date_asc

### get
Fetch a single observation by ID.
- \`id\`: Observation ID
- \`user\`: Which user's database

### get_batch
Fetch multiple observations at once.
- \`ids\`: Array of \`{id, user}\` objects

### timeline
View observations around a specific anchor point.
- \`anchor\`: Observation ID
- \`user\`: Which user's database
- \`depth_before\`, \`depth_after\`: How many entries to show

### save
Save a new observation to your own database.
- \`type\`: bugfix | feature | refactor | discovery | decision | change
- \`title\`, \`subtitle\`, \`narrative\`: Description fields
- \`facts\`: Array of fact strings
- \`concepts\`: Array of concept strings
- \`files_read\`, \`files_modified\`: Array of file paths
- \`session_id\`: Optional session reference

### save_summary
Save a session summary.
- \`request\`, \`investigated\`, \`learned\`, \`completed\`, \`next_steps\`, \`notes\`
- \`files_read\`, \`files_edited\`: Arrays
- \`session_id\`: Optional session reference

### team_activity
See what other team members have been working on.
- \`limit\`: Number of results (default 10)
- \`exclude_self\`: Exclude your own activity (default true)

## Type Indicators
- \u{1F534} bugfix
- \u{1F7E3} feature
- \u{1F504} refactor
- \u{1F535} discovery
- \u2696\uFE0F decision
- \u2705 change
`,
  };
}

// ── MCP Server Setup ────────────────────────────────────────────────────────

const server = new Server(
  { name: 'repo-mem', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

// List tools
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'search',
      description: 'Search observations, sessions, or summaries across all team members. Returns a compact index table.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Full-text search query' },
          user: { type: 'string', description: 'Filter to specific user' },
          type: { type: 'string', enum: ['observations', 'sessions', 'summaries'], description: 'What to search' },
          obs_type: { type: 'string', enum: ['bugfix', 'feature', 'refactor', 'discovery', 'decision', 'change'] },
          limit: { type: 'number', description: 'Max results (default 20)' },
          offset: { type: 'number', description: 'Skip N results' },
          dateStart: { type: 'string', description: 'ISO date start filter' },
          dateEnd: { type: 'string', description: 'ISO date end filter' },
          orderBy: { type: 'string', enum: ['relevance', 'date_desc', 'date_asc'] },
        },
      },
    },
    {
      name: 'get',
      description: 'Fetch a single observation by ID from a specific user database.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'number', description: 'Observation ID' },
          user: { type: 'string', description: 'User whose database to query' },
        },
        required: ['id', 'user'],
      },
    },
    {
      name: 'get_batch',
      description: 'Fetch multiple observations at once from potentially different user databases.',
      inputSchema: {
        type: 'object',
        properties: {
          ids: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'number' },
                user: { type: 'string' },
              },
              required: ['id', 'user'],
            },
            description: 'Array of {id, user} objects',
          },
          limit: { type: 'number', description: 'Max results (default 50)' },
        },
        required: ['ids'],
      },
    },
    {
      name: 'timeline',
      description: 'View observations chronologically around an anchor observation.',
      inputSchema: {
        type: 'object',
        properties: {
          anchor: { type: 'number', description: 'Anchor observation ID' },
          user: { type: 'string', description: 'User whose database to query' },
          depth_before: { type: 'number', description: 'Entries before anchor (default 5)' },
          depth_after: { type: 'number', description: 'Entries after anchor (default 5)' },
        },
        required: ['anchor', 'user'],
      },
    },
    {
      name: 'save',
      description: 'Save a new observation to your own database.',
      inputSchema: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['bugfix', 'feature', 'refactor', 'discovery', 'decision', 'change'] },
          title: { type: 'string' },
          subtitle: { type: 'string' },
          narrative: { type: 'string' },
          facts: { type: 'array', items: { type: 'string' } },
          concepts: { type: 'array', items: { type: 'string' } },
          files_read: { type: 'array', items: { type: 'string' } },
          files_modified: { type: 'array', items: { type: 'string' } },
          session_id: { type: 'string' },
        },
        required: ['type', 'title'],
      },
    },
    {
      name: 'save_summary',
      description: 'Save a session summary to your own database.',
      inputSchema: {
        type: 'object',
        properties: {
          request: { type: 'string' },
          investigated: { type: 'string' },
          learned: { type: 'string' },
          completed: { type: 'string' },
          next_steps: { type: 'string' },
          files_read: { type: 'array', items: { type: 'string' } },
          files_edited: { type: 'array', items: { type: 'string' } },
          notes: { type: 'string' },
          session_id: { type: 'string' },
        },
      },
    },
    {
      name: 'team_activity',
      description: 'See recent observations from other team members.',
      inputSchema: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: 'Max results (default 10)' },
          exclude_self: { type: 'boolean', description: 'Exclude own activity (default true)' },
        },
      },
    },
    {
      name: 'help',
      description: 'Show usage instructions for all repo-mem tools.',
      inputSchema: { type: 'object', properties: {} },
    },
  ],
}));

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    let result;
    switch (name) {
      case 'search':
        result = handleSearch(args || {});
        break;
      case 'get':
        result = handleGet(args || {});
        break;
      case 'get_batch':
        result = handleGetBatch(args || {});
        break;
      case 'timeline':
        result = handleTimeline(args || {});
        break;
      case 'save':
        result = handleSave(args || {});
        break;
      case 'save_summary':
        result = handleSaveSummary(args || {});
        break;
      case 'team_activity':
        result = handleTeamActivity(args || {});
        break;
      case 'help':
        result = handleHelp();
        break;
      default:
        result = { error: `Unknown tool: ${name}` };
    }

    const text = typeof result === 'string' ? result :
      result.text ? result.text :
      result.table ? `${result.table}\n\n_${result.showing ?? result.total ?? 0} of ${result.total ?? 0} results${result.offset ? ` (offset ${result.offset})` : ''}_` :
      JSON.stringify(result, null, 2);

    return { content: [{ type: 'text', text }] };
  } catch (err) {
    return {
      content: [{ type: 'text', text: `Error: ${err.message}` }],
      isError: true,
    };
  }
});

// ── Start ───────────────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[repo-mem] Server started. User: ${CURRENT_USER}, Project: ${PROJECT_NAME}, Data: ${DATA_DIR}`);
}

main().catch((err) => {
  console.error('[repo-mem] Fatal error:', err);
  process.exit(1);
});
