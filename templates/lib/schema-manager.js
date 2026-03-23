/**
 * schema-manager.js — Centralized SQLite DB management for repo-mem
 *
 * Single source of truth: reads schema.sql for all table definitions.
 * Used by server.js, save-hook.js, and summary-hook.js.
 *
 * Uses createRequire for better-sqlite3 (CJS module) so hooks'
 * auto-install mechanism works before this module is loaded.
 */

import { createRequire } from 'module';
import { existsSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_MEM_ROOT = join(__dirname, '..');
const SCHEMA_PATH = join(REPO_MEM_ROOT, 'schema.sql');

/**
 * Load better-sqlite3 via createRequire (works with hooks' auto-install pattern).
 */
function getDatabase() {
  const require = createRequire(import.meta.url);
  return require('better-sqlite3');
}

/**
 * Read schema.sql — the single source of truth for all table definitions.
 */
function readSchema() {
  if (!existsSync(SCHEMA_PATH)) {
    throw new Error(`schema.sql not found at ${SCHEMA_PATH}`);
  }
  return readFileSync(SCHEMA_PATH, 'utf-8');
}

/**
 * Open a SQLite database with standard pragmas.
 * WAL mode, foreign_keys ON, synchronous NORMAL.
 *
 * @param {string} dbPath - Path to the .db file
 * @param {object} [options] - Options
 * @param {boolean} [options.readonly=false] - Open in readonly mode
 * @returns {Database} better-sqlite3 Database instance
 */
export function openDb(dbPath, options = {}) {
  const Database = getDatabase();
  const db = new Database(dbPath, { readonly: !!options.readonly });

  // WAL mode is always set (even readonly benefits from WAL reads)
  db.pragma('journal_mode = WAL');

  if (!options.readonly) {
    db.pragma('foreign_keys = ON');
    db.pragma('synchronous = NORMAL');
  }

  return db;
}

/**
 * Open a SQLite database in readonly mode. No DDL is executed.
 *
 * @param {string} dbPath - Path to the .db file
 * @returns {Database} better-sqlite3 Database instance (readonly)
 */
export function openDbReadonly(dbPath) {
  return openDb(dbPath, { readonly: true });
}

/**
 * Migrate: add embedding column if missing.
 * Copied from server.js:189-199.
 */
function migrateEmbeddingColumn(db) {
  try {
    const cols = db.prepare("PRAGMA table_info(observations)").all();
    if (!cols.some(c => c.name === 'embedding')) {
      db.exec('ALTER TABLE observations ADD COLUMN embedding BLOB');
      console.error('[repo-mem] Added embedding column to observations table.');
    }
  } catch {
    // Table might not exist yet, schema.sql will create it
  }
}

/**
 * Migrate: add learning loop columns (Phase 1).
 */
function migrateLearningLoopColumns(db) {
  const add = (table, col, def) => {
    try {
      const cols = db.prepare(`PRAGMA table_info(${table})`).all();
      if (!cols.some(c => c.name === col)) {
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
        console.error(`[repo-mem] Added ${table}.${col} column.`);
      }
    } catch (err) {
      console.error(`[repo-mem] Migration ${table}.${col} skipped:`, err.message);
    }
  };

  // Feedback tracking
  add('observations', 'helpful_count', 'INTEGER DEFAULT 0');
  add('observations', 'last_used_at', 'TEXT');

  // Root-cause categorization
  add('observations', 'root_cause_category', 'TEXT');

  // Resolution tracking
  add('observations', 'resolution_successful', 'INTEGER');
  add('observations', 'resolution_agent_type', 'TEXT');

  // Indexes for new columns
  const idx = (sql) => { try { db.exec(sql); } catch {} };
  idx('CREATE INDEX IF NOT EXISTS idx_obs_root_cause ON observations(root_cause_category)');
  idx('CREATE INDEX IF NOT EXISTS idx_obs_helpful ON observations(helpful_count DESC)');
  idx('CREATE INDEX IF NOT EXISTS idx_obs_resolution ON observations(resolution_successful)');
}

/**
 * Migrate: fix millisecond epochs to seconds.
 * save-hook.js and summary-hook.js previously stored created_at_epoch in ms
 * (now.getTime()) while server.js stored in seconds (Math.floor(now.getTime()/1000)).
 * This migration fixes existing rows. Idempotent: rows already in seconds
 * are < 1e12 and are not touched.
 */
function migrateEpochToSeconds(db) {
  try {
    const r1 = db.prepare(
      "UPDATE observations SET created_at_epoch = created_at_epoch / 1000 WHERE created_at_epoch > 1000000000000"
    ).run();
    const r2 = db.prepare(
      "UPDATE session_summaries SET created_at_epoch = created_at_epoch / 1000 WHERE created_at_epoch > 1000000000000"
    ).run();
    const r3 = db.prepare(
      "UPDATE sessions SET started_at_epoch = started_at_epoch / 1000 WHERE started_at_epoch > 1000000000000"
    ).run();
    const total = (r1.changes || 0) + (r2.changes || 0) + (r3.changes || 0);
    if (total > 0) {
      console.error(`[repo-mem] Fixed ${total} rows with millisecond epochs → seconds.`);
    }
  } catch (err) {
    console.error('[repo-mem] Epoch migration skipped:', err.message);
  }
}

/**
 * Initialize a database: run schema.sql + all migrations.
 *
 * @param {Database} db - An open better-sqlite3 Database instance (read-write)
 */
export function initDb(db) {
  const schema = readSchema();
  db.exec(schema);
  migrateEmbeddingColumn(db);
  migrateEpochToSeconds(db);
  migrateLearningLoopColumns(db);
}
