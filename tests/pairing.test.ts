// The one-time codes of pairing (src/interface/pairing.ts), by the rules of Hermes's gateway/pairing.py: a code of
// eight characters from an alphabet with no look-alikes, alive one hour, at most three waiting per interface, one
// request per account per ten minutes, and five wrong approvals lock the approvals for an hour. A code is asked only
// while the owner opened pairing on that interface. Injected clock and randomness, no I/O.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CODE_ALPHABET, createPairing } from '../src/interface/pairing.ts';
import type { CodeRequest, Pairing } from '../src/interface/pairing.ts';

const MINUTE = 60_000;
const START = Date.parse('2026-11-08T12:00:00Z');

/** A pairing over a clock the test moves and a counter for randomness, so every code differs. */
function rig(): { pairing: Pairing; at: (ms: number) => void } {
  let now = START;
  let turn = 0;
  const rng = (): number => {
    turn += 1;
    return ((turn * 7919) % 1000) / 1000;
  };
  return { pairing: createPairing({ now: () => now, rng }), at: (ms) => (now = START + ms) };
}

function codeOf(request: CodeRequest): string {
  assert.equal(request.kind, 'code');
  return request.kind === 'code' ? request.code : '';
}

test('gives an eight-character code of the unambiguous alphabet when pairing is open', () => {
  const { pairing } = rig();
  pairing.open('chatnet');
  const code = codeOf(pairing.request({ iface: 'chatnet', native: 'u9' }));
  assert.equal(code.length, 8);
  assert.ok(
    [...code].every((one) => CODE_ALPHABET.includes(one)),
    code
  );
  assert.equal(/[01IO]/.test(CODE_ALPHABET), false);
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

test('approves a code typed in lower case with spaces around it', () => {
  const { pairing } = rig();
  pairing.open('chatnet');
  const code = codeOf(pairing.request({ iface: 'chatnet', native: 'u9' }));
  assert.equal(pairing.approve(`  ${code.toLowerCase()} `).kind, 'approved');
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
