#!/usr/bin/env node

/**
 * generate-embeddings.js
 *
 * Generates embeddings for all existing observations that don't have one yet.
 * Uses Xenova/all-MiniLM-L6-v2 (384-dimensional, runs locally).
 *
 * Usage: node generate-embeddings.js [--batch-size 50] [--db <user.db>]
 */

import { pipeline } from '@xenova/transformers';
import Database from 'better-sqlite3';
import { readdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, 'data');

// Parse args
const args = process.argv.slice(2);
let batchSize = 50;
let targetDb = null;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--batch-size' && args[i + 1]) batchSize = parseInt(args[i + 1], 10);
  if (args[i] === '--db' && args[i + 1]) targetDb = args[i + 1];
}

async function main() {
  console.log('Loading embedding model...');
  const embedder = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', {
    cache_dir: join(__dirname, '.model-cache'),
  });
  console.log('Model loaded.');

  const dbFiles = readdirSync(DATA_DIR).filter(f => f.endsWith('.db'));
  if (targetDb) {
    const idx = dbFiles.indexOf(targetDb);
    if (idx === -1) {
      console.error(`Database ${targetDb} not found in ${DATA_DIR}`);
      process.exit(1);
    }
    dbFiles.splice(0, dbFiles.length, targetDb);
  }

  for (const dbFile of dbFiles) {
    const dbPath = join(DATA_DIR, dbFile);
    console.log(`\nProcessing ${dbFile}...`);

    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');

    // Ensure embedding column exists
    const cols = db.prepare("PRAGMA table_info(observations)").all();
    if (!cols.some(c => c.name === 'embedding')) {
      db.exec('ALTER TABLE observations ADD COLUMN embedding BLOB');
      console.log('  Added embedding column.');
    }

    // Count observations without embeddings
    const { total } = db.prepare('SELECT COUNT(*) as total FROM observations WHERE embedding IS NULL').get();
    console.log(`  ${total} observations need embeddings.`);

    if (total === 0) {
      db.close();
      continue;
    }

    const updateStmt = db.prepare('UPDATE observations SET embedding = ? WHERE id = ?');

    let processed = 0;
    let failed = 0;

    while (true) {
      const rows = db.prepare(
        'SELECT id, title, subtitle, narrative FROM observations WHERE embedding IS NULL LIMIT ?'
      ).all(batchSize);

      if (rows.length === 0) break;

      for (const row of rows) {
        const text = [row.title, row.subtitle, row.narrative].filter(Boolean).join(' ');
        if (!text.trim()) {
          // No text to embed, skip but mark with empty buffer
          updateStmt.run(Buffer.alloc(0), row.id);
          processed++;
          continue;
        }

        try {
          const result = await embedder(text, { pooling: 'mean', normalize: true });
          const embeddingBuffer = Buffer.from(result.data.buffer);
          updateStmt.run(embeddingBuffer, row.id);
          processed++;
        } catch (err) {
          console.error(`  Failed on observation #${row.id}: ${err.message}`);
          failed++;
        }
      }

      const pct = ((processed + failed) / total * 100).toFixed(1);
      process.stdout.write(`\r  Progress: ${processed}/${total} (${pct}%) - ${failed} failed`);
    }

    console.log(`\n  Done: ${processed} embedded, ${failed} failed.`);
    db.close();
  }

  console.log('\nAll done.');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
