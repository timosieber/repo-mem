// Smart agent routing based on past successes

const KEYWORD_ROUTES = {
  'ios-swift-implementation-specialist': [/ios/i, /swift/i, /swiftui/i, /xcode/i, /widget/i, /xcodeproj/i],
  'location-sensor-specialist': [/gps/i, /location/i, /geofence/i, /dwell/i, /entry.*detect/i, /exit.*detect/i, /drive.*controller/i],
  'construction-site-detector': [/baustelle/i, /construction.*site/i, /entry.*exit/i, /dwell.*time/i],
  'supabase-integration-specialist': [/supabase/i, /rls/i, /migration/i, /edge.*function/i, /realtime/i, /postgres/i],
  'ui-ux-design-expert': [/ui/i, /ux/i, /design/i, /button/i, /layout/i, /dashboard/i, /widget.*view/i],
};

/**
 * Instant keyword-based routing (0ms). For context-hook.
 */
export function keywordRoute(text) {
  if (!text || text.length < 5) return null;
  const lower = text.toLowerCase();

  let best = null;
  let bestScore = 0;
  for (const [agent, patterns] of Object.entries(KEYWORD_ROUTES)) {
    let score = 0;
    for (const p of patterns) {
      if (p.test(lower)) score++;
    }
    if (score > bestScore) { bestScore = score; best = agent; }
  }
  return bestScore >= 1 ? { agent: best, confidence: bestScore >= 2 ? 'high' : 'medium', via: 'keyword' } : null;
}

/**
 * Embedding-based routing using past resolutions. For on-demand MCP tool.
 */
export function embeddingRoute(queryEmbedding, db, cosineSimilarity) {
  if (!queryEmbedding) return null;

  const candidates = db.prepare(`
    SELECT id, title, embedding, resolution_agent_type
    FROM observations
    WHERE resolution_agent_type IS NOT NULL
    AND embedding IS NOT NULL AND length(embedding) > 0
  `).all();

  if (candidates.length < 3) return null; // Not enough data

  const scored = [];
  for (const c of candidates) {
    const sim = cosineSimilarity(queryEmbedding, c.embedding);
    if (sim > 0.60) scored.push({ ...c, similarity: sim });
  }

  scored.sort((a, b) => b.similarity - a.similarity);
  const top5 = scored.slice(0, 5);
  if (top5.length === 0) return null;

  // Aggregate agent types with similarity-weighted voting
  const votes = {};
  for (const m of top5) {
    votes[m.resolution_agent_type] = (votes[m.resolution_agent_type] || 0) + m.similarity;
  }

  const sorted = Object.entries(votes).sort((a, b) => b[1] - a[1]);
  const winner = sorted[0];
  const totalWeight = sorted.reduce((s, [, w]) => s + w, 0);
  const confidence = winner[1] / totalWeight;

  return {
    agent: winner[0],
    confidence: confidence > 0.7 ? 'high' : confidence > 0.4 ? 'medium' : 'low',
    reason: `${top5.filter(m => m.resolution_agent_type === winner[0]).length}/${top5.length} similar resolved by ${winner[0]}`,
    supporting: top5.filter(m => m.resolution_agent_type === winner[0]).map(s => ({
      id: s.id, title: s.title, similarity: `${(s.similarity * 100).toFixed(0)}%`
    })),
    via: 'embedding',
  };
}
