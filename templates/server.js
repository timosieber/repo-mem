#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { execSync } from 'child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { openDb, initDb } from './lib/schema-manager.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, 'data');

// ── Embedding Pipeline (lazy-loaded) ────────────────────────────────────────

let _embeddingPipeline = null;
let _embeddingPipelineLoading = null;

async function getEmbeddingPipeline() {
  if (_embeddingPipeline) return _embeddingPipeline;
  if (_embeddingPipelineLoading) return _embeddingPipelineLoading;

  _embeddingPipelineLoading = (async () => {
    try {
      const { pipeline } = await import('@xenova/transformers');
      _embeddingPipeline = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', {
        cache_dir: join(__dirname, '.model-cache'),
      });
      console.error('[repo-mem] Embedding model loaded.');
      return _embeddingPipeline;
    } catch (err) {
      console.error('[repo-mem] Embedding model failed to load, falling back to FTS-only:', err.message);
      _embeddingPipelineLoading = null;
      return null;
    }
  })();

  return _embeddingPipelineLoading;
}

async function generateEmbedding(text) {
  const pipe = await getEmbeddingPipeline();
  if (!pipe) return null;
  try {
    const result = await pipe(text, { pooling: 'mean', normalize: true });
    return Buffer.from(result.data.buffer);
  } catch (err) {
    console.error('[repo-mem] Embedding generation failed:', err.message);
    return null;
  }
}

function cosineSimilarity(bufA, bufB) {
  if (!bufA || !bufB || bufA.length !== bufB.length) return 0;
  const a = new Float32Array(bufA.buffer, bufA.byteOffset, bufA.byteLength / 4);
  const b = new Float32Array(bufB.buffer, bufB.byteOffset, bufB.byteLength / 4);
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  // Vectors are already normalized, so dot product = cosine similarity
  return dot;
}

// ── Schema ──────────────────────────────────────────────────────────────────
// Schema is now managed by lib/schema-manager.js (reads schema.sql as single source of truth)
// Use openDb(path) to open a database, initDb(db) to apply schema + migrations

// ── User Detection ──────────────────────────────────────────────────────────

function detectUser() {
  // 1. Explicit env var (highest priority)
  if (process.env.REPO_MEM_USER) return process.env.REPO_MEM_USER;

  // 2. Git config email
  try {
    const email = execSync('git config user.email', { encoding: 'utf-8' }).trim();
    if (email) return email;
  } catch { /* no git config */ }

  // 3. OS username → email mapping from users.json
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

function getOwnDb() {
  ensureDataDir();
  const dbPath = join(DATA_DIR, `${CURRENT_USER}.db`);
  const db = openDb(dbPath);
  initDb(db);
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

function userFromDbFile(filename) {
  return filename.replace('.db', '');
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

async function searchObservations(params) {
  const { query, user, obs_type, limit = 20, offset = 0, dateStart, dateEnd, orderBy = 'relevance' } = params;
  const dbFiles = getAllDbFiles();
  if (dbFiles.length === 0) return { results: [], total: 0 };

  // Generate query embedding for semantic search
  let queryEmbedding = null;
  if (query && orderBy === 'relevance') {
    queryEmbedding = await generateEmbedding(query);
  }

  const allResults = [];

  for (const dbFile of dbFiles) {
    if (user && dbFile.user !== user) continue;

    let db;
    try {
      db = openDb(dbFile.path);
      initDb(db);
    } catch {
      continue;
    }

    try {
      // FTS results (keyword match)
      let ftsResults = new Map();
      if (query) {
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
          ftsResults.set(row.id, row);
        }
      }

      // Semantic search (if embedding available)
      if (queryEmbedding) {
        // Load all observations with embeddings for semantic scoring
        let sql = 'SELECT id, title, type, text, created_at, user, embedding FROM observations WHERE embedding IS NOT NULL';
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

        const embRows = db.prepare(sql).all(...bindings);

        for (const row of embRows) {
          const similarity = cosineSimilarity(queryEmbedding, row.embedding);
          const ftsRow = ftsResults.get(row.id);

          // Normalize FTS rank: rank is negative (lower=better), convert to 0-1 score
          let ftsScore = 0;
          if (ftsRow) {
            // FTS5 rank is negative; typical range -20 to 0. Normalize to 0-1.
            ftsScore = Math.min(1, Math.max(0, -ftsRow.rank / 20));
          }

          // Hybrid score: 0.6 * semantic + 0.4 * keyword
          const hybridScore = 0.6 * similarity + 0.4 * ftsScore;

          allResults.push({
            id: row.id,
            title: row.title,
            type: row.type,
            text: row.text,
            created_at: row.created_at,
            user: row.user,
            _user: dbFile.user,
            _rank: -hybridScore, // negative so lower = better (consistent with FTS)
            _similarity: similarity,
          });

          // Remove from ftsResults so we don't double-add
          ftsResults.delete(row.id);
        }
      }

      // Add remaining FTS-only results (no embedding)
      for (const [id, row] of ftsResults) {
        allResults.push({
          ...row,
          _user: dbFile.user,
          _rank: row.rank || 0,
          _similarity: 0,
        });
      }

      // If no query at all — list all
      if (!query) {
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
            _similarity: 0,
          });
        }
      }
    } catch {
      // Skip DBs that fail
    } finally {
      db.close();
    }
  }

  // ── Type Boosting: high-value types rank higher ──
  const TYPE_BOOST = {
    bugfix: 0.25,
    feature: 0.20,
    decision: 0.20,
    refactor: 0.10,
    discovery: 0.0,
    change: -0.10,
  };

  if (orderBy === 'relevance') {
    for (const r of allResults) {
      const boost = TYPE_BOOST[r.type] || 0;
      r._rank -= boost; // _rank is negative (lower = better), so subtract to boost
    }
  }

  // ── Deduplicate: group by similar title, keep best per group ──
  if (query && orderBy === 'relevance') {
    const seen = new Map(); // normalizedTitle -> best result
    const deduped = [];
    for (const r of allResults) {
      // Normalize: strip version prefixes, trim, lowercase
      const normTitle = (r.title || '')
        .replace(/^(V\d+[:\s]*)/i, '')
        .replace(/^(Commit|Supabase|Git|Run|Memory)[:\s]*/i, '')
        .trim().toLowerCase().substring(0, 60);

      if (!normTitle) { deduped.push(r); continue; }

      const existing = seen.get(normTitle);
      if (existing) {
        // Keep the one with more content (longer text = more detail)
        if ((r.text || '').length > (existing.text || '').length) {
          // Replace existing with better version
          const idx = deduped.indexOf(existing);
          if (idx >= 0) deduped[idx] = r;
          seen.set(normTitle, r);
        }
        // else skip this duplicate
      } else {
        seen.set(normTitle, r);
        deduped.push(r);
      }
    }
    allResults.length = 0;
    allResults.push(...deduped);
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

  // Format as markdown table
  let table = '| ID | Time | User | T | Title | Sim | Read |\n';
  table += '|----|------|------|---|-------|-----|------|\n';
  for (const r of paged) {
    const emoji = TYPE_EMOJI[r.type] || '';
    const tokens = estimateTokens(r.text);
    const sim = r._similarity ? `${(r._similarity * 100).toFixed(0)}%` : '';
    table += `| #${r.id} | ${formatTime(r.created_at)} | ${r._user} | ${emoji} | ${r.title || '(untitled)'} | ${sim} | ~${tokens} |\n`;
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
      initDb(db);
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

async function handleSearch(params) {
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
        initDb(db);
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
    initDb(db);
    const row = db.prepare('SELECT * FROM observations WHERE id = ?').get(id);
    if (!row) return { error: `Observation #${id} not found for user ${user}` };

    // RJDC: Track observation view
    try {
      const ownDb = getOwnDb();
      const now = new Date();
      ownDb.prepare(`
        INSERT INTO observation_usage (observation_id, observation_user, session_id, user, action, created_at, created_at_epoch)
        VALUES (?, ?, ?, ?, 'viewed', ?, ?)
      `).run(id, user, null, CURRENT_USER, now.toISOString(), Math.floor(now.getTime() / 1000));
      ownDb.close();
    } catch { /* never block get() */ }

    // Update last_used_at on the observation itself
    try {
      const targetDb = openDb(dbPath);
      initDb(targetDb);
      targetDb.prepare('UPDATE observations SET last_used_at = ? WHERE id = ?')
        .run(now.toISOString(), id);
      targetDb.close();
    } catch { /* non-blocking */ }

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
      initDb(db);
      const placeholders = idList.map(() => '?').join(',');
      const rows = db.prepare(`SELECT * FROM observations WHERE id IN (${placeholders})`).all(...idList);
      for (const row of rows) results.push({ ...row, _user: user });
    } catch { /* skip */ } finally {
      db.close();
    }
  }

  // RJDC: Track observation views in batch
  try {
    const ownDb = getOwnDb();
    const now = new Date();
    const nowIso = now.toISOString();
    const nowEpoch = Math.floor(now.getTime() / 1000);
    const stmt = ownDb.prepare(`
      INSERT INTO observation_usage (observation_id, observation_user, session_id, user, action, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, 'viewed', ?, ?)
    `);
    for (const r of results) {
      stmt.run(r.id, r._user, null, CURRENT_USER, nowIso, nowEpoch);
    }
    ownDb.close();
  } catch { /* never block get_batch() */ }

  return { results, count: results.length };
}

function handleTimeline(params) {
  const { anchor, user, depth_before = 5, depth_after = 5 } = params;
  if (!anchor || !user) return { error: 'Both anchor (id) and user are required' };

  const dbPath = join(DATA_DIR, `${user}.db`);
  if (!existsSync(dbPath)) return { error: `No database found for user: ${user}` };

  const db = openDb(dbPath);
  try {
    initDb(db);
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

async function handleSave(params) {
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

  // Generate embedding from title + subtitle + narrative
  const embeddingText = [title, subtitle, narrative].filter(Boolean).join(' ');
  const embedding = await generateEmbedding(embeddingText);

  const db = getOwnDb();
  try {
    const result = db.prepare(`
      INSERT INTO observations (session_id, user, project, text, type, title, subtitle, facts, narrative, concepts, files_read, files_modified, discovery_tokens, created_at, created_at_epoch, embedding)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      created_at_epoch,
      embedding
    );

    // RJDC: Mark recently-viewed observations as "contributed"
    try {
      const thirtyMinAgo = Math.floor(Date.now() / 1000) - (30 * 60);
      db.prepare(`
        UPDATE observation_usage SET action = 'contributed'
        WHERE user = ? AND action = 'viewed' AND created_at_epoch >= ?
      `).run(CURRENT_USER, thirtyMinAgo);
    } catch { /* non-blocking */ }

    // RJDC: Auto-categorize root cause
    if (type === 'bugfix' || type === 'discovery') {
      try {
        const { detectRootCauseCategory } = await import('./lib/root-cause-detector.js');
        const category = detectRootCauseCategory(narrative, title, Array.isArray(facts) ? facts : []);
        if (category) {
          db.prepare('UPDATE observations SET root_cause_category = ? WHERE id = ?')
            .run(category, Number(result.lastInsertRowid));
        }
      } catch { /* non-blocking */ }
    }

    // Write resolution_agent_type if provided
    if (params.resolution_agent_type) {
      try {
        db.prepare('UPDATE observations SET resolution_agent_type = ? WHERE id = ?')
          .run(params.resolution_agent_type, Number(result.lastInsertRowid));
      } catch {}
    }

    // Find related observations
    let related = [];
    if (embedding) {
      try {
        const { findSimilar } = await import('./lib/similarity.js');
        related = await findSimilar(embedding, cosineSimilarity, DATA_DIR, {
          threshold: 0.75, maxResults: 3,
          excludeIds: [{ id: Number(result.lastInsertRowid), user: CURRENT_USER }],
          typeBoost: type || null,
        });
      } catch { /* non-blocking */ }
    }

    // Pattern clustering: try to assign to existing pattern
    let patternId = null;
    if (embedding) {
      try {
        const { tryAssignToPattern } = await import('./lib/pattern-engine.js');
        patternId = tryAssignToPattern(db, Number(result.lastInsertRowid), CURRENT_USER, embedding, cosineSimilarity);
      } catch { /* non-blocking */ }
    }

    return {
      id: result.lastInsertRowid,
      user: CURRENT_USER,
      title,
      type: type || 'change',
      created_at,
      message: `Observation #${result.lastInsertRowid} saved${embedding ? ' (with embedding)' : ''}.`,
      related: related.length > 0 ? related.map(r => ({
        id: r.id, user: r.user, title: r.title, type: r.type,
        similarity: `${(r.similarity * 100).toFixed(0)}%`
      })) : undefined,
      patternId: patternId || undefined,
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
      initDb(db);
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
    text: `# repo-mem — Team Memory MCP Server

**Current user:** ${CURRENT_USER}
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
Save a new observation (writes to your own database only).
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

### rate
Rate an observation as helpful or unhelpful.
- \`id\`: Observation ID
- \`user\`: Which user's database
- \`helpful\`: true | false
- \`comment\`: Optional reason

## Type Emojis
- \u{1F534} bugfix
- \u{1F7E3} feature
- \u{1F504} refactor
- \u{1F535} discovery
- \u2696\uFE0F decision
- \u2705 change
`,
  };
}

function handleRate(params) {
  const { id, user, helpful, comment } = params;
  if (id == null || !user || helpful == null) return { error: 'id, user, and helpful are required' };

  const action = helpful ? 'rated_helpful' : 'rated_unhelpful';
  const now = new Date();
  const db = getOwnDb();
  try {
    db.prepare(`
      INSERT INTO observation_usage (observation_id, observation_user, session_id, user, action, comment, created_at, created_at_epoch)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, user, null, CURRENT_USER, action, comment || null, now.toISOString(), Math.floor(now.getTime() / 1000));

    // Increment helpful_count on the observation
    if (helpful) {
      try {
        const targetDbPath = join(DATA_DIR, `${user}.db`);
        if (existsSync(targetDbPath)) {
          const targetDb = openDb(targetDbPath);
          initDb(targetDb);
          targetDb.prepare('UPDATE observations SET helpful_count = helpful_count + 1 WHERE id = ?').run(id);
          targetDb.close();
        }
      } catch {}
    }

    return { message: `Observation #${id} rated as ${helpful ? 'helpful' : 'unhelpful'}.`, observation_id: id, action };
  } finally { db.close(); }
}

function handlePatterns(params) {
  const { category, limit = 20 } = params || {};
  const db = getOwnDb();
  try {
    let sql = 'SELECT * FROM patterns WHERE merged_into_id IS NULL';
    const bindings = [];
    if (category) { sql += ' AND category = ?'; bindings.push(category); }
    sql += ' ORDER BY member_count DESC, updated_at DESC LIMIT ?';
    bindings.push(limit);

    const rows = db.prepare(sql).all(...bindings);
    if (rows.length === 0) return { table: 'No patterns discovered yet.', total: 0 };

    let table = '| ID | Category | Title | Members | Agent | Updated |\n';
    table += '|----|----------|-------|---------|-------|--------|\n';
    for (const r of rows) {
      table += `| #${r.id} | ${r.category} | ${r.title} | ${r.member_count} | ${r.recommended_agent_type || '-'} | ${r.updated_at?.substring(0, 10)} |\n`;
    }
    return { table, total: rows.length };
  } finally { db.close(); }
}

async function handleRecommendAgent(params) {
  const { description } = params;
  if (!description) return { error: 'description is required' };

  // Try embedding-based first
  const embedding = await generateEmbedding(description);
  const db = getOwnDb();
  try {
    const { embeddingRoute, keywordRoute } = await import('./lib/agent-router.js');
    const result = embeddingRoute(embedding, db, cosineSimilarity);
    if (result) return result;

    // Fallback to keyword
    const kwResult = keywordRoute(description);
    return kwResult || { agent: 'general-purpose', confidence: 'low', reason: 'No similar resolved observations found', via: 'fallback' };
  } finally { db.close(); }
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
          resolution_agent_type: { type: 'string', description: 'Agent type that resolved this (e.g. location-sensor-specialist)' },
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
    {
      name: 'rate',
      description: 'Rate an observation as helpful or unhelpful for the current task. Helps the learning loop prioritize useful observations.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'number', description: 'Observation ID to rate' },
          user: { type: 'string', description: 'User who owns the observation' },
          helpful: { type: 'boolean', description: 'Was this observation helpful?' },
          comment: { type: 'string', description: 'Optional: why was it helpful/not helpful?' },
        },
        required: ['id', 'user', 'helpful'],
      },
    },
    {
      name: 'patterns',
      description: 'Show discovered meta-patterns from recurring observations. Patterns are clusters of semantically similar observations.',
      inputSchema: {
        type: 'object',
        properties: {
          category: { type: 'string', description: 'Filter by root_cause_category' },
          limit: { type: 'number', description: 'Max results (default 20)' },
        },
      },
    },
    {
      name: 'recommend_agent',
      description: 'Recommend the best agent type for a task based on past successes.',
      inputSchema: {
        type: 'object',
        properties: {
          description: { type: 'string', description: 'Description of the task/bug to route' },
        },
        required: ['description'],
      },
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
        result = await handleSearch(args || {});
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
        result = await handleSave(args || {});
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
      case 'rate':
        result = handleRate(args);
        break;
      case 'patterns':
        result = handlePatterns(args);
        break;
      case 'recommend_agent':
        result = await handleRecommendAgent(args);
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
  console.error(`[repo-mem] Server started. User: ${CURRENT_USER}, Data: ${DATA_DIR}`);
}

main().catch((err) => {
  console.error('[repo-mem] Fatal error:', err);
  process.exit(1);
});
