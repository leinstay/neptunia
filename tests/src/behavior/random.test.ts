// The random helpers of a turn (src/behavior/random.ts): `between` and the typing time `typingMs`, with an injected rng.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { between, typingMs } from '../../../src/behavior/random.ts';
import { ownedBy } from '../../fixtures/owner-accounts.ts';
import '../../../src/tools/operations/index.ts';

function rngReturning(value: number) {
  return () => value;
}

test('between: rng=0.5 returns the midpoint', () => {
  assert.equal(between([10, 20], rngReturning(0.5)), 15);
});

type TypingConfig = Parameters<typeof typingMs>[1];

test('typingMs: clamps below minMs for very short text', () => {
  const cfg: TypingConfig = { msPerChar: [1, 1], minMs: 900, maxMs: 12000 };
  const ms = typingMs('a', cfg, rngReturning(0)); // 1 char * 1ms/char = 1ms, way under minMs
  assert.equal(ms, 900);
});

test('typingMs: clamps above maxMs for very long text', () => {
  const cfg: TypingConfig = { msPerChar: [100, 100], minMs: 900, maxMs: 12000 };
  const ms = typingMs('a'.repeat(1000), cfg, rngReturning(0)); // 100,000ms, way over maxMs
  assert.equal(ms, 12000);
});

test('typingMs: within range uses length * msPerChar (rounded)', () => {
  const cfg: TypingConfig = { msPerChar: [10, 10], minMs: 0, maxMs: 100000 };
  const ms = typingMs('a'.repeat(20), cfg, rngReturning(0));
  assert.equal(ms, 200);
});

// The owner of these configs: `bot.ownerPerson` and the accounts bound to it (tests/fixtures/owner-accounts.ts).
ownedBy(['u1']);
