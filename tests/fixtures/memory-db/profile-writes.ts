// Writes of account profiles and prose histories through the unit write and through their write kinds, over copies of
// one seeded database (tests/memory-db-account-profile.test.ts, tests/memory-db-prose-versions.test.ts).
import type { Row } from '../../../src/memory/db/types.ts';

export const NOW = Date.parse('2026-11-09T10:00:00.000Z');
export const ROOT = 'discord:guild:300000000000000001';
export const CHANNEL = 'discord:channel:400000000000000001';

/** One write of a test: an account's profile, or the version history of one prose owner. */
export type Write =
  | { of: 'profile'; accountId: string; value: Row }
  | {
      of: 'versions';
      versionKind: 'users' | 'channels' | 'place' | 'lore';
      subjectId: string;
      itemId: string;
      value: Row;
    };

export const profile = (extra: Row = {}): Row => ({
  firstSeen: '2026-09-01T10:00:00.000Z',
  lastSeen: '2026-10-20T10:00:00.000Z',
  messageCount: 120,
  character: 'Warm and quick to joke.',
  style: 'Short lines.',
  relationship: 'Friendly regular.',
  relationshipWrittenAt: '2026-10-01T00:00:00.000Z',
  interests: [
    { topic: 'chess', note: 'plays blitz', weight: 3, firstSeen: '2026-09-01', lastSeen: '2026-10-01', itemId: 'i1' },
    { topic: 'gardening', note: '', weight: 1, firstSeen: '2026-09-05', lastSeen: '2026-09-05' },
  ],
  details: [{ id: 1, text: 'has a cat', weight: 2, firstSeen: '2026-09-01', lastSeen: '2026-10-02', itemId: 'd1' }],
  detailsSeq: 1,
  aliases: [{ name: 'Alex', weight: 2, firstSeen: '2026-09-01', lastSeen: '2026-09-09', itemId: 'a1' }],
  affinity: {
    score: 20,
    reason: 'kind',
    history: [{ ts: '2026-09-10T00:00:00.000Z', delta: 5, appliedDelta: 5, score: 5, reason: 'first', itemId: 'f1' }],
    decayedAt: '2026-10-01T00:00:00.000Z',
  },
  episodes: [{ date: '2026-10-01', what: 'told a joke', quote: 'q', feeling: 'amused', weight: 2, itemId: 'e1' }],
  names: ['Αλέξης', 'Zoë'],
  avatar: { hash: null, text: 'a blue circle', describedAt: '2026-09-02T00:00:00.000Z', default: true },
  addressedAs: { Plain: { score: 1, last: '2026-10-02' } },
  closed: [
    {
      kind: 'detail',
      id: 9,
      text: 'was in school',
      weight: 1,
      firstSeen: '2026-09-01',
      lastSeen: '2026-09-02',
      validTo: '2026-10-01',
      itemId: 'c1',
    },
  ],
  updatedAt: '2026-10-20T10:00:00.000Z',
  ...extra,
});

export const versions = (field: string, texts: ReadonlyArray<string>): Row => ({
  [field]: texts.map((text, i) => ({
    at: `2026-10-0${i + 1}T00:00:00.000Z`,
    by: 'analyzer',
    chars: [...text].length,
    kept: 1,
    removed: 0,
    added: 1,
    text,
    itemId: `vs-${field}-${i}`,
  })),
  note: 'kept whole',
});







