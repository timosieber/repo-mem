import { detectRootCauseCategory } from '../lib/root-cause-detector.js';
import assert from 'assert';

console.log('Testing root-cause detection...');

// Race condition
assert.strictEqual(
  detectRootCauseCategory('Race condition in async status write', 'V104 Fix', []),
  'race-condition'
);

// State loss
assert.strictEqual(
  detectRootCauseCategory('company_id lost from Redis after TTL expired', 'V96 Fix', []),
  'state-loss'
);

// Async overwrite
assert.strictEqual(
  detectRootCauseCategory('Stale async write overwrites status back to active', 'V104', []),
  'async-overwrite'
);

// Geofence logic
assert.strictEqual(
  detectRootCauseCategory('Entry detection with dwell time failed', 'Geofence bug', []),
  'geofence-logic'
);

// Permission error
assert.strictEqual(
  detectRootCauseCategory('RLS policy denied access', 'Auth bug', []),
  'permission-error'
);

// No match returns null
assert.strictEqual(
  detectRootCauseCategory('Added new button to dashboard', 'UI update', []),
  null
);

// Empty text returns null
assert.strictEqual(
  detectRootCauseCategory('', '', []),
  null
);

// Facts array contributes to detection
assert.strictEqual(
  detectRootCauseCategory('Fixed the issue', 'Bug fix', ['root cause was a race condition']),
  'race-condition'
);

console.log('All root-cause detection tests passed!');

// --- Phase 2: Pattern Engine Tests ---
import { autoGenerateTitle, incrementalCentroidUpdate } from '../lib/pattern-engine.js';

// Test auto-title generation
const titles = ['V96: Redis State Loss Fix', 'V104: Pause State Overwrite', 'V109: Idle Write State Loss'];
const genTitle = autoGenerateTitle(titles);
assert.ok(genTitle.length > 0, 'Auto-title should not be empty');
assert.ok(!genTitle.startsWith('V'), 'Auto-title should strip V-prefixes');
console.log('Generated title:', genTitle);

// Test centroid update
const dim = 4;
const oldCentroid = Buffer.from(new Float32Array([0.5, 0.5, 0.5, 0.5]).buffer);
const newEmbedding = Buffer.from(new Float32Array([1.0, 0.0, 0.0, 0.0]).buffer);
const updated = incrementalCentroidUpdate(oldCentroid, newEmbedding, 3);
assert.ok(updated instanceof Buffer, 'Should return Buffer');
const arr = new Float32Array(updated.buffer, updated.byteOffset, dim);
assert.ok(arr[0] > arr[1], 'First dim should be larger after adding [1,0,0,0]');
console.log('Centroid update test passed');

console.log('All Phase 2 pattern engine tests passed!');
