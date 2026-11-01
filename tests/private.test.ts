// Tests for src/behavior/private.ts: the private-chat gate, the effective
// affinity view and the public + private profile merge.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { privateGate, effectiveAffinity, mergeProfiles } from '../src/behavior/private.ts';

const TODAY = '2026-09-29';

// PR 7d: the switch is `private.enabled` (it was `features.privateMessages`) and the daily reply caps are gone.
function config({ enabled = true, minAffinity = 5 } = {}) {
  return { private: { enabled, minAffinity } };
}

function profile(score = 10) {
  return { id: 'u1', names: ['Ελένη'], affinity: { score, reason: '', history: [] } };
}

function gate(overrides: Record<string, unknown> = {}) {
  return privateGate({
    config: config(),
    isMember: true,
    profile: profile(),
    isOwner: false,
    // @ts-expect-error `replies` went with the cap; the call still passes it
    replies: { day: TODAY, count: 0 },
    today: TODAY,
    ...overrides,
  });
}

// --- privateGate ---------------------------------------------------------------

// PR 7d: the verdict no longer carries a cap; the rows of the owner cap and of today's replies went with it.
test('privateGate: membership and the attitude decide the verdict, owners skipping the attitude', () => {
  const rows: Array<[string, Record<string, unknown>, object]> = [
    ['a known member above the threshold passes', {}, { ok: true }],
    ['a non-member is refused', { isMember: false }, { ok: false, reason: 'not-member' }],
    ['owners skip the affinity check', { isOwner: true, profile: profile(-80) }, { ok: true }],
  ];
  for (const [label, overrides, expected] of rows) {
    assert.deepEqual(gate(overrides), expected, label);
  }
});

test('privateGate: off unless private.enabled is exactly true', () => {
  assert.deepEqual(gate({ config: config({ enabled: false }) }), { ok: false, reason: 'off' });
  const missing = { private: { minAffinity: 5 } };
  assert.deepEqual(gate({ config: missing }), { ok: false, reason: 'off' });
  assert.deepEqual(gate({ config: { private: { ...config().private, enabled: 'yes' } } }), {
    ok: false,
    reason: 'off',
  });
});

test('privateGate: off wins over every other reason', () => {
  const result = gate({ config: config({ enabled: false }), isMember: false, profile: null });
  assert.deepEqual(result, { ok: false, reason: 'off' });
});

test('privateGate: a member without a stored profile is unknown', () => {
  assert.deepEqual(gate({ profile: null }), { ok: false, reason: 'unknown' });
  assert.deepEqual(gate({ profile: undefined }), { ok: false, reason: 'unknown' });
});

test('privateGate: a score below private.minAffinity is refused, the threshold itself passes', () => {
  assert.deepEqual(gate({ profile: profile(4) }), { ok: false, reason: 'affinity' });
  assert.deepEqual(gate({ profile: profile(4.99) }), { ok: false, reason: 'affinity' });
  // PR 7d: a passing verdict carries no cap.
  assert.deepEqual(gate({ profile: profile(5) }), { ok: true });
});

test('privateGate: a profile without an affinity counts as score 0', () => {
  assert.deepEqual(gate({ profile: { id: 'u1' } }), { ok: false, reason: 'affinity' });
  // PR 7d: a passing verdict carries no cap.
  assert.deepEqual(gate({ profile: { id: 'u1' }, config: config({ minAffinity: 0 }) }), { ok: true });
});

test('privateGate: owners still need membership and a profile', () => {
  assert.deepEqual(gate({ isOwner: true, isMember: false }), { ok: false, reason: 'not-member' });
  assert.deepEqual(gate({ isOwner: true, profile: null }), { ok: false, reason: 'unknown' });
});

// PR 7d: with the caps gone only the threshold can fail closed; an owner passes it.
test('privateGate: a missing private.minAffinity fails closed', () => {
  const bare = { private: { enabled: true } };
  assert.deepEqual(gate({ config: bare }), { ok: false, reason: 'affinity' });
  assert.deepEqual(gate({ config: bare, isOwner: true }), { ok: true });
});

// --- effectiveAffinity ----------------------------------------------------------

test('effectiveAffinity: public plus private, private reason first, no history', () => {
  const view = effectiveAffinity(
    { score: 20, reason: 'public reason', history: [{ delta: 1 }] },
    { score: 7, reason: 'private reason', history: [{ delta: 2 }] }
  );
  assert.deepEqual(view, { score: 27, reason: 'private reason', history: [] });
});

test('effectiveAffinity: falls back to the public reason when the private one is empty', () => {
  const view = effectiveAffinity(
    { score: 20, reason: 'public reason', history: [] },
    { score: -3, reason: '', history: [] }
  );
  assert.deepEqual(view, { score: 17, reason: 'public reason', history: [] });
});

test('effectiveAffinity: the sum is clamped to -100..100', () => {
  assert.equal(effectiveAffinity({ score: 90 }, { score: 40 }).score, 100);
  assert.equal(effectiveAffinity({ score: -90 }, { score: -40 }).score, -100);
});

test('effectiveAffinity: missing or malformed sides count as neutral', () => {
  assert.deepEqual(effectiveAffinity(undefined, null), { score: 0, reason: '', history: [] });
  assert.deepEqual(effectiveAffinity({ score: 12, reason: 'r' }, undefined), { score: 12, reason: 'r', history: [] });
  assert.deepEqual(effectiveAffinity({ score: 'x' }, { score: 3, reason: 5 }), { score: 3, reason: '', history: [] });
});

test('effectiveAffinity: keeps the two-decimal precision of stored scores', () => {
  assert.equal(effectiveAffinity({ score: 12.34 }, { score: 5.67 }).score, 18.01);
});

// --- mergeProfiles ---------------------------------------------------------------

function publicProfile() {
  return {
    id: 'u1',
    names: ['Ελένη', 'Lena'],
    aliases: [{ name: 'Λένα', weight: 2, firstSeen: '2026-08-01T00:00:00.000Z', lastSeen: '2026-09-01T00:00:00.000Z' }],
    character: 'public character',
    style: 'public style',
    messageCount: 420,
    firstSeen: '2026-06-01T00:00:00.000Z',
    lastSeen: '2026-09-28T00:00:00.000Z',
    relationship: 'public relationship',
    interests: [
      {
        topic: 'Chess',
        note: 'public note',
        weight: 3,
        firstSeen: '2026-07-01T00:00:00.000Z',
        lastSeen: '2026-09-01T00:00:00.000Z',
      },
      {
        topic: 'Café',
        note: 'only public',
        weight: 1,
        firstSeen: '2026-07-02T00:00:00.000Z',
        lastSeen: '2026-07-02T00:00:00.000Z',
      },
    ],
    details: [{ id: 1, text: 'public detail', weight: 2, firstSeen: null, lastSeen: null }],
    detailsSeq: 2,
    episodes: [
      { date: '2026-09-10', what: 'public late', quote: '', feeling: '', weight: 3 },
      { date: '2026-07-10', what: 'public early', quote: '', feeling: '', weight: 3 },
    ],
    affinity: { score: 30, reason: 'public reason', history: [{ delta: 5 }] },
  };
}

function privateProfile() {
  return {
    relationship: 'private relationship',
    interests: [
      {
        topic: 'chess',
        note: 'private note',
        weight: 1,
        firstSeen: '2026-09-20T00:00:00.000Z',
        lastSeen: '2026-09-25T00:00:00.000Z',
      },
      {
        topic: 'Poetry',
        note: 'only private',
        weight: 2,
        firstSeen: '2026-09-21T00:00:00.000Z',
        lastSeen: '2026-09-21T00:00:00.000Z',
      },
    ],
    details: [{ id: 1, text: 'private detail', weight: 1, firstSeen: null, lastSeen: null }],
    detailsSeq: 2,
    episodes: [{ date: '2026-08-15', what: 'private middle', quote: '', feeling: '', weight: 4 }],
    affinity: { score: 80, reason: 'private reason', history: [{ delta: 9 }] },
    firstSeen: '2026-09-20T00:00:00.000Z',
    lastSeen: '2026-09-29T00:00:00.000Z',
    replies: { day: TODAY, count: 3, noticedDay: '' },
    buffer: [{ id: 'm1' }],
  };
}

test('mergeProfiles: a null private profile returns the public one unchanged', () => {
  const pub = publicProfile();
  assert.equal(mergeProfiles(pub, null), pub);
  assert.equal(mergeProfiles(pub, undefined), pub);
});

test('mergeProfiles: names, aliases, character, style, counts and dates come from the public profile', () => {
  const merged = mergeProfiles(publicProfile(), privateProfile());
  const pub = publicProfile();
  assert.equal(merged!.id, 'u1');
  assert.deepEqual(merged!.names, pub.names);
  assert.deepEqual(merged!.aliases, pub.aliases);
  assert.equal(merged!.character, 'public character');
  assert.equal(merged!.style, 'public style');
  assert.equal(merged!.messageCount, 420);
  assert.equal(merged!.firstSeen, pub.firstSeen);
  assert.equal(merged!.lastSeen, pub.lastSeen);
});

test('mergeProfiles: private-file bookkeeping never leaks into the merged profile', () => {
  const merged = mergeProfiles(publicProfile(), privateProfile());
  assert.equal('replies' in merged!, false);
  assert.equal('buffer' in merged!, false);
});

test('mergeProfiles: relationship is the public text, then the private text as a second paragraph', () => {
  const merged = mergeProfiles(publicProfile(), privateProfile());
  assert.equal(merged!.relationship, 'public relationship\n\nprivate relationship');
});

test('mergeProfiles: relationship with one side empty is just the other side', () => {
  assert.equal(
    mergeProfiles({ ...publicProfile(), relationship: '' }, privateProfile())!.relationship,
    'private relationship'
  );
  assert.equal(
    mergeProfiles(publicProfile(), { ...privateProfile(), relationship: '' })!.relationship,
    'public relationship'
  );
});

test('mergeProfiles: interests are a union by topic, the private note wins on a shared topic', () => {
  const merged = mergeProfiles(publicProfile(), privateProfile());
  const byTopic = Object.fromEntries(
    merged!.interests.map((item: { topic: string }) => [item.topic.toLowerCase(), item])
  );
  assert.deepEqual(Object.keys(byTopic).sort(), ['café', 'chess', 'poetry']);
  assert.equal(merged!.interests.length, 3);
  assert.deepEqual(byTopic.chess, {
    topic: 'Chess',
    note: 'private note',
    weight: 3,
    firstSeen: '2026-07-01T00:00:00.000Z',
    lastSeen: '2026-09-25T00:00:00.000Z',
  });
  assert.equal(byTopic['café'].note, 'only public');
  assert.equal(byTopic.poetry.note, 'only private');
});

test('mergeProfiles: an empty private note does not erase the public one', () => {
  const priv = {
    ...privateProfile(),
    interests: [{ topic: 'CHESS', note: '', weight: 5, firstSeen: null, lastSeen: null }],
  };
  const chess = mergeProfiles(publicProfile(), priv)!.interests.find(
    (item: { topic: string }) => item.topic === 'Chess'
  );
  assert.equal(chess.note, 'public note');
  assert.equal(chess.weight, 5);
});

test('mergeProfiles: details are public then private', () => {
  const merged = mergeProfiles(publicProfile(), privateProfile());
  assert.deepEqual(
    merged!.details.map((d: { text: string }) => d.text),
    ['public detail', 'private detail']
  );
});

test('mergeProfiles: episodes from both sides, sorted by date', () => {
  const merged = mergeProfiles(publicProfile(), privateProfile());
  assert.deepEqual(
    merged!.episodes.map((e: { what: string }) => e.what),
    ['public early', 'private middle', 'public late']
  );
});

test('mergeProfiles: affinity is the clamped effective view', () => {
  const merged = mergeProfiles(publicProfile(), privateProfile());
  assert.deepEqual(merged!.affinity, { score: 100, reason: 'private reason', history: [] });
});

test('mergeProfiles: never mutates either input', () => {
  const pub = publicProfile();
  const priv = privateProfile();
  mergeProfiles(pub, priv);
  assert.deepEqual(pub, publicProfile());
  assert.deepEqual(priv, privateProfile());
});

test('mergeProfiles: tolerates missing lists on either side', () => {
  const merged = mergeProfiles({ id: 'u1', names: ['Zoé'] }, { relationship: 'private relationship' });
  assert.deepEqual(merged!.interests, []);
  assert.deepEqual(merged!.details, []);
  assert.deepEqual(merged!.episodes, []);
  assert.equal(merged!.relationship, 'private relationship');
  assert.deepEqual(merged!.affinity, { score: 0, reason: '', history: [] });
});

// PR 7d: privateRepliesToday went with the per-person daily caps, and its two tests with it.

// PR 7d: the per-person daily caps are gone. The switch lives at `private.enabled`; `features.privateMessages` and the
// stale caps are what a local layer not yet cut still holds.
test('privateGate: a member and an owner far past the old daily counts still get their turn', () => {
  const stale = {
    features: { privateMessages: true },
    private: { enabled: true, minAffinity: 5, maxPerUserPerDay: 20, maxPerOwnerPerDay: 200 },
  };
  const member = gate({ config: stale, replies: { day: TODAY, count: 50 } });
  const owner = gate({ config: stale, isOwner: true, replies: { day: TODAY, count: 500 } });
  assert.deepEqual([member.ok, owner.ok], [true, true]);
});

test('privateGate: the private.enabled switch off refuses a DM', () => {
  const off = { private: { enabled: false, minAffinity: 5 }, features: { privateMessages: true } };
  assert.deepEqual(gate({ config: off }), { ok: false, reason: 'off' });
});
