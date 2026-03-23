// Root-cause auto-categorization for bugfixes
// 10 categories based on common bug patterns

const ROOT_CAUSE_KEYWORDS = {
  'race-condition': [
    /race\s*condition/i, /concurrent/i, /timing\s*(issue|bug)/i,
    /fire.and.forget/i, /parallel.*write/i, /out.of.order/i,
  ],
  'state-loss': [
    /state.*(?:lost|loss|missing)/i, /TTL.*expir/i,
    /Redis.*(?:lost|null|expired)/i, /cache.*(?:stale|expired)/i,
    /field.*(?:null|missing|lost)/i,
  ],
  'async-overwrite': [
    /async.*overwrite/i, /late.*write/i, /stale.*write/i,
    /overwrit.*(?:status|state)/i,
  ],
  'timing-issue': [
    /cooldown/i, /debounce.*fail/i, /too\s*(fast|slow|early|late)/i,
    /timeout/i,
  ],
  'null-reference': [
    /null\s*(?:pointer|reference|check)/i, /undefined.*(?:access|property)/i,
    /cannot\s*read.*(?:null|undefined)/i,
  ],
  'config-error': [
    /config.*(?:wrong|incorrect|missing)/i, /threshold.*(?:wrong|too)/i,
  ],
  'permission-error': [
    /permission/i, /RLS/i, /auth.*(?:fail|deny)/i, /forbidden/i,
  ],
  'ui-state-sync': [
    /UI.*(?:not|didn.t).*update/i, /display.*(?:stale|wrong)/i,
    /Realtime.*(?:miss|late)/i, /widget.*(?:stale|wrong|0:00)/i,
  ],
  'offline-batch': [
    /offline/i, /burst.*upload/i, /batch.*(?:process|detect)/i,
  ],
  'geofence-logic': [
    /geofence/i, /entry.*detect/i, /exit.*detect/i,
    /dwell/i, /ambiguity/i,
  ],
};

export function detectRootCauseCategory(narrative, title, facts) {
  const allText = [narrative || '', title || '', ...(Array.isArray(facts) ? facts : [])].join(' ');
  if (!allText.trim()) return null;

  let best = null;
  let bestScore = 0;
  for (const [category, patterns] of Object.entries(ROOT_CAUSE_KEYWORDS)) {
    let score = 0;
    for (const pattern of patterns) {
      const matches = allText.match(new RegExp(pattern, 'gi'));
      if (matches) score += matches.length;
    }
    if (score > bestScore) { bestScore = score; best = category; }
  }
  return bestScore >= 1 ? best : null;
}
