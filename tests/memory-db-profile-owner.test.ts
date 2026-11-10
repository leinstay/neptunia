// The owner columns of the profile tables (src/memory/db/profile-owner.ts): every row an account's profile, a private
// layer or a history of prose writes names its writer and its holder, and every row her memory session writes is
// `session`, so the profile readers, the retirement of what a profile no longer holds and her session's rows need no
// unit. The test rewrites a profile.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyMemoryWrite } from '../src/memory/db/session-write.ts';
import type { MemoryHandle, Row } from '../src/memory/db/types.ts';
import { NOW, fixture, personOf } from './fixtures/memory-db/session-rig.ts';

// A member the fixture seeds no person for, so the profile owns its person's row.
const MEMBER = 'u-carol';
const ACCOUNT = `discord:${MEMBER}`;
const LINKED = 'discord:u-linked';
const ROOT = 'discord:guild:300000000000000001';

const profile = (extra: Row = {}): Row => ({
  firstSeen: '2026-10-01T10:00:00.000Z',
  messageCount: 3,
  character: 'Warm.',
  relationship: 'Friendly.',
  interests: [
    { topic: 'chess', weight: 2, firstSeen: '2026-10-01', lastSeen: '2026-10-02', itemId: 'i1' },
    { topic: 'tea', weight: 1, firstSeen: '2026-10-01', lastSeen: '2026-10-01', itemId: 'i2' },
  ],
  episodes: [{ date: '2026-10-01', what: 'joked', weight: 1, itemId: 'e1' }],
  affinity: { score: 5, reason: 'kind', history: [{ ts: '2026-10-01T00:00:00.000Z', delta: 5, score: 5 }] },
  names: ['Ada'],
  addressedAs: { Ada: { score: 1 } },
  ...extra,
});

const history = (texts: ReadonlyArray<string>): Row => ({
  character: texts.map((text, i) => ({ at: `2026-10-0${i + 1}T00:00:00.000Z`, by: 'analyzer', text, itemId: `v${i}` })),
});

/** A session run that adds a claim about the member and moves the attitude toward them, from one line. */
function sessionRun(handle: MemoryHandle, source: string, group: Row): void {
  applyMemoryWrite(handle, {
    kind: 'session',
    mode: 'apply',
    now: NOW,
    maxDelta: 5,
    run: {
      id: 'run:owner',
      sweepId: 'sweep:owner',
      scopeKey: 'group:discord',
      scope: group,
      batchKey: 'owner',
      startedAt: new Date(NOW).toISOString(),
      finishedAt: new Date(NOW).toISOString(),
      cursorFrom: 0,
      cursorTo: 1,
      sourcesN: 1,
      outcome: 'ok',
      counts: {},
      errors: [],
    },
    plan: {
      claims: [
        {
          op: 'add',
          subjectKind: 'person',
          subjectId: personOf(MEMBER),
          kind: 'detail',
          text: 'session fact',
          how: 'said',
          sources: [source],
          when: null,
        },
      ],
      episodes: [],
      descriptions: [],
      affinity: [{ personId: personOf(MEMBER), delta: 3, reason: 'session reason', sources: [source] }],
    },
  });
}

/** A profile, a linked account's own facts, a private layer, histories of prose and a session run. */
function writeAll(env: ReturnType<typeof fixture>): void {
  const write = (update: Row) => applyMemoryWrite(env.handle, { now: NOW, iface: 'discord', ...update });
  write({ kind: 'account-profile', accountId: ACCOUNT, value: profile() });
  const source = env.say({ native: 'owner-evidence', minutesAgo: 1, text: 'a synthetic line' });
  sessionRun(env.handle, source, env.group);
  write({ kind: 'account-profile', accountId: ACCOUNT, value: profile({ interests: [] }) });
  write({ kind: 'account-profile', accountId: LINKED, value: { names: ['Linked'] } });
  write({ kind: 'private-layer', accountId: ACCOUNT, value: { relationship: 'Close.', replies: { count: 1 } } });
  write({ kind: 'prose-versions', versionKind: 'users', subjectId: ACCOUNT, itemId: ACCOUNT, value: history(['a']) });
  write({ kind: 'prose-versions', versionKind: 'place', subjectId: ROOT, itemId: 'guild', value: history(['b']) });
  write({ kind: 'prose-versions', versionKind: 'lore', subjectId: ROOT, itemId: 'title-1', value: history(['c']) });
}

test('a profile rewrite retires what it no longer holds and leaves her session rows about the person', () => {
  const env = fixture();
  try {
    writeAll(env);
    const live = (id: string) =>
      env.db.prepare('SELECT retired_at FROM claims WHERE id = ?').get(id)?.retired_at === null;
    assert.equal(live('i1'), false);
    assert.equal(
      env.db.prepare("SELECT COUNT(*) AS n FROM claims WHERE writer = 'session' AND retired_at IS NULL").get()?.n,
      1
    );
  } finally {
    env.done();
  }
});
