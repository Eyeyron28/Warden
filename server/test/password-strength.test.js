const test = require('node:test');
const assert = require('node:assert/strict');

const { calculatePasswordStrength, validatePassword } = require('../utils/passwordPolicy');

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

test('the server copy has four levels and Very Strong folds into Strong', () => {
  for (const [password, , oldScore] of BEFORE) {
    const { score, label } = calculatePasswordStrength(password);
    assert.equal(score, Math.min(oldScore, 3));
    assert.notEqual(label, 'Very Strong');
  }
});

test('which passwords are accepted or refused is identical to before', () => {
  for (const [password, valid] of BEFORE) {
    assert.equal(validatePassword(password).valid, valid);
  }
});
