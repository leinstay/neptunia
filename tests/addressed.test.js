// Tests for src/memory/addressed.js: which names people actually use for a member -- the
// candidates (names shared by two members or under 3 letters left out), the per-message count
// (never the author's own line, never inside a URL or code), the decayed score and its cap.
// Pure, no I/O.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addressCandidates,
  applyAddressUses,
  countAddressUses,
  decayedScore,
  normalizeAddressedAs,
  rankAddressed,
} from '../src/memory/addressed.js';

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 8, 1, 12, 0, 0);
const ANA = '100000000000000001';
const NIKOS = '100000000000000002';
const BJORN = '100000000000000003';

function msg(authorId, content, ts = T0, extra = {}) {
  return { id: `m${ts}${authorId}`, authorId, content, ts, self: false, ...extra };
}

test('applyAddressUses: two uses 30 days apart with a 30-day half-life leave a score of 1.5', () => {
  const first = applyAddressUses(undefined, [{ name: 'Léo', at: T0 }], { halfLifeDays: 30 });
  assert.deepEqual(first, { Léo: { score: 1, last: new Date(T0).toISOString() } });
  const second = applyAddressUses(first, [{ name: 'Léo', at: T0 + 30 * DAY }], { halfLifeDays: 30 });
  assert.equal(second['Léo'].score, 1.5);
  assert.equal(second['Léo'].last, new Date(T0 + 30 * DAY).toISOString());
});

test('applyAddressUses: a name matches a stored key case-insensitively and keeps the stored spelling', () => {
  const stored = { Léo: { score: 2, last: new Date(T0).toISOString() } };
  const next = applyAddressUses(stored, [{ name: 'LÉO', at: T0 }], { halfLifeDays: 30 });
  assert.deepEqual(Object.keys(next), ['Léo']);
  assert.equal(next['Léo'].score, 3);
});

test('applyAddressUses: a use older than the last one adds its decayed weight and keeps the last date', () => {
  const stored = { Léo: { score: 1, last: new Date(T0 + 30 * DAY).toISOString() } };
  const next = applyAddressUses(stored, [{ name: 'Léo', at: T0 }], { halfLifeDays: 30 });
  assert.equal(next['Léo'].score, 1.5);
  assert.equal(next['Léo'].last, new Date(T0 + 30 * DAY).toISOString());
});

test('applyAddressUses: keeps at most 12 names, dropping the lowest decayed score', () => {
  let map = {};
  for (let i = 0; i < 12; i += 1) {
    const uses = Array.from({ length: i + 2 }, () => ({ name: `name${String.fromCharCode(97 + i)}`, at: T0 }));
    map = applyAddressUses(map, uses, { halfLifeDays: 30 });
  }
  map = applyAddressUses(map, [{ name: 'newcomer', at: T0 }], { halfLifeDays: 30 });
  assert.equal(Object.keys(map).length, 12);
  // The newcomer's single use is the lowest score: it is the one that goes.
  assert.ok(!('newcomer' in map));
  assert.ok('namea' in map);
});

test('applyAddressUses: the cap drops the name whose decayed score is lowest now', () => {
  const map = {};
  for (let i = 0; i < 12; i += 1)
    map[`name${String.fromCharCode(97 + i)}`] = { score: 5, last: new Date(T0 + 100 * DAY).toISOString() };
  // An old name with a high raw score decays below the newcomer's single use.
  map.ancient = { score: 4, last: new Date(T0).toISOString() };
  const next = applyAddressUses(map, [{ name: 'fresh', at: T0 + 100 * DAY }], { halfLifeDays: 30, max: 13 });
  assert.equal(Object.keys(next).length, 13);
  assert.ok(!('ancient' in next));
  assert.ok('fresh' in next);
});

test('decayedScore / rankAddressed: order by the score decayed to now, names only', () => {
  const map = {
    Léo: { score: 4, last: new Date(T0).toISOString() },
    Vova: { score: 3, last: new Date(T0 + 60 * DAY).toISOString() },
    Sus: { score: 0.5, last: new Date(T0 + 60 * DAY).toISOString() },
  };
  assert.equal(decayedScore(map['Léo'], T0 + 60 * DAY, 30), 1);
  assert.deepEqual(rankAddressed(map, T0 + 60 * DAY, 30), ['Vova', 'Léo', 'Sus']);
  assert.deepEqual(rankAddressed(undefined, T0, 30), []);
});

test('normalizeAddressedAs: keeps valid entries, drops broken ones, garbage becomes {}', () => {
  const last = new Date(T0).toISOString();
  assert.deepEqual(
    normalizeAddressedAs({
      Léo: { score: 2, last },
      bad: { score: 'x', last },
      worse: 3,
      nodate: { score: 1, last: 'never' },
    }),
    { Léo: { score: 2, last } }
  );
  assert.deepEqual(normalizeAddressedAs([1, 2]), {});
  assert.deepEqual(normalizeAddressedAs('x'), {});
});

test('addressCandidates: display names and open aliases; a shared name and a short one are left out', () => {
  const candidates = addressCandidates([
    {
      id: ANA,
      names: ['Anaïs', 'Al'],
      aliases: [{ name: 'Nana' }, { name: 'Old', validTo: '2026-01-01' }, { name: 'Kiki' }],
    },
    { id: NIKOS, names: ['Nikos'], aliases: [{ name: 'kiki' }] },
  ]);
  const byId = Object.fromEntries(candidates.map((c) => [c.userId, c.names]));
  assert.deepEqual(byId[ANA], ['Anaïs', 'Nana']);
  assert.deepEqual(byId[NIKOS], ['Nikos']);
});

test('countAddressUses: a name of another member counts for that member, not for the author', () => {
  const candidates = addressCandidates([
    { id: ANA, names: ['Anaïs'], aliases: [] },
    { id: NIKOS, names: ['Nikos'], aliases: [{ name: 'Niko' }] },
  ]);
  const uses = countAddressUses([msg(ANA, 'niko, come here'), msg(NIKOS, 'yes Anaïs')], candidates);
  assert.deepEqual(uses.get(NIKOS), [{ name: 'Niko', at: T0 }]);
  assert.deepEqual(uses.get(ANA), [{ name: 'Anaïs', at: T0 }]);
});

test("countAddressUses: the member's own message never counts for him", () => {
  const candidates = addressCandidates([{ id: NIKOS, names: ['Nikos'], aliases: [] }]);
  const uses = countAddressUses([msg(NIKOS, 'Nikos is here')], candidates);
  assert.equal(uses.get(NIKOS), undefined);
});

test('countAddressUses: a name shared by two members counts for neither', () => {
  const candidates = addressCandidates([
    { id: ANA, names: ['Anaïs'], aliases: [{ name: 'Kiki' }] },
    { id: NIKOS, names: ['Nikos'], aliases: [{ name: 'Kiki' }] },
  ]);
  const uses = countAddressUses([msg(BJORN, 'kiki?')], candidates);
  assert.equal(uses.size, 0);
});

test('countAddressUses: a name inside a URL, inline code or a code block does not count', () => {
  const candidates = addressCandidates([{ id: NIKOS, names: ['Nikos'], aliases: [] }]);
  const uses = countAddressUses(
    [msg(ANA, 'look https://example.com/nikos/page'), msg(ANA, 'run `nikos --help`'), msg(ANA, '```\nnikos()\n```')],
    candidates
  );
  assert.equal(uses.size, 0);
});

test('countAddressUses: a ping (@DisplayName) is not a use of the name', () => {
  const candidates = addressCandidates([{ id: NIKOS, names: ['Nikos'], aliases: [] }]);
  assert.equal(countAddressUses([msg(ANA, '@Nikos look')], candidates).size, 0);
});

test("countAddressUses: an inflected form counts by its stem; the persona's own line counts too", () => {
  const candidates = addressCandidates([{ id: NIKOS, names: ['Nikolaos'], aliases: [] }]);
  const uses = countAddressUses([msg('999', 'thanks Nikolaou', T0 + 5, { self: true })], candidates);
  assert.deepEqual(uses.get(NIKOS), [{ name: 'Nikolaos', at: T0 + 5 }]);
});

test('countAddressUses: a name written out exactly is not also counted as the stem of a longer name', () => {
  const candidates = addressCandidates([{ id: NIKOS, names: ['Nikos'], aliases: [{ name: 'Niko' }] }]);
  assert.deepEqual(countAddressUses([msg(ANA, 'niko!')], candidates).get(NIKOS), [{ name: 'Niko', at: T0 }]);
  assert.deepEqual(countAddressUses([msg(ANA, 'nikosaki!')], candidates).get(NIKOS), [{ name: 'Nikos', at: T0 }]);
});

test('countAddressUses: one message counts a name once', () => {
  const candidates = addressCandidates([{ id: NIKOS, names: ['Nikos'], aliases: [] }]);
  const uses = countAddressUses([msg(ANA, 'Nikos, Nikos, Nikos!')], candidates);
  assert.deepEqual(uses.get(NIKOS), [{ name: 'Nikos', at: T0 }]);
});
