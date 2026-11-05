import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// Plan 2026-11-04-cli-and-memory B3: the pure pieces of the route classifier that survive. The list, the request, the
// parser and the hook moved to src/behavior/elsewhere-pick.ts, tests/elsewhere-pick.test.ts and tests/elsewhere-hooks.test.ts.
import { routeCandidate, routeContext, routeWriter } from '../src/behavior/route.ts';
import { labels } from './fixtures/labels.ts';
import { useIface } from './fixtures/turn-world.ts';

// The conversations are held by a fake interface named `fake`.
useIface('fake');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// PR 7c: the shipped settings live in config/config.json.
const SHIPPED_CONFIG = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'config.json'), 'utf8'));

const NOW = Date.UTC(2026, 9, 5, 12, 0, 0);
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const iso = (ms: number) => new Date(ms).toISOString();

type StoredChannel = Parameters<typeof routeWriter>[0];

// The route settings the router tests rely on, pinned here instead of read from the shipped defaults.
const ROUTE_PIN = { contextMessages: 20, maxChannels: 40, purposeChars: 80, maxOutputTokens: 120 };

/** The shipped config.json with the route settings pinned and the given groups merged over a fresh copy (one level deep). */
function config(overrides: Record<string, object> = {}) {
  const base = structuredClone(SHIPPED_CONFIG);
  base.route = { ...ROUTE_PIN };
  for (const [key, value] of Object.entries(overrides)) base[key] = { ...base[key], ...value };
  return base;
}

// ---- settings and the switch ----------------------------------------------------------

// ---- the list ----------------------------------------------------------------------------

test('routeWriter: the top writer with at least half the messages, named from the profile with two aliases by rank', () => {
  const profile = {
    names: ['Éloïse', 'Elo'],
    aliases: [
      { name: 'Lili', weight: 1, firstSeen: iso(NOW - 9 * DAY), lastSeen: iso(NOW - 9 * DAY) },
      { name: 'Élo', weight: 5, firstSeen: iso(NOW - DAY), lastSeen: iso(NOW - DAY) },
      { name: 'Zaza', weight: 3, firstSeen: iso(NOW - DAY), lastSeen: iso(NOW - DAY) },
    ],
  };
  const profileOf = (id: string) => (id === 'u3' ? profile : null);
  // A stored channel with the two fields the rule reads.
  const channel = {
    topWriters: [
      { id: 'u3', count: 30 },
      { id: 'u2', count: 20 },
    ],
    messageCount: 60,
  } as StoredChannel;
  assert.deepEqual(routeWriter(channel, profileOf, 365), { name: 'Éloïse', aliases: ['Élo', 'Zaza'] });
  assert.equal(routeWriter({ ...channel, messageCount: 61 }, profileOf, 365), null, 'under half');
  assert.equal(routeWriter({ topWriters: [], messageCount: 0 } as unknown as StoredChannel, profileOf), null);
  assert.equal(
    routeWriter({ topWriters: [{ id: 'u9', count: 9 }], messageCount: 9 } as StoredChannel, profileOf),
    null,
    'no stored name'
  );
});

// ---- the request and the answer ----------------------------------------------------------

// ---- the context ---------------------------------------------------------------------------

/** A normalized message of the chat. */
function line(
  id: string,
  {
    authorId = 'u1',
    authorName = 'Ana',
    ts = NOW - MINUTE,
    content = 'γεια',
    self = false,
    bot = false,
  }: { authorId?: string; authorName?: string; ts?: number; content?: string; self?: boolean; bot?: boolean } = {}
) {
  return {
    id,
    placeId: 'c1',
    authorId,
    authorName,
    ts,
    content,
    self,
    bot,
    attachments: [],
    links: [],
    stickers: [],
    reactions: [],
  };
}

test("routeCandidate: the trigger, else the newest message neither the persona's nor a bot's", () => {
  const history = [
    line('m1'),
    line('m2', { authorName: 'Nikos' }),
    line('m3', { self: true }),
    line('m4', { bot: true }),
  ];
  assert.equal(routeCandidate(history, history[0]), history[0]);
  assert.equal(routeCandidate(history, null), history[1]);
  assert.equal(routeCandidate([line('m3', { self: true })], null), null);
});

test('routeContext: the last contextMessages before the candidate, and the candidate block', () => {
  const history = [
    line('m1', { content: 'πρώτο' }),
    line('m2', { content: 'δεύτερο' }),
    line('m3', { content: 'τρίτο' }),
    line('m4', { content: 'μετά' }),
  ];
  const { transcriptBlock, candidateBlock } = routeContext({
    history,
    candidate: history[2],
    contextMessages: 1,
    config: config(),
    labels,
    selfName: 'Zoë',
  });
  assert.ok(transcriptBlock.startsWith('<transcript>\n') && transcriptBlock.endsWith('\n</transcript>'));
  assert.ok(
    transcriptBlock.includes('δεύτερο') &&
      !transcriptBlock.includes('πρώτο') &&
      !transcriptBlock.includes('τρίτο') &&
      !transcriptBlock.includes('μετά')
  );
  assert.equal(candidateBlock, '<candidate>\nAna: τρίτο\n</candidate>');
  assert.equal(
    routeContext({ history, candidate: history[2], contextMessages: 0, config: config(), labels, selfName: 'Zoë' })
      .transcriptBlock,
    ''
  );
});

// ---- the router ------------------------------------------------------------------------------
