import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

import { describeEvent, iconKind, manilaDayBoundary } from './activityText.js';

const require = createRequire(import.meta.url);
const { EVENT_TYPES } = require('../../../server/utils/auditTypes.js');

test('every event type the server records has plain wording and an icon', () => {
  for (const type of EVENT_TYPES) {
    const text = describeEvent({ type, target: { kind: 'document', name: 'a.pdf' } });
    assert.ok(typeof text === 'string' && text.length > 2 && text !== type, `wording for ${type}`);
    assert.ok(iconKind(type), `icon for ${type}`);
  }
});

test('names come from the lookup; a deleted file or link is described, never blank', () => {
  assert.match(describeEvent({ type: 'download', target: { kind: 'document', name: 'passport.pdf' } }), /passport\.pdf/);
  assert.match(describeEvent({ type: 'view', target: { kind: 'document', gone: true } }), /deleted file/);
  assert.match(describeEvent({ type: 'share_created', target: { kind: 'share', gone: true } }), /no longer exists/);
});

test('day filters are Manila days (UTC+8)', () => {
  assert.equal(new Date(manilaDayBoundary('2026-03-05')).toISOString(), '2026-03-04T16:00:00.000Z');
});
