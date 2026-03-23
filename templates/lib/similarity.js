import { openDbReadonly } from './schema-manager.js';
import { readdirSync } from 'fs';
import { join } from 'path';

export async function findSimilar(queryEmbedding, cosineSimilarity, dataDir, options = {}) {
  const { threshold = 0.70, maxResults = 5, excludeIds = [], typeBoost = null } = options;
  if (!queryEmbedding) return [];

  const candidates = [];
  const now = Date.now();
  const recencyCutoff = Math.floor(now / 1000) - (90 * 24 * 60 * 60);

  for (const file of readdirSync(dataDir).filter(f => f.endsWith('.db'))) {
    const dbPath = join(dataDir, file);
    const user = file.replace('.db', '');
    let db;
    try {
      db = openDbReadonly(dbPath);
      const rows = db.prepare(
        'SELECT id, title, type, created_at_epoch, embedding FROM observations WHERE embedding IS NOT NULL AND length(embedding) > 0'
      ).all();

      for (const row of rows) {
        if (excludeIds.some(e => e.id === row.id && e.user === user)) continue;
        let sim = cosineSimilarity(queryEmbedding, row.embedding);
        if (sim < threshold) continue;
        if (typeBoost && row.type === typeBoost) sim = Math.min(1.0, sim + 0.05);
        if (row.created_at_epoch > recencyCutoff) sim = Math.min(1.0, sim + 0.02);
        candidates.push({ id: row.id, title: row.title, type: row.type, user, similarity: sim });
      }
    } catch {} finally { db?.close(); }
  }

  candidates.sort((a, b) => b.similarity - a.similarity);

  // Diversity: max 2 per normalized title
  const seen = new Map();
  const result = [];
  for (const c of candidates) {
    const norm = (c.title || '').replace(/^V\d+[:\s]*/i, '').toLowerCase().substring(0, 40);
    const count = seen.get(norm) || 0;
    if (count >= 2) continue;
    seen.set(norm, count + 1);
    result.push(c);
    if (result.length >= maxResults) break;
  }
  return result;
}
