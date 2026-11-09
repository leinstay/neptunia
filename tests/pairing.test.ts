// The one-time phrases of pairing (src/interface/pairing.ts), by the limits of Hermes's gateway/pairing.py: a phrase
// of six words of the word list (src/interface/phrase-codes.ts), alive one hour, at most three waiting per interface,
// one request per account per ten minutes, and five wrong approvals lock the approvals for an hour. A phrase is asked
// only while the owner opened pairing on that interface. The state survives a restart through its file. Injected
// clock, synthetic words and a temporary folder.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createPairing } from '../src/interface/pairing.ts';
import type { CodeRequest, Pairing } from '../src/interface/pairing.ts';
import { createPhraseCodes } from '../src/interface/phrase-codes.ts';
import { tempDir } from './fixtures/tmp.ts';

const MINUTE = 60_000;
const START = Date.parse('2026-11-08T12:00:00Z');
const WORDS = ['amber', 'birch', 'cedar', 'dune', 'ember', 'fjord', 'grove', 'heath', 'inlet', 'jade', 'kelp', 'loam'];
const PHRASES = createPhraseCodes({ words: () => WORDS, matcher: () => ({ stem: (word) => word, endings: [] }) });

type Rig = { pairing: Pairing; at: (ms: number) => void; restart: () => Pairing; file: string };

/** A pairing over a clock the test moves, kept in a state file that a restart reads again. */
function rig(): Rig {
  let now = START;
  const file = path.join(tempDir('nep-pairing-'), 'pairing-codes.json');
  const build = (): Pairing => createPairing({ now: () => now, phrases: PHRASES, file });
  return { pairing: build(), at: (ms) => (now = START + ms), restart: build, file };
}

function codeOf(request: CodeRequest): string {
  assert.equal(request.kind, 'code');
  return request.kind === 'code' ? request.phrase : '';
}

// The owner's decision of 2026-11-08 replaced the eight-character codes with phrases of six dictionary words.
test('gives a phrase of six distinct words of the list when pairing is open', () => {
  const { pairing } = rig();
  pairing.open('chatnet');
  const words = codeOf(pairing.request({ iface: 'chatnet', native: 'u9' })).split(' ');
  assert.equal(new Set(words).size, 6);
  assert.ok(
    words.every((word) => WORDS.includes(word)),
    words.join(' ')
  );
});

test('gives no code on an interface where the owner opened no pairing', () => {
  const { pairing } = rig();
  pairing.open('chatnet');
  assert.equal(pairing.request({ iface: 'othernet', native: 'u9' }).kind, 'closed');
});

test('closes pairing an hour after the owner opened it', () => {
  const { pairing, at } = rig();
  pairing.open('chatnet');
  at(60 * MINUTE + 1);
  assert.equal(pairing.request({ iface: 'chatnet', native: 'u9' }).kind, 'closed');
});

test('approving the right code names the account that asked for it', () => {
  const { pairing } = rig();
  pairing.open('chatnet');
  const code = codeOf(pairing.request({ iface: 'chatnet', native: 'u9' }));
  assert.deepEqual(pairing.approve(code), { kind: 'approved', account: { iface: 'chatnet', native: 'u9' } });
});

// A phrase counts in any order, where a code counted in any letter case.
test('approves a phrase typed in another order and letter case', () => {
  const { pairing } = rig();
  pairing.open('chatnet');
  const code = codeOf(pairing.request({ iface: 'chatnet', native: 'u9' }));
  assert.equal(pairing.approve(`  ${code.split(' ').reverse().join(' ').toUpperCase()} `).kind, 'approved');
});

test('approves no phrase of which five words were typed', () => {
  const { pairing } = rig();
  pairing.open('chatnet');
  const code = codeOf(pairing.request({ iface: 'chatnet', native: 'u9' }));
  assert.equal(pairing.approve(code.split(' ').slice(1).join(' ')).kind, 'wrong');
});

test('a restart keeps the waiting phrase and the open pairing, and never reopens a used phrase', () => {
  const { pairing, restart } = rig();
  pairing.open('chatnet');
  const first = codeOf(pairing.request({ iface: 'chatnet', native: 'u1' }));
  assert.equal(restart().approve(first).kind, 'approved');
  assert.equal(restart().approve(first).kind, 'wrong');
});

test('a restart keeps the lock of five wrong approvals', () => {
  const { pairing, restart } = rig();
  pairing.open('chatnet');
  const code = codeOf(pairing.request({ iface: 'chatnet', native: 'u9' }));
  for (let tries = 0; tries < 5; tries += 1) pairing.approve('WRONGXYZ');
  assert.equal(restart().approve(code).kind, 'locked');
});

test('the state file holds no phrase', () => {
  const { pairing, file } = rig();
  pairing.open('chatnet');
  const code = codeOf(pairing.request({ iface: 'chatnet', native: 'u9' }));
  const kept = fs.readFileSync(file, 'utf8');
  for (const word of code.split(' ')) assert.equal(kept.includes(word), false, word);
});

test('a code approves once', () => {
  const { pairing } = rig();
  pairing.open('chatnet');
  const code = codeOf(pairing.request({ iface: 'chatnet', native: 'u9' }));
  pairing.approve(code);
  assert.equal(pairing.approve(code).kind, 'wrong');
});

test('a code an hour old no longer approves', () => {
  const { pairing, at } = rig();
  pairing.open('chatnet');
  const code = codeOf(pairing.request({ iface: 'chatnet', native: 'u9' }));
  at(60 * MINUTE + 1);
  assert.equal(pairing.approve(code).kind, 'wrong');
});

test('an account that asked within ten minutes gets no second code', () => {
  const { pairing, at } = rig();
  pairing.open('chatnet');
  codeOf(pairing.request({ iface: 'chatnet', native: 'u9' }));
  at(9 * MINUTE);
  assert.equal(pairing.request({ iface: 'chatnet', native: 'u9' }).kind, 'pending');
  at(10 * MINUTE + 1);
  assert.equal(pairing.request({ iface: 'chatnet', native: 'u9' }).kind, 'code');
});

test('a fourth account gets no code while three codes wait on the interface', () => {
  const { pairing } = rig();
  pairing.open('chatnet');
  for (const native of ['u1', 'u2', 'u3']) codeOf(pairing.request({ iface: 'chatnet', native }));
  assert.equal(pairing.request({ iface: 'chatnet', native: 'u4' }).kind, 'full');
});

test('five wrong approvals lock the approvals for an hour, the right code included', () => {
  const { pairing, at } = rig();
  pairing.open('chatnet');
  const code = codeOf(pairing.request({ iface: 'chatnet', native: 'u9' }));
  for (let tries = 0; tries < 5; tries += 1) assert.equal(pairing.approve('WRONGXYZ').kind, 'wrong');
  assert.equal(pairing.approve(code).kind, 'locked');
  at(60 * MINUTE + 1);
  pairing.open('chatnet');
  const fresh = codeOf(pairing.request({ iface: 'chatnet', native: 'u9' }));
  assert.equal(pairing.approve(fresh).kind, 'approved');
});

test('an approval closes pairing on that interface and voids its other codes', () => {
  const { pairing } = rig();
  pairing.open('chatnet');
  const first = codeOf(pairing.request({ iface: 'chatnet', native: 'u1' }));
  const second = codeOf(pairing.request({ iface: 'chatnet', native: 'u2' }));
  pairing.approve(first);
  assert.equal(pairing.approve(second).kind, 'wrong');
  assert.equal(pairing.request({ iface: 'chatnet', native: 'u3' }).kind, 'closed');
});
