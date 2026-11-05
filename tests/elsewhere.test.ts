// Tests for src/behavior/elsewhere.ts: the pure core of speaking in the main
// channel about a channel the persona cannot write in -- the settle wait, the
// ring of calls, the per-channel seen mark, the audience comparison, the
// destination pick and the jump link. No I/O; the clock is passed in.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  audienceCovers,
  markPingAnswered,
  markPingSkipped,
  markSeen,
  messageLink,
  pingStatus,
  pingsIn,
  recordPing,
  settleDueAt,
  stampPings,
} from '../src/behavior/elsewhere.ts';
import type { Untyped } from '../src/tools/types.ts';

const NOW = Date.UTC(2026, 9, 5, 12, 0, 0);
const SEC = 1000;
const MIN = 60_000;
const DAY = 24 * 60 * MIN;

/** An audience record: who can view one channel. */
function audience({
  everyone = false,
  roles = [],
  roleAllow = [],
  roleDeny = [],
  memberAllow = [],
  memberDeny = [],
  memberRoles = null,
}: {
  everyone?: boolean;
  roles?: Array<string>;
  roleAllow?: Array<string>;
  roleDeny?: Array<string>;
  memberAllow?: Array<string>;
  memberDeny?: Array<string>;
  memberRoles?: Record<string, Array<string>> | null;
} = {}) {
  return {
    everyone,
    roles: new Set(roles),
    roleAllow: new Set(roleAllow),
    roleDeny: new Set(roleDeny),
    memberAllow: new Set(memberAllow),
    memberDeny: new Set(memberDeny),
    ...(memberRoles
      ? { memberRoles: new Map(Object.entries(memberRoles).map(([id, held]) => [id, new Set(held)])) }
      : {}),
  };
}

const RING_OPTS = { cap: 20, maxAgeMs: 7 * DAY, now: NOW };

// ---- settings -------------------------------------------------------------------

// ---- settle -----------------------------------------------------------------------

test('settleDueAt: a new message pushes the due time by settleMs', () => {
  const firstAt = NOW;
  assert.equal(settleDueAt({ firstAt, lastAt: firstAt, settleMs: 90 * SEC, maxMs: 300 * SEC }), NOW + 90 * SEC);
  assert.equal(
    settleDueAt({ firstAt, lastAt: firstAt + 60 * SEC, settleMs: 90 * SEC, maxMs: 300 * SEC }),
    NOW + 150 * SEC
  );
});

test('settleDueAt: never later than firstAt plus maxMs', () => {
  const firstAt = NOW;
  assert.equal(
    settleDueAt({ firstAt, lastAt: firstAt + 280 * SEC, settleMs: 90 * SEC, maxMs: 300 * SEC }),
    NOW + 300 * SEC
  );
  assert.equal(
    settleDueAt({ firstAt, lastAt: firstAt, settleMs: 90 * SEC, maxMs: 30 * SEC }),
    NOW + 30 * SEC,
    'a max below the settle caps it'
  );
  assert.equal(
    settleDueAt({ firstAt, lastAt: firstAt + 5 * SEC, settleMs: 0, maxMs: 300 * SEC }),
    NOW + 5 * SEC,
    'no settle acts at the last message'
  );
});

test('settleDueAt: a missing lastAt counts from firstAt', () => {
  assert.equal(settleDueAt({ firstAt: NOW, settleMs: 90 * SEC, maxMs: 300 * SEC }), NOW + 90 * SEC);
  assert.equal(settleDueAt({ firstAt: NOW, lastAt: Number.NaN, settleMs: 90 * SEC, maxMs: 300 * SEC }), NOW + 90 * SEC);
});

// ---- the ring of calls ----------------------------------------------------------------

test('recordPing: a new entry is unanswered and unskipped, the stored ring is not mutated', () => {
  const ring: Array<Untyped> = [];
  const next = recordPing(ring, { messageId: 'm1', placeId: 'src', ts: NOW - MIN }, RING_OPTS);
  assert.deepEqual(ring, []);
  assert.deepEqual(next, [{ messageId: 'm1', placeId: 'src', ts: NOW - MIN, answeredAt: null, skippedAt: null }]);
  assert.equal(pingStatus(next[0]), 'unanswered');
});

test('recordPing: keeps the newest cap entries and drops expired ones', () => {
  let ring: ReturnType<typeof recordPing> = [
    { messageId: 'old', placeId: 'src', ts: NOW - 8 * DAY, answeredAt: null, skippedAt: null },
  ];
  for (let i = 1; i <= 4; i += 1) {
    ring = recordPing(
      ring,
      { messageId: `m${i}`, placeId: 'src', ts: NOW - (10 - i) * MIN },
      { cap: 3, maxAgeMs: 7 * DAY, now: NOW }
    );
  }
  assert.deepEqual(
    ring.map((p) => p.messageId),
    ['m2', 'm3', 'm4'],
    'oldest first, the expired one and the oldest beyond the cap gone'
  );
  const tooOld = recordPing([], { messageId: 'x', placeId: 'src', ts: NOW - 8 * DAY }, RING_OPTS);
  assert.deepEqual(tooOld, [], 'a call already past its lifetime is never recorded');
  const older = recordPing(
    ring,
    { messageId: 'early', placeId: 'src', ts: NOW - 60 * MIN },
    { cap: 3, maxAgeMs: 7 * DAY, now: NOW }
  );
  assert.deepEqual(
    older.map((p) => p.messageId),
    ['m2', 'm3', 'm4'],
    'an older call than the whole full ring does not push out a newer one'
  );
  assert.deepEqual(
    recordPing(ring, { messageId: 'm5', placeId: 'src', ts: NOW }, { cap: 0, maxAgeMs: 7 * DAY, now: NOW }),
    [],
    'a cap of 0 keeps nothing'
  );
});

test('recordPing: an expired stored entry is dropped in a ring below its cap', () => {
  const stale = { messageId: 'old', placeId: 'src', ts: NOW - 8 * DAY, answeredAt: null, skippedAt: null };
  const ring = recordPing([stale], { messageId: 'm1', placeId: 'src', ts: NOW }, RING_OPTS);
  assert.deepEqual(
    ring.map((p) => p.messageId),
    ['m1'],
    'only the lifetime removes it: the cap of 20 is far away'
  );
  const edge = { messageId: 'edge', placeId: 'src', ts: NOW - 7 * DAY, answeredAt: null, skippedAt: null };
  assert.deepEqual(
    recordPing([edge], { messageId: 'm1', placeId: 'src', ts: NOW }, RING_OPTS).map((p) => p.messageId),
    ['edge', 'm1'],
    'a call exactly pingMaxAgeDays old is kept'
  );
});

test('recordPing: a pingMaxAgeDays of 0 keeps calls of any age', () => {
  const ring = recordPing(
    [{ messageId: 'old', placeId: 'src', ts: NOW - 400 * DAY, answeredAt: null, skippedAt: null }],
    { messageId: 'm1', placeId: 'src', ts: NOW },
    { cap: 20, maxAgeMs: 0, now: NOW }
  );
  assert.deepEqual(
    ring.map((p) => p.messageId),
    ['old', 'm1']
  );
});

test('recordPing: one entry per message id, the first record and its state kept', () => {
  let ring = recordPing([], { messageId: 'm1', placeId: 'src', ts: NOW - 2 * MIN }, RING_OPTS);
  ring = markPingAnswered(ring, 'm1', NOW - MIN);
  ring = recordPing(ring, { messageId: 'm1', placeId: 'src', ts: NOW - MIN }, RING_OPTS);
  assert.equal(ring.length, 1);
  assert.equal(ring[0].ts, NOW - 2 * MIN);
  assert.equal(ring[0].answeredAt, NOW - MIN);
});

test('recordPing: garbage in the stored ring or the new call is dropped, never thrown on', () => {
  const stored = [
    null,
    'm0',
    { messageId: 'm1' },
    { messageId: 'm2', placeId: 'src', ts: NOW - MIN, answeredAt: 'yes', skippedAt: null },
    { messageId: 'm4', placeId: 'src', ts: NOW - MIN, answeredAt: null, skippedAt: 'yes' },
  ];
  const ring = recordPing(stored, { messageId: '', placeId: 'src', ts: NOW }, RING_OPTS);
  assert.deepEqual(ring, [
    { messageId: 'm2', placeId: 'src', ts: NOW - MIN, answeredAt: null, skippedAt: null },
    { messageId: 'm4', placeId: 'src', ts: NOW - MIN, answeredAt: null, skippedAt: null },
  ]);
  assert.equal(pingStatus(ring[1]), 'unanswered', 'a garbage skip stamp is no skip');
  assert.deepEqual(
    recordPing(undefined, { messageId: 'm3', placeId: 'src', ts: NOW }, RING_OPTS).map((p) => p.messageId),
    ['m3']
  );
});

test('markPingAnswered: stamps that entry only and keeps the first stamp', () => {
  let ring: Array<Untyped> = [];
  ring = recordPing(ring, { messageId: 'm1', placeId: 'src', ts: NOW - 3 * MIN }, RING_OPTS);
  ring = recordPing(ring, { messageId: 'm2', placeId: 'src', ts: NOW - 2 * MIN }, RING_OPTS);
  const before = ring;
  ring = markPingAnswered(ring, 'm2', NOW - MIN);
  assert.equal(before[1].answeredAt, null, 'the input ring is not mutated');
  assert.equal(ring[0].answeredAt, null);
  assert.equal(ring[1].answeredAt, NOW - MIN);
  ring = markPingAnswered(ring, 'm2', NOW);
  assert.equal(ring[1].answeredAt, NOW - MIN);
  assert.deepEqual(markPingAnswered(ring, 'unknown', NOW), ring);
});

test('markPingSkipped: a call the persona chose to skip is skipped, not unanswered', () => {
  let ring = recordPing([], { messageId: 'm1', placeId: 'src', ts: NOW - 2 * MIN }, RING_OPTS);
  ring = markPingSkipped(ring, 'm1', NOW - MIN);
  assert.equal(ring[0].skippedAt, NOW - MIN);
  assert.equal(pingStatus(ring[0]), 'skipped');
  ring = markPingSkipped(ring, 'm1', NOW);
  assert.equal(ring[0].skippedAt, NOW - MIN, 'the first skip is kept');
});

test('markPingSkipped: an answered call stays answered; a later answer wins over a skip', () => {
  let answered = recordPing([], { messageId: 'm1', placeId: 'src', ts: NOW - 2 * MIN }, RING_OPTS);
  answered = markPingSkipped(markPingAnswered(answered, 'm1', NOW - MIN), 'm1', NOW);
  assert.equal(answered[0].skippedAt, null);
  assert.equal(pingStatus(answered[0]), 'answered');
  let skipped = recordPing([], { messageId: 'm2', placeId: 'src', ts: NOW - 2 * MIN }, RING_OPTS);
  skipped = markPingAnswered(markPingSkipped(skipped, 'm2', NOW - MIN), 'm2', NOW);
  assert.equal(pingStatus(skipped[0]), 'answered');
});

test('stampPings: stamps each call in order and reports only the ones whose state changed', () => {
  let ring: Array<Untyped> = [];
  for (const id of ['a', 's', 'u', 'w'])
    ring = recordPing(ring, { messageId: id, placeId: 'src', ts: NOW - 2 * MIN }, RING_OPTS);
  ring = markPingSkipped(markPingAnswered(ring, 'a', NOW - MIN), 's', NOW - MIN);
  const before = ring;

  const { ring: next, marked } = stampPings(
    ring,
    [
      { messageId: 'a', status: 'skipped' },
      { messageId: 's', status: 'answered' },
      { messageId: 'u', status: 'skipped' },
      { messageId: 'u', status: 'answered' },
      { messageId: 'w', status: 'skipped' },
      { messageId: 'w', status: 'skipped' },
      { messageId: 'unknown', status: 'answered' },
    ],
    NOW
  );

  assert.deepEqual(
    marked,
    [
      { messageId: 's', placeId: 'src', status: 'answered' },
      { messageId: 'u', placeId: 'src', status: 'skipped' },
      { messageId: 'u', placeId: 'src', status: 'answered' },
      { messageId: 'w', placeId: 'src', status: 'skipped' },
    ],
    'an answered call is never skipped, an answer wins over a skip, a repeat changes nothing, an unknown id is passed over'
  );
  assert.deepEqual(
    next.map((p) => [p.messageId, pingStatus(p)]),
    [
      ['a', 'answered'],
      ['s', 'answered'],
      ['u', 'answered'],
      ['w', 'skipped'],
    ]
  );
  assert.deepEqual(
    [next[1].skippedAt, next[1].answeredAt, next[3].skippedAt],
    [NOW - MIN, NOW, NOW],
    'earlier stamps are kept'
  );
  assert.equal(pingStatus(before[2]), 'unanswered', 'the stored ring is not mutated');
});

test('stampPings: no stamp, an unknown status or garbage changes nothing and never throws', () => {
  const ring = recordPing([], { messageId: 'm1', placeId: 'src', ts: NOW - MIN }, RING_OPTS);
  assert.deepEqual(stampPings(ring, [], NOW), { ring, marked: [] });
  assert.deepEqual(
    stampPings(ring, [{ messageId: 'm1', status: 'seen' }, null, { status: 'skipped' }], NOW).marked,
    []
  );
  assert.deepEqual(stampPings(undefined, [{ messageId: 'm1', status: 'skipped' }], NOW), { ring: [], marked: [] });
  assert.deepEqual(stampPings(ring, undefined, NOW).marked, []);
});

test('pingsIn: only this channel, only unexpired, oldest first', () => {
  const ring = [
    { messageId: 'b', placeId: 'src', ts: NOW - 2 * MIN, answeredAt: null, skippedAt: null },
    { messageId: 'a', placeId: 'src', ts: NOW - 5 * MIN, answeredAt: NOW - MIN, skippedAt: null },
    { messageId: 'x', placeId: 'other', ts: NOW - 3 * MIN, answeredAt: null, skippedAt: null },
    { messageId: 'gone', placeId: 'src', ts: NOW - 8 * DAY, answeredAt: null, skippedAt: null },
  ];
  assert.deepEqual(
    pingsIn(ring, 'src', { now: NOW, maxAgeMs: 7 * DAY }).map((p) => p.messageId),
    ['a', 'b']
  );
  assert.deepEqual(
    pingsIn(ring, 'src', { now: NOW, maxAgeMs: 0 }).map((p) => p.messageId),
    ['gone', 'a', 'b'],
    'no age limit'
  );
  assert.deepEqual(pingsIn(undefined, 'src', { now: NOW, maxAgeMs: 7 * DAY }), []);
});

// ---- seen marks ---------------------------------------------------------------------

test('markSeen: never moves backwards and never mutates the stored map', () => {
  const seen = { src: NOW - 5 * MIN };
  const later = markSeen(seen, 'src', NOW - MIN);
  assert.deepEqual(seen, { src: NOW - 5 * MIN });
  assert.deepEqual(later, { src: NOW - MIN });
  assert.deepEqual(markSeen(later, 'src', NOW - 10 * MIN), { src: NOW - MIN });
  assert.deepEqual(markSeen(later, 'other', NOW), { src: NOW - MIN, other: NOW });
});

test('markSeen: a missing map starts empty, a garbage mark is replaced, a non-finite ts changes nothing', () => {
  assert.deepEqual(markSeen(undefined, 'src', NOW), { src: NOW });
  assert.deepEqual(markSeen({ src: 'yesterday' }, 'src', NOW), { src: NOW });
  assert.deepEqual(markSeen({ src: NOW - MIN }, 'src', Number.NaN), { src: NOW - MIN });
});

// ---- the liveness of a noticed comment -----------------------------------------------------

// ---- one liveness count with the writable channels' chooser --------------------------------

// ---- the audience rail (no shortcut for @everyone, role overwrites combined) -----------------

test('audienceCovers: a source every destination viewer can view is covered', () => {
  const dest = audience({ everyone: false, roles: ['r1', 'r2'] });
  const source = audience({ everyone: true, roles: ['guild', 'r1', 'r2', 'r3'] });
  assert.equal(audienceCovers(dest, source), true);
  const wide = audience({ everyone: true, roles: ['guild', 'r1', 'r2'] });
  assert.equal(audienceCovers(wide, audience({ everyone: true, roles: ['guild', 'r1', 'r2'] })), true);
});

test('audienceCovers: a role denied on an everyone-visible source blocks', () => {
  const dest = audience({ everyone: true, roles: ['guild', 'members', 'muted'] });
  const source = audience({ everyone: true, roles: ['guild', 'members'], roleDeny: ['muted'] });
  assert.equal(audienceCovers(dest, source), false);
});

test('audienceCovers: a member holding a role denied on the source and another role that views a members-only destination blocks', () => {
  // D: @everyone denied, 'verified' allowed. S: no @everyone overwrite, 'jail' denied. A member with verified and
  // jail sees D (role allows come after role denies) and not S; each role on its own passes the per-role check.
  const dest = audience({ everyone: false, roles: ['verified', 'admin'], roleAllow: ['verified'] });
  const source = audience({ everyone: true, roles: ['guild', 'verified', 'admin'], roleDeny: ['jail'] });
  assert.equal(audienceCovers(dest, source), false);
});

test('audienceCovers: a role denied on the source passes when every destination role is allowed there', () => {
  const dest = audience({ everyone: false, roles: ['verified', 'staff'], roleAllow: ['verified', 'staff'] });
  const source = audience({
    everyone: true,
    roles: ['guild', 'verified', 'staff'],
    roleAllow: ['verified', 'staff'],
    roleDeny: ['jail'],
  });
  assert.equal(audienceCovers(dest, source), true);
  const wide = audience({ everyone: true, roles: ['guild', 'verified', 'staff'] });
  assert.equal(audienceCovers(wide, source), false, 'an everyone-visible destination is reached without any role');
  const everyoneListed = audience({
    everyone: true,
    roles: ['guild', 'verified', 'staff'],
    roleAllow: ['guild', 'verified', 'staff'],
    roleDeny: ['jail'],
  });
  assert.equal(
    audienceCovers(wide, everyoneListed),
    false,
    "@everyone's allow comes before role denies, even if a reader lists it as a role allow"
  );
});

test('audienceCovers: a role denied on both channels passes, unless the destination lets it back in', () => {
  const source = audience({ everyone: true, roles: ['guild', 'members'], roleDeny: ['jail'] });
  assert.equal(
    audienceCovers(audience({ everyone: true, roles: ['guild', 'members'], roleDeny: ['jail'] }), source),
    true
  );
  const letsBack = audience({
    everyone: true,
    roles: ['guild', 'members', 'staff'],
    roleAllow: ['staff'],
    roleDeny: ['jail'],
  });
  const sourceWithStaff = audience({ everyone: true, roles: ['guild', 'members', 'staff'], roleDeny: ['jail'] });
  assert.equal(audienceCovers(letsBack, sourceWithStaff), false, 'jail plus staff sees the destination only');
  const repeats = audience({
    everyone: true,
    roles: ['guild', 'members', 'staff'],
    roleAllow: ['staff'],
    roleDeny: ['jail'],
  });
  assert.equal(audienceCovers(letsBack, repeats), true, 'the source repeats the allow');
});

// A model of Discord's ViewChannel computation, as discord.js GuildChannel
// memberPermissions / rolePermissions do it: base permissions of the held
// roles (Administrator sees everything), @everyone's overwrite, every held
// role's deny, every held role's allow, the member's own overwrite.
const ROLE_IDS = ['guild', 'a', 'b'];
const OVERWRITES = [null, 'allow', 'deny'];
const HOLDINGS = [[], ['a'], ['b'], ['a', 'b']];
const PEOPLE = ['m', 'x'];

function applyOverwrite(view: Untyped, overwrite: Untyped) {
  if (overwrite === 'deny') return false;
  if (overwrite === 'allow') return true;
  return view;
}

function roleViews(roles: Untyped, channel: Untyped, id: string) {
  if (roles[id].admin) return true;
  const view = applyOverwrite(roles[id].view || roles.guild.view, channel.roles.guild);
  return applyOverwrite(view, channel.roles[id]);
}

function memberViews(roles: Untyped, channel: Untyped, person: Untyped, held: Untyped) {
  if (held.some((id: string) => roles[id].admin)) return true;
  let view = applyOverwrite(roles.guild.view || held.some((id: string) => roles[id].view), channel.roles.guild);
  if (held.some((id: string) => channel.roles[id] === 'deny')) view = false;
  if (held.some((id: string) => channel.roles[id] === 'allow')) view = true;
  return applyOverwrite(view, channel.members[person]);
}

function modelAudience(roles: Untyped, channel: Untyped) {
  const overwritten = (value: Untyped) => ROLE_IDS.filter((id) => id !== 'guild' && channel.roles[id] === value);
  const members = (value: Untyped) => PEOPLE.filter((id) => channel.members[id] === value);
  return audience({
    everyone: roleViews(roles, channel, 'guild'),
    roles: ROLE_IDS.filter((id) => roleViews(roles, channel, id)),
    roleAllow: overwritten('allow'),
    roleDeny: overwritten('deny'),
    memberAllow: members('allow'),
    memberDeny: members('deny'),
  });
}

test('audienceCovers: never covers a pair where some member sees the destination and not the source', () => {
  const channels = [];
  for (const guild of OVERWRITES)
    for (const a of OVERWRITES)
      for (const b of OVERWRITES)
        for (const m of OVERWRITES) {
          channels.push({ roles: { guild, a, b }, members: { m } });
        }
  const roleSets = [];
  for (const guildView of [false, true])
    for (const aBits of [0, 1, 2, 3])
      for (const bBits of [0, 1, 2, 3]) {
        roleSets.push({
          guild: { view: guildView, admin: false },
          a: { view: (aBits & 1) === 1, admin: (aBits & 2) === 2 },
          b: { view: (bBits & 1) === 1, admin: (bBits & 2) === 2 },
        });
      }
  let covered = 0;
  let coveredWithRoleDeny = 0;
  for (const roles of roleSets) {
    const seen: Array<{ audience: ReturnType<typeof audience>; views: Array<boolean> }> = channels.map((channel) => ({
      audience: modelAudience(roles, channel),
      views: PEOPLE.flatMap((person) => HOLDINGS.map((held) => memberViews(roles, channel, person, held))),
    }));
    for (const dest of seen) {
      for (const source of seen) {
        if (!audienceCovers(dest.audience, source.audience)) continue;
        covered += 1;
        if (source.audience.roleDeny.size > 0) coveredWithRoleDeny += 1;
        dest.views.forEach((view: Untyped, i: Untyped) =>
          assert.ok(!view || source.views[i], 'a member sees the destination and not the source')
        );
      }
    }
    for (const same of seen)
      assert.equal(audienceCovers(same.audience, same.audience), true, 'the same overwrites always cover');
  }
  assert.ok(covered > 0 && coveredWithRoleDeny > 0, 'the rule still covers pairs, a role deny on the source included');
});

test('audienceCovers: a role that views the destination but not the source blocks', () => {
  const dest = audience({ roles: ['r1', 'r2'] });
  const source = audience({ roles: ['r1'] });
  assert.equal(audienceCovers(dest, source), false);
});

test('audienceCovers: a source hidden from everyone never covers an everyone-visible destination', () => {
  const dest = audience({ everyone: true, roles: ['r1'] });
  const source = audience({ everyone: false, roles: ['r1'] });
  assert.equal(audienceCovers(dest, source), false);
});

test('audienceCovers: a member allowed only on the destination blocks a source that may hide itself from that member', () => {
  const hidden = audience({ everyone: false, roles: ['r1'] });
  assert.equal(audienceCovers(audience({ roles: ['r1'], memberAllow: ['u1'] }), hidden), false);
  const allowedBoth = audience({ everyone: false, roles: ['r1'], memberAllow: ['u1'] });
  assert.equal(audienceCovers(audience({ roles: ['r1'], memberAllow: ['u1'] }), allowedBoth), true);
  const open = audience({ everyone: true, roles: ['guild', 'r1'] });
  assert.equal(
    audienceCovers(audience({ everyone: true, roles: ['guild', 'r1'], memberAllow: ['u1'] }), open),
    true,
    'a source nothing hides from anyone needs no allow by name'
  );
});

test('audienceCovers: a member denied on the source blocks unless denied on the destination', () => {
  const source = audience({ everyone: true, roles: ['guild', 'r1'], memberDeny: ['u9'] });
  assert.equal(audienceCovers(audience({ everyone: true, roles: ['guild', 'r1'] }), source), false);
  assert.equal(audienceCovers(audience({ everyone: true, roles: ['guild', 'r1'], memberDeny: ['u9'] }), source), true);
});

// A large guild: 74 roles, @everyone's among them; the main channel denies one
// role and allows three members by name.
const GUILD_ROLE = 'guild';
const PLAIN_ROLES = Array.from({ length: 73 }, (_, i) => `role-${i + 1}`);
const ALL_ROLES = [GUILD_ROLE, ...PLAIN_ROLES];
const DENIED_ROLE = PLAIN_ROLES[40];
const ALL_BUT_DENIED = ALL_ROLES.filter((id) => id !== DENIED_ROLE);
const MAIN_MEMBERS = ['member-1', 'member-2', 'member-3'];
const LARGE_MAIN = audience({
  everyone: true,
  roles: ALL_BUT_DENIED,
  roleDeny: [DENIED_ROLE],
  memberAllow: MAIN_MEMBERS,
});

test('audienceCovers: an open source covers a large main channel whose member allows it does not repeat', () => {
  const open = audience({ everyone: true, roles: ALL_ROLES });
  assert.equal(LARGE_MAIN.roles.size, 73);
  assert.equal(audienceCovers(LARGE_MAIN, open), true);
});

test('audienceCovers: a source with a role deny needs an allow there for every member a large main channel allows', () => {
  const source = audience({
    everyone: true,
    roles: ALL_BUT_DENIED,
    roleDeny: [DENIED_ROLE],
    memberAllow: ['member-1'],
  });
  assert.equal(audienceCovers(LARGE_MAIN, source), false, 'member-2 and member-3 may hold the denied role');
  const repeats = audience({
    everyone: true,
    roles: ALL_BUT_DENIED,
    roleDeny: [DENIED_ROLE],
    memberAllow: MAIN_MEMBERS,
  });
  assert.equal(audienceCovers(LARGE_MAIN, repeats), true, 'the member step was the only one in the way');
});

test('audienceCovers: a source @everyone views with no role deny and no member deny covers any destination through the full check', () => {
  const open = audience({ everyone: true, roles: ['guild', 'r1', 'r2'], roleAllow: ['r2'], memberAllow: ['u7'] });
  const destinations = [
    audience({ everyone: true, roles: ['guild', 'r1', 'r2'], memberAllow: ['u1', 'u2'] }),
    audience({ everyone: false, roles: ['r1'], roleAllow: ['r1'], memberAllow: ['u1'], memberDeny: ['u2'] }),
    audience({ everyone: true, roles: ['guild', 'r2'], roleAllow: ['r2'], roleDeny: ['r1'], memberAllow: ['u3'] }),
    audience(),
  ];
  for (const [i, dest] of destinations.entries()) assert.equal(audienceCovers(dest, open), true, `destination ${i}`);
});

test('audienceCovers: the role step runs on a source @everyone views with nothing denied (no @everyone shortcut)', () => {
  // audienceOf never reads this shape (see the test above); the rail still compares the roles.
  const open = audience({ everyone: true, roles: ['guild', 'r1'] });
  assert.equal(audienceCovers(audience({ everyone: false, roles: ['r3'], roleAllow: ['r3'] }), open), false);
});

test('audienceCovers: a source that denies a member the destination allows blocks', () => {
  const source = audience({ everyone: true, roles: ['guild', 'r1'], memberDeny: ['u1'] });
  assert.equal(
    audienceCovers(audience({ everyone: true, roles: ['guild', 'r1'], memberAllow: ['u1'] }), source),
    false
  );
  assert.equal(audienceCovers(audience({ everyone: false, roles: ['r1'], memberAllow: ['u1'] }), source), false);
  const allowsAndDenies = audience({ everyone: true, roles: ['guild', 'r1'], memberAllow: ['u2'], memberDeny: ['u1'] });
  assert.equal(
    audienceCovers(audience({ everyone: true, roles: ['guild', 'r1'], memberAllow: ['u1'] }), allowsAndDenies),
    false
  );
});

test('audienceCovers: with a role deny on the source only an allow there proves a member the destination allows', () => {
  const source = audience({ everyone: true, roles: ['guild', 'members'], roleDeny: ['jail'] });
  const dest = audience({ everyone: true, roles: ['guild', 'members'], roleDeny: ['jail'], memberAllow: ['u1'] });
  assert.equal(
    audienceCovers(dest, source),
    false,
    'u1 may hold jail: the allow by name beats it on the destination only'
  );
  const allowed = audience({ everyone: true, roles: ['guild', 'members'], roleDeny: ['jail'], memberAllow: ['u1'] });
  assert.equal(audienceCovers(dest, allowed), true);
});

test('audienceCovers: a source @everyone cannot view needs an allow there for every member the destination allows', () => {
  const plain = audience({ everyone: false, roles: ['r1'] });
  assert.equal(
    audienceCovers(audience({ everyone: true, roles: ['guild', 'r1'] }), plain),
    false,
    'even with nothing denied on it'
  );
  assert.equal(audienceCovers(audience({ everyone: false, roles: ['r1'], memberAllow: ['u1'] }), plain), false);
  const allowed = audience({ everyone: false, roles: ['r1'], memberAllow: ['u1'] });
  assert.equal(audienceCovers(audience({ everyone: false, roles: ['r1'], memberAllow: ['u1'] }), allowed), true);
});

test('audienceCovers: never covers a leaking pair when two members carry overwrites on both channels', () => {
  const channels = [];
  for (const guild of OVERWRITES)
    for (const a of OVERWRITES)
      for (const b of OVERWRITES) {
        for (const m of OVERWRITES)
          for (const x of OVERWRITES) channels.push({ roles: { guild, a, b }, members: { m, x } });
      }
  const roleSets = [];
  for (const guildView of [false, true])
    for (const aView of [false, true])
      for (const bView of [false, true]) {
        roleSets.push({
          guild: { view: guildView, admin: false },
          a: { view: aView, admin: false },
          b: { view: bView, admin: false },
        });
      }
  let openSource = 0;
  let notDeniedByName = 0;
  for (const roles of roleSets) {
    const seen = channels.map((channel) => ({
      audience: modelAudience(roles, channel),
      views: PEOPLE.flatMap((person) => HOLDINGS.map((held) => memberViews(roles, channel, person, held))),
    }));
    for (const dest of seen) {
      for (const source of seen) {
        if (!audienceCovers(dest.audience, source.audience)) continue;
        dest.views.forEach((view, i) =>
          assert.ok(!view || source.views[i], 'a member sees the destination and not the source')
        );
        const unrepeated = [...dest.audience.memberAllow].some((id) => !source.audience.memberAllow.has(id));
        if (!unrepeated) continue;
        if (source.audience.memberDeny.size === 0) openSource += 1;
        else notDeniedByName += 1;
      }
    }
  }
  assert.ok(
    openSource > 0 && notDeniedByName > 0,
    'both ways past an allow by name the source does not repeat are reached'
  );
});

test('audienceCovers: a missing or malformed audience never covers', () => {
  const ok = audience({ everyone: true, roles: ['guild'] });
  assert.equal(audienceCovers(null, ok), false);
  assert.equal(audienceCovers(ok, null), false);
  assert.equal(audienceCovers(ok, { ...ok, roles: ['guild'] }), false, 'roles not a set');
  assert.equal(audienceCovers({ everyone: true, roles: new Set(['guild']) }, ok), false);
  const noRoleDeny: Partial<typeof ok> = { ...ok };
  delete noRoleDeny.roleDeny;
  assert.equal(audienceCovers(ok, noRoleDeny), false, 'a source without its role overwrites');
  assert.equal(audienceCovers({ ...ok, roleAllow: [] }, ok), false, 'roleAllow not a set');
  assert.equal(audienceCovers({ ...ok, everyone: 'yes' }, ok), false, 'everyone not a boolean');
});

// ---- the destination ---------------------------------------------------------------------

// The tests of `resolveDestination` and `pickDestinationId` went with the main channel (owner, 2026-11-05).

test('messageLink: the url the adapter put on the reference, and nothing built by the core', () => {
  const ref = { iface: 'discord', conversationId: '200', messageId: '300', url: 'https://chat.example/200/300' };
  assert.equal(messageLink(ref), 'https://chat.example/200/300');
});

test('messageLink: a reference without a url has no link, whatever its interface', () => {
  assert.equal(messageLink({ iface: 'discord', conversationId: '200', messageId: '300' }), null);
  assert.equal(messageLink({ iface: 'fake', conversationId: 'c1', messageId: 'm1', url: null }), null);
});

test('messageLink: a reference with a missing id has no link', () => {
  assert.equal(
    messageLink({ iface: 'fake', conversationId: '', messageId: 'm1', url: 'https://chat.example/x' }),
    null
  );
  assert.equal(
    messageLink({ iface: 'fake', conversationId: 'c1', messageId: '', url: 'https://chat.example/x' }),
    null
  );
  assert.equal(messageLink(null), null);
});

test('audienceCovers: a member-only destination is covered by an open source with a denied role when the members hold other roles', () => {
  const source = audience({ everyone: true, roles: ['guild', 'r1'], roleDeny: ['jail'] });
  const dest = (memberRoles: Untyped) =>
    audience({ everyone: false, roles: [], memberAllow: ['u1', 'u2'], memberRoles });
  assert.equal(audienceCovers(dest({ u1: ['r1'], u2: [] }), source), true, 'neither holds the denied role');
  assert.equal(audienceCovers(dest({ u1: ['r1'], u2: ['jail'] }), source), false, 'one holds the denied role');
  assert.equal(audienceCovers(dest({ u1: ['r1'] }), source), false, 'a member not cached is not proven');
  assert.equal(audienceCovers(dest(null), source), false, 'no roles at all: the old rule');
});

test('audienceCovers: a member proves his view through a role the source allows when it is closed to everyone', () => {
  const source = audience({ everyone: false, roles: ['staff'], roleAllow: ['staff'] });
  const dest = (held: Untyped) => audience({ everyone: false, memberAllow: ['u1'], memberRoles: { u1: held } });
  assert.equal(audienceCovers(dest(['staff']), source), true);
  assert.equal(audienceCovers(dest(['other']), source), false);
});

test('audienceCovers: a member denied by name on the source is not proven by his roles', () => {
  const source = audience({ everyone: true, memberDeny: ['u1'] });
  const dest = audience({ everyone: false, memberAllow: ['u1'], memberRoles: { u1: ['r1'] } });
  assert.equal(audienceCovers(dest, source), false);
});
