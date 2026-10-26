// Tests for src/behavior/private.js: the private-chat gate, the effective
// affinity view and the public + private profile merge.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { privateGate, privateRepliesToday, effectiveAffinity, mergeProfiles } from '../src/behavior/private.js';

const TODAY = '2026-09-29';

function config({ privateMessages = true, minAffinity = 5, maxPerUserPerDay = 100, maxPerOwnerPerDay = 200 } = {}) {
  return {
    features: { privateMessages },
    private: { minAffinity, maxPerUserPerDay, maxPerOwnerPerDay },
  };
}

function profile(score = 10) {
  return { id: 'u1', names: ['Ελένη'], affinity: { score, reason: '', history: [] } };
}

function gate(overrides = {}) {
  return privateGate({
    config: config(),
    isMember: true,
    profile: profile(),
    isOwner: false,
    replies: { day: TODAY, count: 0 },
    today: TODAY,
    ...overrides,
  });
}

// --- privateGate ---------------------------------------------------------------

test("privateGate: membership, the owner cap and today's replies decide the verdict", () => {
  const owner = { isOwner: true };
  const rows = [
    ['a known member above the threshold passes, with the member cap', {}, { ok: true, cap: 100 }],
    ['a non-member is refused', { isMember: false }, { ok: false, reason: 'not-member' }],
    [
      'owners skip the affinity check and get the owner cap',
      { ...owner, profile: profile(-80) },
      { ok: true, cap: 200 },
    ],
    [
      'the owner cap is checked for owners: 150 of 200 passes',
      { ...owner, replies: { day: TODAY, count: 150 } },
      { ok: true, cap: 200 },
    ],
    [
      'the owner cap is checked for owners: 200 of 200 is refused',
      { ...owner, replies: { day: TODAY, count: 200 } },
      { ok: false, reason: 'cap', cap: 200, used: 200 },
    ],
    [
      'replies from another day count as 0 (day rollover)',
      { replies: { day: '2026-09-28', count: 100 } },
      { ok: true, cap: 100 },
    ],
    ['missing replies count as 0', { replies: undefined }, { ok: true, cap: 100 }],
    ['a malformed count counts as 0', { replies: { day: TODAY, count: 'many' } }, { ok: true, cap: 100 }],
  ];
  for (const [label, overrides, expected] of rows) {
    assert.deepEqual(gate(overrides), expected, label);
  }
});

test('privateGate: off unless features.privateMessages is exactly true', () => {
  assert.deepEqual(gate({ config: config({ privateMessages: false }) }), { ok: false, reason: 'off' });
  const missing = { private: config().private, features: {} };
  assert.deepEqual(gate({ config: missing }), { ok: false, reason: 'off' });
  assert.deepEqual(gate({ config: { ...config(), features: { privateMessages: 'yes' } } }), {
    ok: false,
    reason: 'off',
  });
});

test('privateGate: off wins over every other reason', () => {
  const result = gate({ config: config({ privateMessages: false }), isMember: false, profile: null });
  assert.deepEqual(result, { ok: false, reason: 'off' });
});

test('privateGate: a member without a stored profile is unknown', () => {
  assert.deepEqual(gate({ profile: null }), { ok: false, reason: 'unknown' });
  assert.deepEqual(gate({ profile: undefined }), { ok: false, reason: 'unknown' });
});

test('privateGate: a score below private.minAffinity is refused, the threshold itself passes', () => {
  assert.deepEqual(gate({ profile: profile(4) }), { ok: false, reason: 'affinity' });
  assert.deepEqual(gate({ profile: profile(4.99) }), { ok: false, reason: 'affinity' });
  assert.deepEqual(gate({ profile: profile(5) }), { ok: true, cap: 100 });
});

test('privateGate: a profile without an affinity counts as score 0', () => {
  assert.deepEqual(gate({ profile: { id: 'u1' } }), { ok: false, reason: 'affinity' });
  assert.deepEqual(gate({ profile: { id: 'u1' }, config: config({ minAffinity: 0 }) }), { ok: true, cap: 100 });
});

test('privateGate: owners still need membership and a profile', () => {
  assert.deepEqual(gate({ isOwner: true, isMember: false }), { ok: false, reason: 'not-member' });
  assert.deepEqual(gate({ isOwner: true, profile: null }), { ok: false, reason: 'unknown' });
});

test('privateGate: the cap boundary -- one below passes, at the cap is refused with the numbers', () => {
  assert.deepEqual(gate({ replies: { day: TODAY, count: 99 } }), { ok: true, cap: 100 });
  assert.deepEqual(gate({ replies: { day: TODAY, count: 100 } }), { ok: false, reason: 'cap', cap: 100, used: 100 });
  assert.deepEqual(gate({ replies: { day: TODAY, count: 150 } }), { ok: false, reason: 'cap', cap: 100, used: 150 });
});

test('privateGate: missing private.* numbers fail closed', () => {
  const bare = { features: { privateMessages: true } };
  assert.deepEqual(gate({ config: bare }), { ok: false, reason: 'affinity' });
  assert.deepEqual(gate({ config: bare, isOwner: true }), { ok: false, reason: 'cap', cap: 0, used: 0 });
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
  assert.equal(merged.id, 'u1');
  assert.deepEqual(merged.names, pub.names);
  assert.deepEqual(merged.aliases, pub.aliases);
  assert.equal(merged.character, 'public character');
  assert.equal(merged.style, 'public style');
  assert.equal(merged.messageCount, 420);
  assert.equal(merged.firstSeen, pub.firstSeen);
  assert.equal(merged.lastSeen, pub.lastSeen);
});

test('mergeProfiles: private-file bookkeeping never leaks into the merged profile', () => {
  const merged = mergeProfiles(publicProfile(), privateProfile());
  assert.equal('replies' in merged, false);
  assert.equal('buffer' in merged, false);
});

test('mergeProfiles: relationship is the public text, then the private text as a second paragraph', () => {
  const merged = mergeProfiles(publicProfile(), privateProfile());
  assert.equal(merged.relationship, 'public relationship\n\nprivate relationship');
});

test('mergeProfiles: relationship with one side empty is just the other side', () => {
  assert.equal(
    mergeProfiles({ ...publicProfile(), relationship: '' }, privateProfile()).relationship,
    'private relationship'
  );
  assert.equal(
    mergeProfiles(publicProfile(), { ...privateProfile(), relationship: '' }).relationship,
    'public relationship'
  );
});

test('mergeProfiles: interests are a union by topic, the private note wins on a shared topic', () => {
  const merged = mergeProfiles(publicProfile(), privateProfile());
  const byTopic = Object.fromEntries(merged.interests.map((item) => [item.topic.toLowerCase(), item]));
  assert.deepEqual(Object.keys(byTopic).sort(), ['café', 'chess', 'poetry']);
  assert.equal(merged.interests.length, 3);
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
  const chess = mergeProfiles(publicProfile(), priv).interests.find((item) => item.topic === 'Chess');
  assert.equal(chess.note, 'public note');
  assert.equal(chess.weight, 5);
});

test('mergeProfiles: details are public then private', () => {
  const merged = mergeProfiles(publicProfile(), privateProfile());
  assert.deepEqual(
    merged.details.map((d) => d.text),
    ['public detail', 'private detail']
  );
});

test('mergeProfiles: episodes from both sides, sorted by date', () => {
  const merged = mergeProfiles(publicProfile(), privateProfile());
  assert.deepEqual(
    merged.episodes.map((e) => e.what),
    ['public early', 'private middle', 'public late']
  );
});

test('mergeProfiles: affinity is the clamped effective view', () => {
  const merged = mergeProfiles(publicProfile(), privateProfile());
  assert.deepEqual(merged.affinity, { score: 100, reason: 'private reason', history: [] });
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
  assert.deepEqual(merged.interests, []);
  assert.deepEqual(merged.details, []);
  assert.deepEqual(merged.episodes, []);
  assert.equal(merged.relationship, 'private relationship');
  assert.deepEqual(merged.affinity, { score: 0, reason: '', history: [] });
});

test('privateRepliesToday: the owner or member cap, a missing cap as 0, another day as no replies', () => {
  assert.deepEqual(
    privateRepliesToday({ config: config(), isOwner: false, replies: { day: TODAY, count: 7 }, today: TODAY }),
    { used: 7, cap: 100 }
  );
  assert.deepEqual(
    privateRepliesToday({ config: config(), isOwner: true, replies: { day: TODAY, count: 7 }, today: TODAY }),
    { used: 7, cap: 200 }
  );
  assert.deepEqual(
    privateRepliesToday({ config: config(), isOwner: false, replies: { day: '2026-09-28', count: 7 }, today: TODAY }),
    { used: 0, cap: 100 }
  );
  assert.deepEqual(privateRepliesToday({ config: {}, isOwner: false, replies: null, today: TODAY }), {
    used: 0,
    cap: 0,
  });
});

test('privateRepliesToday: a stored count that is not a finite number >= 0 reads as 0, and the replies are never written', () => {
  for (const bad of [-3, NaN, Infinity, '150', null, {}]) {
    const replies = { day: TODAY, count: bad };
    assert.deepEqual(
      privateRepliesToday({ config: config(), isOwner: false, replies, today: TODAY }),
      { used: 0, cap: 100 },
      String(bad)
    );
  }
  const stale = { day: '2026-09-28', count: 7, noticedDay: '2026-09-28' };
  privateRepliesToday({ config: config(), isOwner: false, replies: stale, today: TODAY });
  assert.deepEqual(stale, { day: '2026-09-28', count: 7, noticedDay: '2026-09-28' }, 'a read never rolls the day over');
});
