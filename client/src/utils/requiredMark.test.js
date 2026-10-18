import test from 'node:test';
import assert from 'node:assert/strict';

import { markRequiredControls } from './requiredMark.js';

test('a data-required label makes its control aria-required', () => {
  const attrs = {};
  const control = { getAttribute: (k) => attrs[k] ?? null, setAttribute: (k, v) => { attrs[k] = v; } };
  markRequiredControls({ querySelectorAll: () => [{ control }, { control: null }] });
  assert.equal(attrs['aria-required'], 'true');
});
