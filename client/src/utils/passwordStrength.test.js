import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { calculatePasswordStrength, validatePassword } from './passwordPolicy.js';

const readMeter = () =>
  fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../components/PasswordStrengthMeter.jsx'), 'utf8');

const BEFORE = [
  ['', false, 0],
  ['short', false, 0],
  ['Abcdefgh1!xy', false, 1],
  ['Zk4$wNb83&hRtqLm', true, 4],
  ['Zk4$wNb83&hRtqLmPx7!', true, 4],
  ['alllowercaseletters', false, 1],
  ['ALLUPPERCASELETTERS1!', false, 4],
  ['NoDigitsHere!!ab', false, 3],
  ['NoSpecial1234xyz', false, 1],
  ['Has Space1!abcdef', false, 1],
  ['Password1!abcdef', false, 1],
  ['Qx7!vTr29#mLpw', true, 3],
  ['aaaaBb1!cdefgh', false, 1],
  ['Abcd1!Efghij', false, 1],
  ['Xk9#mP2$vL', false, 2],
  ['Xk9#mP2$vLq4', true, 3],
  ['Tr0ub4dor&3xyz', true, 3],
  ['correct-Horse-9-battery', true, 4],
  ['Welcome2024!!zz', false, 1],
  ['Zk4$wNb83&hRtqLmPx7!Jd2@Wq', true, 4],
  ['é1Aé!éééééééé', false, 1],
  ['x'.repeat(129), false, 1],
  ['Aa1!'.repeat(32), true, 4],
  ['Aa1!'.repeat(32), true, 4],
  ['Wq3$Zn8&Lp5#Rt', true, 3],
];

test('there are four levels, Very Strong is gone', () => {
  const labels = new Set(BEFORE.map(([password]) => calculatePasswordStrength(password).label));
  assert.ok([...labels].every((label) => ['Very Weak', 'Weak', 'Fair', 'Strong'].includes(label)));
  assert.ok(!labels.has('Very Strong'));
});

test('a 16-character password with all four character types is Strong', () => {
  assert.deepEqual(calculatePasswordStrength('Zk4$wNb83&hRtqLm'), { score: 3, label: 'Strong' });
  assert.deepEqual(calculatePasswordStrength('Zk4$wNb83&hRtqLmPx7!Jd2@Wq'), { score: 3, label: 'Strong' });
});

test('a 12-character password with all four character types is Strong', () => {
  assert.deepEqual(calculatePasswordStrength('Xk9#mP2$vLq4'), { score: 3, label: 'Strong' });
});

test('a space or a common word keeps a password at Weak', () => {
  assert.deepEqual(calculatePasswordStrength('Has Space1!abcdef'), { score: 1, label: 'Weak' });
  assert.deepEqual(calculatePasswordStrength('Password1!abcdef'), { score: 1, label: 'Weak' });
  assert.equal(calculatePasswordStrength('Zk4$wNb83 &hRtqLm').label, 'Weak');
});

test('every old level maps onto the new scale, Very Strong becoming Strong', () => {
  for (const [password, , oldScore] of BEFORE) {
    assert.equal(calculatePasswordStrength(password).score, Math.min(oldScore, 3), JSON.stringify(password).slice(0, 40));
  }
});

test('which passwords are accepted or refused is identical to before', () => {
  for (const [password, valid] of BEFORE) {
    assert.equal(validatePassword(password).valid, valid, JSON.stringify(password).slice(0, 40));
  }
});

test('the meter draws four bars and no colour for a fifth level', () => {
  const meter = readMeter();
  assert.match(meter, /SCORE_COLORS\.map\(\(_, index\)/);
  assert.doesNotMatch(meter, /SEGMENT_COUNT|accent\)'/);
  assert.equal((meter.match(/'var\(--color-[a-z-]+\)'/g) || []).length, 4);
});
