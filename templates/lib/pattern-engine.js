// Pattern clustering engine for repo-mem Learning Loop Phase 2
// Threshold-based clustering with incremental centroid updates

const PATTERN_THRESHOLD_INCREMENTAL = 0.85; // Strict for incremental (prevent drift)
const PATTERN_THRESHOLD_BATCH = 0.82;       // Slightly looser for batch discovery
const PATTERN_MERGE_THRESHOLD = 0.92;       // Very strict for merging two patterns
const MIN_CLUSTER_SIZE = 3;                 // Minimum observations to form a pattern

/**
 * Try to assign a new observation to an existing pattern.
 * Called on every save() — O(k) where k = number of active patterns.
 * Returns the matched pattern ID or null.
 */
export function tryAssignToPattern(db, obsId, obsUser, embedding, cosineSimilarity) {
  if (!embedding || !embedding.length) return null;

  const patterns = db.prepare(
    'SELECT id, centroid, member_count FROM patterns WHERE merged_into_id IS NULL AND centroid IS NOT NULL'
  ).all();

  let bestId = null;
  let bestSim = 0;

  for (const p of patterns) {
    if (!p.centroid || !p.centroid.length) continue;
    const sim = cosineSimilarity(embedding, p.centroid);
    if (sim > bestSim) { bestSim = sim; bestId = p.id; }
  }

  if (bestSim >= PATTERN_THRESHOLD_INCREMENTAL && bestId) {
    const now = new Date().toISOString();
    // Add member
    try {
      db.prepare(
        'INSERT OR IGNORE INTO pattern_members (pattern_id, observation_id, observation_user, similarity, added_at) VALUES (?, ?, ?, ?, ?)'
      ).run(bestId, obsId, obsUser, bestSim, now);
    } catch { return null; }

    // Update centroid incrementally
    const pattern = db.prepare('SELECT centroid, member_count FROM patterns WHERE id = ?').get(bestId);
    if (pattern?.centroid) {
      const updated = incrementalCentroidUpdate(pattern.centroid, embedding, pattern.member_count);
      db.prepare(
        'UPDATE patterns SET centroid = ?, member_count = member_count + 1, updated_at = ? WHERE id = ?'
      ).run(updated, now, bestId);
    }
    return bestId;
  }
  return null;
}

/**
 * Incremental centroid update: newCentroid = normalize((old * n + new) / (n+1))
 */
export function incrementalCentroidUpdate(oldCentroidBuf, newEmbeddingBuf, memberCount) {
  const dim = oldCentroidBuf.byteLength / 4;
  const old = new Float32Array(oldCentroidBuf.buffer, oldCentroidBuf.byteOffset, dim);
  const add = new Float32Array(newEmbeddingBuf.buffer, newEmbeddingBuf.byteOffset, dim);
  const result = new Float32Array(dim);
  const n = memberCount;

  for (let i = 0; i < dim; i++) {
    result[i] = (old[i] * n + add[i]) / (n + 1);
  }

  // L2 normalize
  let norm = 0;
  for (let i = 0; i < dim; i++) norm += result[i] * result[i];
  norm = Math.sqrt(norm);
  if (norm > 0) for (let i = 0; i < dim; i++) result[i] /= norm;

  return Buffer.from(result.buffer);
}

/**
 * Full recompute: find new clusters among unpatterned observations.
 * Called at session-end — O(u²) where u = unpatterned observations.
 */
export function fullRecompute(db, cosineSimilarity) {
  // Step 1: Get unpatterned observations with embeddings
  const unpatterned = db.prepare(`
    SELECT o.id, o.title, o.type, o.root_cause_category, o.embedding, o.user
    FROM observations o
    WHERE o.embedding IS NOT NULL AND length(o.embedding) > 0
    AND NOT EXISTS (
      SELECT 1 FROM pattern_members pm
      WHERE pm.observation_id = o.id AND pm.observation_user = o.user
    )
  `).all();

  if (unpatterned.length < MIN_CLUSTER_SIZE) return { assigned: 0, newPatterns: 0 };

  let assigned = 0;
  let newPatterns = 0;

  // Step 2: Try to assign to existing patterns
  const existingPatterns = db.prepare(
    'SELECT id, centroid, member_count FROM patterns WHERE merged_into_id IS NULL AND centroid IS NOT NULL'
  ).all();

  const stillUnpatterned = [];
  const now = new Date().toISOString();

  for (const obs of unpatterned) {
    let matched = false;
    for (const p of existingPatterns) {
      const sim = cosineSimilarity(obs.embedding, p.centroid);
      if (sim >= PATTERN_THRESHOLD_BATCH) {
        db.prepare(
          'INSERT OR IGNORE INTO pattern_members (pattern_id, observation_id, observation_user, similarity, added_at) VALUES (?, ?, ?, ?, ?)'
        ).run(p.id, obs.id, obs.user || 'unknown', sim, now);
        const updated = incrementalCentroidUpdate(p.centroid, obs.embedding, p.member_count);
        db.prepare('UPDATE patterns SET centroid = ?, member_count = member_count + 1, updated_at = ? WHERE id = ?')
          .run(updated, now, p.id);
        p.member_count++;
        p.centroid = updated;
        assigned++;
        matched = true;
        break;
      }
    }
    if (!matched) stillUnpatterned.push(obs);
  }

  // Step 3: Greedy clustering among remaining
  const used = new Set();
  for (let i = 0; i < stillUnpatterned.length; i++) {
    if (used.has(i)) continue;
    const seed = stillUnpatterned[i];
    const cluster = [{ idx: i, obs: seed }];

    for (let j = i + 1; j < stillUnpatterned.length; j++) {
      if (used.has(j)) continue;
      const sim = cosineSimilarity(seed.embedding, stillUnpatterned[j].embedding);
      if (sim >= PATTERN_THRESHOLD_BATCH) {
        cluster.push({ idx: j, obs: stillUnpatterned[j] });
      }
    }

    if (cluster.length >= MIN_CLUSTER_SIZE) {
      // Compute centroid
      const dim = seed.embedding.byteLength / 4;
      const centroid = new Float32Array(dim);
      for (const { obs } of cluster) {
        const emb = new Float32Array(obs.embedding.buffer, obs.embedding.byteOffset, dim);
        for (let d = 0; d < dim; d++) centroid[d] += emb[d];
      }
      for (let d = 0; d < dim; d++) centroid[d] /= cluster.length;
      // Normalize
      let norm = 0;
      for (let d = 0; d < dim; d++) norm += centroid[d] * centroid[d];
      norm = Math.sqrt(norm);
      if (norm > 0) for (let d = 0; d < dim; d++) centroid[d] /= norm;

      const title = autoGenerateTitle(cluster.map(c => c.obs.title));
      const category = cluster[0].obs.root_cause_category || 'uncategorized';

      const result = db.prepare(`
        INSERT INTO patterns (title, description, category, centroid, member_count, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(title, `${cluster.length} observations clustered by semantic similarity`, category,
        Buffer.from(centroid.buffer), cluster.length, now, now);

      const patternId = result.lastInsertRowid;
      for (const { idx, obs } of cluster) {
        const sim = cosineSimilarity(seed.embedding, obs.embedding);
        db.prepare(
          'INSERT OR IGNORE INTO pattern_members (pattern_id, observation_id, observation_user, similarity, added_at) VALUES (?, ?, ?, ?, ?)'
        ).run(patternId, obs.id, obs.user || 'unknown', sim, now);
        used.add(idx);
      }

      newPatterns++;
      assigned += cluster.length;
    }
  }

  // Step 4: Merge near-duplicate patterns
  mergePatterns(db, cosineSimilarity);

  return { assigned, newPatterns };
}

/**
 * Merge patterns whose centroids are very similar (>0.92).
 */
function mergePatterns(db, cosineSimilarity) {
  const patterns = db.prepare(
    'SELECT id, centroid, member_count, title FROM patterns WHERE merged_into_id IS NULL AND centroid IS NOT NULL'
  ).all();

  for (let i = 0; i < patterns.length; i++) {
    for (let j = i + 1; j < patterns.length; j++) {
      const sim = cosineSimilarity(patterns[i].centroid, patterns[j].centroid);
      if (sim >= PATTERN_MERGE_THRESHOLD) {
        // Merge smaller into larger
        const [primary, secondary] = patterns[i].member_count >= patterns[j].member_count
          ? [patterns[i], patterns[j]] : [patterns[j], patterns[i]];

        db.prepare('UPDATE pattern_members SET pattern_id = ? WHERE pattern_id = ?')
          .run(primary.id, secondary.id);
        db.prepare('UPDATE patterns SET merged_into_id = ? WHERE id = ?')
          .run(primary.id, secondary.id);

        // Recount
        const count = db.prepare('SELECT COUNT(*) as c FROM pattern_members WHERE pattern_id = ?')
          .get(primary.id).c;
        db.prepare('UPDATE patterns SET member_count = ?, updated_at = ? WHERE id = ?')
          .run(count, new Date().toISOString(), primary.id);
      }
    }
  }
}

/**
 * Generate a title from member observation titles.
 * Extracts common significant words.
 */
export function autoGenerateTitle(titles) {
  const STOP = new Set([
    'fix','bug','the','a','an','in','on','at','to','for','of','is','was','with',
    'der','die','das','ein','eine','und','oder','nicht','bei','von','nach',
  ]);

  const wordFreq = new Map();
  const cleaned = titles.map(t => (t || '').replace(/^V\d+[:\s]*/i, '').trim());

  for (const t of cleaned) {
    const words = t.split(/[\s,.!?:;()\[\]{}]+/).filter(w => w.length > 2 && !STOP.has(w.toLowerCase()));
    const seen = new Set();
    for (const w of words) {
      const lower = w.toLowerCase();
      if (!seen.has(lower)) {
        wordFreq.set(lower, (wordFreq.get(lower) || 0) + 1);
        seen.add(lower);
      }
    }
  }

  // Words that appear in >40% of titles
  const threshold = Math.max(2, Math.floor(titles.length * 0.4));
  const keywords = [...wordFreq.entries()]
    .filter(([, count]) => count >= threshold)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([word]) => word);

  if (keywords.length === 0) {
    // Fallback: first non-empty cleaned title truncated
    return cleaned.find(t => t) || 'Unnamed Pattern';
  }

  return keywords.join(' + ');
}
