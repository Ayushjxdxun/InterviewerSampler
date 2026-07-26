import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeScoreValue } from '../utils/scoreUtils.js';

test('normalizes slash-based scores like 9/10 to 90', () => {
  assert.equal(normalizeScoreValue('9/10'), 90);
});

test('normalizes out-of scores like 8 out of 10 to 80', () => {
  assert.equal(normalizeScoreValue('8 out of 10'), 80);
});

test('keeps already percentage values intact', () => {
  assert.equal(normalizeScoreValue(87), 87);
});
