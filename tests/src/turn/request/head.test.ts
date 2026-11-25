import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { formatNow } from '../../../../src/format.ts';
import { withCacheMarker } from '../../../../src/llm/openrouter.ts';
import { frameOf, type FrameParty } from '../../../../src/turn/request/frame.ts';
import { buildRequest, type Built } from '../../../fixtures/built-request.ts';
import { frameTurn } from '../../../fixtures/diary-frame.ts';
import { frameInput, ROOM_CHAIN } from '../../../fixtures/frame-input.ts';
import { labels } from '../../../fixtures/labels.ts';
import { addDm, addLine, addPerson, type World } from '../../../fixtures/memory-db/mind-world.ts';
import { mindOfEntries, personEntry } from '../../../fixtures/mind-entries.ts';
import { OWNER_PERSON } from '../../../fixtures/owner-accounts.ts';
import {
  baseInput,
  fakeConfig,
  fakePrompts,
  frameOfInput,
  makeMessage,
  MIN,
  NOW,
} from '../../../fixtures/prompt-rig.ts';
import { blockOf, replyRun, type ReplyRun, serviceWorld, TURN_NOW } from '../../../fixtures/service-turn.ts';
import { shippedLabels } from '../../../fixtures/shipped-labels.ts';
import { useIface } from '../../../fixtures/turn-world.ts';

const ELENI = personEntry('111', 'Ελένη', { evidence: 'counterpart', relation: 'ΣΧΕΣΗ-ΕΛΕΝΗΣ' });

const AS_ELENI: FrameParty = { personId: ELENI.personId, accountId: 'fake:111', nativeId: '111', name: 'Ελένη' };

const FRAME = frameOf(
  frameInput({ now: NOW, timezone: 'Europe/Moscow', author: AS_ELENI, trigger: { messageId: 'm1', authorId: '111' } })
);

const HISTORY = [makeMessage('m1', NOW - MIN, { authorId: '111', authorName: 'Ελένη', content: 'γεια σου' })];

const nameOf = (id: string): string | null => (id === '111' ? 'Ελένη' : null);

/** The user message as one text. */
const userOf = (built: Built): string => {
  const [, message] = built.messages;
  return message.content.map((part) => String(part.text ?? '')).join('');
};

// ---- the appearance ------------------------------------------------------------------------------------------------

// The persona reads their appearance in every turn of theirs, in the stable cached part beside the
// character card, and an empty or missing appearance gives no block. The appearance sentence is the test's own.
const LOOKS = 'ΕΜΦΑΝΙΣΗ a tall figure in a mustard raincoat with a crooked umbrella';

/** A request of `frame` whose prompts hold `appearance` (absent when undefined). */
function appearanceRequest(frame: ReturnType<typeof frameOf>, appearance?: string): Built {
  const extra = appearance === undefined ? {} : { appearance };
  return buildRequest(
    baseInput({
      config: fakeConfig({ context: { meanwhile: { messages: 8, around: 2 } } }),
      prompts: fakePrompts({ labels: shippedLabels, ...extra }),
      frame,
      whereabouts: { kind: 'place', iface: 'fake', private: false, chain: ROOM_CHAIN },
      history: HISTORY,
      trigger: HISTORY[0],
      triggerKind: 'mention',
      nameOf,
      mind: mindOfEntries({ people: [ELENI] }),
    })
  );
}

/** The text of the first cache-marked part of a request as it is sent. */
function firstMarkedOf(built: Built): string {
  const sent = withCacheMarker(built.messages, '1h');
  const [system] = sent;
  const parts = Array.isArray(system.content)
    ? (system.content as Array<{ text?: string; cache_control?: unknown }>)
    : [{ text: String(system.content) }];
  const marked = parts.filter((part) => Object.hasOwn(part, 'cache_control'));
  return marked.map((part) => String(part.text ?? '')).join('');
}

const HEARTBEAT = frameOf(
  frameInput({
    now: NOW,
    mode: 'inner',
    triggerKind: 'inner',
    wakeKind: 'heartbeat',
    chain: [],
    trigger: null,
    author: null,
  })
);

for (const [kind, frame] of [
  ['a reply', FRAME],
  ['a heartbeat', HEARTBEAT],
] as const) {
  test(`<appearance> follows the card in the cached system message of ${kind}`, () => {
    // Bug: the appearance reaches only the drawing prompt, so the persona does not know how they look; or it lands in the user
    // message's per-turn part and rewrites the cache on every turn.
    const built = appearanceRequest(frame, LOOKS);
    const marked = firstMarkedOf(built);
    const block = `<appearance>\n${LOOKS}\n</appearance>`;
    assert.ok(marked.includes(block), marked);
    assert.ok(marked.indexOf('CARD_TEXT') < marked.indexOf(block), 'after the card');
    assert.ok(!userOf(built).includes(LOOKS), 'not in the user message');
  });
}

test('an empty or missing appearance gives no <appearance> block', () => {
  // Bug: an empty tag pair goes out, or a blank file prints a block of whitespace.
  for (const appearance of [undefined, '', '  \n ']) {
    const built = appearanceRequest(FRAME, appearance);
    const [first] = built.messages;
    const system = String(first.content);
    assert.ok(!system.includes('<appearance>'), JSON.stringify(appearance));
  }
});

// The diary's turn reads the persona's appearance beside the character card, in the
// system message. The appearance sentence is the test's own.
const PROMPT_DIARY_LOOKS = 'ΕΜΦΑΝΙΣΗ a tall figure in a mustard raincoat with a crooked umbrella';

test('the diary turn reads <appearance> in the system message, after the card', async () => {
  // Bug: only the chat turns get the appearance, so the diary describes someone the persona does not look like.
  // Changed: the planner's request went with the planner, so the turn's own request is the one checked.
  const run = await frameTurn({ prompts: { appearance: PROMPT_DIARY_LOOKS } });
  const block = `<appearance>\n${PROMPT_DIARY_LOOKS}\n</appearance>`;
  const text = run.writer[0] ?? '';
  const at = text.indexOf(block);
  assert.ok(at > text.indexOf('CARD_TEXT'), text.slice(0, 300));
  assert.ok(at < text.indexOf('<self>'), 'in the system message, before the user message');
});

const HOUR = 3_600_000;

const MINUTE = 60_000;

// An hour edge: the bucket of a one-hour TTL starts here.
const EDGE = Date.UTC(2026, 8, 20, 10, 0, 0);

function promptFreezeFakeConfig(overrides: { features?: object; cache?: object } = {}) {
  return {
    bot: { timezone: 'UTC' },
    context: {
      gapMarkerMinutes: 20,
      maxMessageChars: 800,
      caps: { interlocutor: 2500, aboutChat: 2500, people: 4000, neighbors: 3000, server: 2500, lore: 1500 },
      vision: { maxImages: 0, tokensPerImage: 400, imageSize: 512, recentImages: 0, recentImageMinutes: 0 },
      customEmoji: { max: 30 },
    },
    features: { ...overrides.features },
    gifs: { max: 20, halfLifeDays: 30, ownMarkHours: 24 },
    llm: { maxRequestTokens: 50000, safetyMargin: 0.9, cache: { ttl: '1h', ...overrides.cache } },
    memory: {},
  };
}

function promptFreezeBaseInput(overrides: Record<string, unknown> & { now?: number } = {}) {
  const now = overrides.now ?? EDGE + 10 * MINUTE;
  const input = {
    config: promptFreezeFakeConfig(),
    prompts: {
      main: 'SYSTEM',
      persona: 'CARD',
      rules: 'RULES',
      format: 'FORMAT',
      'turn/reply': 'REPLY_TASK',
      labels,
    },
    calibrator: { ratio: 1, apply: (n: number) => n },
    mode: 'reply',
    now,
    selfName: 'Nept',
    history: [
      {
        id: '1',
        ts: now - 60_000,
        authorId: 'a',
        authorName: 'Zoé',
        self: false,
        content: 'γεια',
        attachments: [],
        stickers: [],
        replyToId: null,
      },
    ],
    neighbors: [],
    trigger: null,
    triggerKind: null,
    placeMemory: {},
    interlocutor: null,
    otherProfiles: [],
    ...overrides,
  };
  // Every request is built on its turn frame (slice 7).
  return { ...input, frame: frameOfInput(input) };
}

function stableText(request: Built) {
  const secondMessage = request.messages[1];
  const part = secondMessage.content.find((entry) => entry.cacheSegment === 'stable');
  assert.ok(part, 'the request has a stable part');
  return part.text;
}

test('buildRequest: a memory batch inside one bucket leaves the stable part byte-identical; the next bucket shows the new self fact', () => {
  const stableFreeze = new Map();
  const before = buildRequest(promptFreezeBaseInput({ stableFreeze, placeMemory: { self: ['likes tea'] } }));
  const batch = { self: ['likes tea', 'hates mornings'] };
  const sameBucket = buildRequest(promptFreezeBaseInput({ stableFreeze, placeMemory: batch, now: EDGE + 50 * MINUTE }));
  assert.equal(stableText(sameBucket), stableText(before));
  assert.ok(!stableText(sameBucket).includes('hates mornings'));

  const nextBucket = buildRequest(
    promptFreezeBaseInput({ stableFreeze, placeMemory: batch, now: EDGE + HOUR + MINUTE })
  );
  assert.notEqual(stableText(nextBucket), stableText(before));
  assert.ok(stableText(nextBucket).includes('- hates mornings'));
});

// PR 7d: the prompt cache is code, so a request without a holder is the case that follows memory at once.
test('buildRequest: the self facts follow memory at once without a holder', () => {
  const batch = { self: ['likes tea', 'hates mornings'] };
  assert.ok(stableText(buildRequest(promptFreezeBaseInput({ placeMemory: batch }))).includes('- hates mornings'));
});

test('buildRequest: with llm.cache.ttl 5m the bucket is five minutes', () => {
  const config = promptFreezeFakeConfig({ cache: { ttl: '5m' } });
  const stableFreeze = new Map();
  const start = EDGE + MINUTE;
  buildRequest(promptFreezeBaseInput({ config, stableFreeze, placeMemory: { self: ['likes tea'] }, now: start }));
  const batch = { self: ['likes tea', 'hates mornings'] };
  assert.ok(
    !stableText(
      buildRequest(promptFreezeBaseInput({ config, stableFreeze, placeMemory: batch, now: start + 3 * MINUTE }))
    ).includes('hates mornings')
  );
  assert.ok(
    stableText(
      buildRequest(promptFreezeBaseInput({ config, stableFreeze, placeMemory: batch, now: start + 5 * MINUTE }))
    ).includes('hates mornings')
  );
});

test('buildRequest: system message is system-prompt + character-card + rules + format, joined', () => {
  // Changed: the rules are rows of the memory table `rules`, so the input hands in one; the prompt heads its line.
  const request = buildRequest({ ...baseInput(), rules: [{ text: 'a rule' }] });
  const firstMessage = request.messages[0];
  assert.equal(firstMessage.role, 'system');
  assert.equal(firstMessage.content, 'SYSTEM_TEXT for Nept\n\nCARD_TEXT\n\nRULES_TEXT\n\n- a rule\n\nFORMAT_TEXT');
});

test('buildRequest: {{name}} is filled with selfName in every system part', () => {
  const request = buildRequest(
    baseInput({ prompts: fakePrompts({ main: 'Hi, I am {{name}}.', persona: 'card of {{name}}' }) })
  );
  const firstMessage = request.messages[0];
  assert.ok(firstMessage.content.includes('Hi, I am Nept.'));
  assert.ok(firstMessage.content.includes('card of Nept'));
});

const REPLY_TURN_HANDLES_MIN = 60_000;

const THINK = '<think>STEP 4. So: answer.</think>';

const SAY = `${THINK}<msg>εντάξει</msg>`;

const iso = (at: number): string => new Date(at).toISOString();

/** A person's handle, whole. */
const HANDLE = /^@u[0-9a-z]+$/;

const NIKOS = 'person:fake:4242';

const GIANNIS = 'person:tele:88';

/** The texts of the world's lines, each unique so a test finds its line in one block. */
const LINE = {
  ownerGarden: 'ΠΕΤΡΟΣ-ΣΤΟΝ-ΚΗΠΟ',
  ownerRoom: 'ΠΕΤΡΟΣ-ΣΤΟ-ΓΕΝΙΚΑ',
  ownerCli: 'ΠΟΙΟΣ-ΕΓΡΑΨΕ-ΣΤΟΝ-ΚΗΠΟ',
  giannisHarbour: 'ΓΙΑΝΝΗΣ-ΣΤΟ-ΛΙΜΑΝΙ',
  eleniGarden: 'ΕΛΕΝΗ-ΣΤΟΝ-ΚΗΠΟ',
  nikosOne: 'ΝΙΚΟΣ-ΑΠΟ-ΤΟ-ΕΝΑ',
  nikosTwo: 'ΝΙΚΟΣ-ΑΠΟ-ΤΟ-ΔΥΟ',
} as const;

/** The name the owner's command line account carries, and the one their account on the fake interface carries. */
const OWNER_CLI_NAME = 'ΠΕΤΡΟΣ-ΚΟΝΣΟΛΑ';

const OWNER_FAKE_NAME = 'Πέτρος';

/**
 * The service world, with the owner holding an account on the command line and one on the fake interface, their line in
 * the garden `c2` right after the persona's, and Γιάννης, who has an account on `tele` alone and wrote in the harbour `k1` right
 * after the persona's line there. Ελένη's line before the persona's in the garden mentions nobody; the owner's mentions Ελένη.
 */
function handleWorld(): World {
  const world = serviceWorld();
  addPerson(world.db, {
    id: OWNER_PERSON,
    accounts: [
      { id: 'cli:owner', iface: 'cli', native: 'owner', names: [OWNER_CLI_NAME] },
      { id: 'fake:u1', iface: 'fake', native: 'u1', names: [OWNER_FAKE_NAME] },
    ],
  });
  addDm(world.db, { iface: 'cli', native: 'owner', person: OWNER_PERSON, account: 'cli:owner' });
  addLine(world.db, {
    id: 'o1',
    iface: 'fake',
    place: 'fake:channel:c2',
    author: 'fake:u1',
    text: `${LINE.ownerGarden} <@111>`,
    at: iso(TURN_NOW - 49 * REPLY_TURN_HANDLES_MIN),
  });
  addPerson(world.db, { id: GIANNIS, accounts: [{ id: 'tele:88', iface: 'tele', native: '88', names: ['Γιάννης'] }] });
  addLine(world.db, {
    id: 'y1',
    iface: 'tele',
    place: 'tele:channel:k1',
    author: 'tele:88',
    text: LINE.giannisHarbour,
    at: iso(TURN_NOW - 39 * REPLY_TURN_HANDLES_MIN),
  });
  addPerson(world.db, {
    id: NIKOS,
    accounts: [
      { id: 'fake:4242', iface: 'fake', native: '4242', names: ['Νίκος'] },
      { id: 'fake:4243', iface: 'fake', native: '4243', names: ['Νικόλαος'] },
    ],
  });
  return world;
}

/** The user text of request `step` of turn `turn` of a run, '' when there is none. */
const requestOf = (run: ReplyRun, turn: number, step: number): string => {
  const requests = run.requests[turn] ?? [];
  return requests[step] ?? '';
};

/** The bodies of every `<people>` of a text: the request's own and the one a read result carries. */
const peopleBodies = (text: string): Array<string> =>
  [...text.matchAll(/<people>\n?([\s\S]*?)\n?<\/people>/g)].map((match) => match[1] ?? '');

/** The entries of every `<people>` of a text, one text each. */
const entriesOf = (text: string): Array<string> =>
  peopleBodies(text).flatMap((body) => body.split(/\n\s*\n/).filter((entry) => entry.trim() !== ''));

/** The `@u…` handle an entry opens with, null when its first line holds none. */
const entryHandle = (entry: string): string | null => /@u[0-9a-z]+/.exec(entry.split('\n')[0] ?? '')?.[0] ?? null;

/** The line of `text` that holds `marker`, '' when none does. */
const lineWith = (text: string, marker: string): string => text.split('\n').find((line) => line.includes(marker)) ?? '';

/** The part of a line before `marker`: its number, time and author. */
const headOf = (text: string, marker: string): string => {
  const line = lineWith(text, marker);
  return line.slice(0, Math.max(0, line.indexOf(marker)));
};

/** The `@u…` handles that stand on the line of `marker` before it: the line's author. */
const authorOf = (text: string, marker: string): Array<string> => headOf(text, marker).match(/@u[0-9a-z]+/g) ?? [];

describe('handles in a reply turn', () => {
  before(() => useIface('fake'));
  after(() => useIface('discord'));

  test("one person's handle is the same on a line of the chat and as the person the persona answers when the account's meta-person differs from its old link", async () => {
    // Bug: a chat author is keyed by the account's meta-person row (`person_accounts`) and the person the persona answers by the
    // account's old link (`accounts.person_id`), so after a bind one person reads as two handles in one request.
    const world = handleWorld();
    try {
      world.db
        .prepare('INSERT INTO people (id, first_seen_at, meta) VALUES (?, ?, 1)')
        .run('person:meta-nikos', '2026-11-01T10:00:00.000Z');
      world.db
        .prepare("UPDATE person_accounts SET person_id = ? WHERE iface = 'fake' AND platform_id = '4242'")
        .run('person:meta-nikos');
      const run = await replyRun({
        world,
        steps: [
          {
            trigger: {
              id: 'r2',
              text: LINE.nikosOne,
              at: TURN_NOW - REPLY_TURN_HANDLES_MIN,
              authorId: '4242',
              authorName: 'Νίκος',
            },
            answers: [SAY],
          },
        ],
      });
      const request = requestOf(run, 0, 0);
      const answered = entryHandle(entriesOf(request)[0] ?? '');
      assert.match(answered ?? '', HANDLE, 'the person the persona answers opens <people>');
      assert.deepEqual(authorOf(blockOf(request, 'chat'), LINE.nikosOne), [answered]);
    } finally {
      world.close();
    }
  });
});

const WHEN = formatNow(NOW, 'Europe/Moscow', labels.locale);

const placeIn = (channelName: string) => ({
  kind: 'place',
  iface: 'discord',
  private: false,
  chain: [
    { id: `p-${channelName}`, kind: 'channel', name: channelName },
    { id: 'p-server', kind: 'server', name: 'Example Server' },
  ],
});

/** The parts of the user message. */
function partsOf(request: Built): Built['messages'][1]['content'] {
  const [, user] = request.messages;
  return user.content;
}

/** The text of the user part with no cache segment: the tail. */
const tailOf = (request: Built): string =>
  partsOf(request)
    .filter((part) => !part.cacheSegment)
    .map((part) => part.text)
    .join('');

/** The texts of the cached user parts, by segment. */
const cachedOf = (request: Built): Array<string> =>
  partsOf(request)
    .filter((part) => part.cacheSegment)
    .map((part) => `${part.cacheSegment}:${part.text}`);

/** The body of `<spatial_awareness>` in a request, null when it has none. */
function spatialOf(request: Built): string | null {
  const text = partsOf(request)
    .map((part) => part.text)
    .join('');
  const match = /<spatial_awareness>\n([\s\S]*?)\n<\/spatial_awareness>/.exec(text);
  return match ? (match[1] ?? null) : null;
}

test("the block sits in the tail, after the chat and right before the task, and holds the persona's time away", () => {
  // Bug: the block lands in a cached part, so every move between channels rewrites the prompt cache.
  // Slice 7: every request is built on its frame, whose order puts `<spatial_awareness>` before `<chat>` and folds
  // `<now>` into it (the lead's decisions 6 and 7 of the plan), so the persona's time away is the block's last lines.
  const offPeriods = [{ kind: 'paused', from: NOW - 3_600_000, to: NOW - 1_800_000 }];
  const request = buildRequest(baseInput({ whereabouts: placeIn('general'), offPeriods }));
  const tail = tailOf(request);
  assert.ok(tail.includes('<chat>'), 'the base input has a chat');
  // In the cache layout the turn's own blocks follow `<chat>`, this one last before `<task>`.
  assert.ok(
    tail.includes('</spatial_awareness>\n\n<task>') && tail.indexOf('</chat>') < tail.indexOf('<spatial_awareness>'),
    tail
  );
  assert.ok(!tail.includes('<now>'), tail);
  assert.match(spatialOf(request) ?? '', /30 min/);
  for (const part of cachedOf(request)) assert.ok(!part.includes('<spatial_awareness>'), part);
});

test('two places give the same cached parts byte for byte', () => {
  const here = buildRequest(baseInput({ whereabouts: placeIn('general') }));
  const there = buildRequest(baseInput({ whereabouts: placeIn('off-topic') }));
  assert.ok(cachedOf(here).length > 0, 'the request has a cached part to compare');
  assert.deepEqual(cachedOf(here), cachedOf(there));
  assert.notEqual(spatialOf(here), spatialOf(there));
});

test('the clock leaves <now> when the block carries it, so the time appears once', () => {
  const user = partsOf(buildRequest(baseInput({ whereabouts: placeIn('general') })))
    .map((part) => part.text)
    .join('');
  assert.equal(user.split(WHEN).length - 1, 1, user);
});
