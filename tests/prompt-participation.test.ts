// Tests for the `<participation>` block of src/behavior/prompt.ts#buildRequest:
// the persona's own exchanges on other channels, selected, deduplicated against
// the rest of the request, cut, budgeted and rendered after `<recent>`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { userText as contentText } from '../src/behavior/prompt.ts';
import { fill, formatClock } from '../src/format.ts';
import { labels } from './fixtures/labels.ts';
import { buildRequest, type Built, type Part } from './fixtures/built-request.ts';

const NOW = Date.UTC(2026, 9, 10, 12, 0, 0);
const MIN = 60_000;
const HOUR = 60 * MIN;
const TZ = 'Europe/Athens';
const HERE = 'c1';

// PR 7d: the switches are code and the context, memory and participation measures constants.
function fakeConfig({ caps = {} } = {}) {
  return {
    bot: { timezone: TZ },
    context: {
      caps: {
        interlocutor: 2500,
        aboutChat: 2500,
        people: 4000,
        neighbors: 3000,
        server: 2500,
        lore: 1500,
        recent: 1200,
        ...caps,
      },
    },
    llm: { maxRequestTokens: 50000 },
  };
}

function prompts(labelOverrides: object | null = null) {
  return {
    'system-prompt': 'SYSTEM for {{name}}',
    'character-card': 'CARD',
    rules: 'RULES',
    format: 'FORMAT',
    reply: 'Called by {{author}}.',
    interject: 'INTERJECT',
    initiate: 'INITIATE',
    labels: labelOverrides ?? labels,
  };
}

function chatLine(id: string, ts: number, overrides = {}) {
  return {
    id,
    ts,
    authorId: `a-${id}`,
    authorName: `User${id}`,
    self: false,
    content: `message ${id}`,
    attachments: [],
    stickers: [],
    replyToId: null,
    ...overrides,
  };
}

/** A stored participation message. */
function stored(
  id: string,
  ts: number,
  {
    name = 'Ana',
    authorId = 'u1',
    self = false,
    text = `γραμμή ${id}`,
    caption = null,
    replyTo = null,
  }: {
    name?: string;
    authorId?: string;
    self?: boolean;
    text?: string;
    replyTo?: string | null;
    caption?: string | null;
  } = {}
) {
  return { id, ts, authorId: self ? 'self' : authorId, name: self ? 'Zoë' : name, self, text, replyTo, caption };
}

/** p1 in #journal (c2, 2 h ago), p2 in #jardin (c3, 30 min ago). */
function state(extra: Array<{ id: string; placeId: string; continues: string | null; messages: Array<unknown> }> = []) {
  return {
    nextId: 10,
    episodes: [
      {
        id: 'p1',
        placeId: 'c2',
        continues: null,
        messages: [
          stored('a1', NOW - 2 * HOUR - MIN, { text: 'πού είναι το βιβλίο;' }),
          stored('a2', NOW - 2 * HOUR, { self: true, text: 'στο ράφι' }),
        ],
      },
      {
        id: 'p2',
        placeId: 'c3',
        continues: null,
        messages: [stored('b1', NOW - 30 * MIN, { self: true, text: 'ωραία λουλούδια', caption: 'a red tulip' })],
      },
      ...extra,
    ],
  };
}

const CHANNELS = [
  { id: HERE, name: 'general' },
  { id: 'c2', name: 'journal', purpose: 'a reading log' },
  { id: 'c3', name: 'jardin' },
];

function input(overrides = {}) {
  const trigger = chatLine('m1', NOW - MIN, { authorName: 'Nikos', content: 'θυμάσαι το βιβλίο;' });
  return {
    config: fakeConfig(),
    prompts: prompts(),
    calibrator: { ratio: 1, apply: (n: number) => n },
    mode: 'reply',
    now: NOW,
    selfName: 'Zoë',
    history: [trigger],
    neighbors: [],
    trigger,
    triggerKind: 'mention',
    placeMemory: {},
    interlocutor: null,
    otherProfiles: [],
    channels: CHANNELS,
    currentChannelId: HERE,
    participation: { state: state(), pickedIds: [], audience: () => true, channelName: () => null },
    ...overrides,
  };
}

const textOf = (request: Built) => contentText(request.messages[1].content);
const blockOf = (text: string, tag: string) => {
  const start = text.indexOf(`<${tag}>\n`);
  return start === -1 ? null : text.slice(start + tag.length + 3, text.indexOf(`\n</${tag}>`, start));
};
const clock = (ts: number) => formatClock(ts, TZ, labels.locale);

test('participation block: header, channel lines once per channel, episodes with their age, lines in the transcript form', () => {
  const request = buildRequest(input());
  const body = blockOf(textOf(request), 'participation');
  assert.equal(
    body,
    [
      fill(labels.participation.header, { hours: 72 }),
      '#jardin:',
      '30 min ago:',
      `[${clock(NOW - 30 * MIN)}] Zoë (you): ωραία λουλούδια [image: a red tulip]`,
      '#journal (a reading log):',
      '2 h ago:',
      // Slice 2 (b): a line shows one clock and no age, the episode header above keeps its own `2 h ago`.
      `[${clock(NOW - 2 * HOUR - MIN)}] Ana: πού είναι το βιβλίο;`,
      // Slice 2 (b): a line shows one clock and no age, the episode header above keeps its own `2 h ago`.
      `[${clock(NOW - 2 * HOUR)}] Zoë (you): στο ράφι`,
    ].join('\n')
  );
  assert.ok(!body.includes('#1 ') && !body.includes('#2 '), 'no #n index');
  assert.deepEqual(
    { ...request.stats.participation, used: undefined },
    { used: undefined, kept: 3, dropped: 0, offered: 2, shown: 2, cut: 0, deduped: 0 }
  );
});

test('participation block: right after <recent>, before <other_channels>, in the tail', () => {
  const recentLines = [
    {
      id: 1,
      at: NOW - HOUR,
      addedAt: new Date(NOW).toISOString(),
      placeId: HERE,
      text: 'σημείωση',
      who: [],
      weight: 2,
    },
  ];
  const neighbors = [
    { placeId: 'c4', channelName: 'next', messages: [chatLine('n1', NOW - 2 * MIN, { placeId: 'c4' })] },
  ];
  const text = textOf(buildRequest(input({ recentLines, neighbors })));
  const recent = text.indexOf('<recent>');
  const participation = text.indexOf('<participation>');
  const others = text.indexOf('<other_channels>');
  assert.ok(recent !== -1 && participation > recent && others > participation, text);
  assert.ok(participation > text.indexOf('<people>') || text.indexOf('<people>') === -1);
});

test('participation block: the senses line is there with the block and gone without it', () => {
  const sense = labels.senses.participation;
  // A per-turn line: in the tail's <senses>, never in a cached part.
  const parts = buildRequest(input()).messages[1].content.filter((part: Part) => part.type === 'text');
  assert.ok(blockOf(parts.at(-1)!.text, 'senses')!.includes(sense));
  assert.ok(parts.filter((part: Part) => part.cacheSegment).every((part: Part) => !part.text.includes(sense)));
  const empty = textOf(
    buildRequest(input({ participation: { state: { episodes: [], nextId: 1 }, audience: () => true } }))
  );
  assert.ok(!empty.includes(sense) && !empty.includes('<participation>'));
});

test('participation block: a missing header or episode label means no block and no senses line', () => {
  for (const key of ['header', 'episode']) {
    const partial = { ...labels, participation: { ...labels.participation, [key]: '' } };
    const text = textOf(buildRequest(input({ prompts: prompts(partial) })));
    assert.equal(blockOf(text, 'participation'), null, key);
    assert.ok(!text.includes(labels.senses.participation), key);
  }
});

test('participation block: never in a private chat', () => {
  const trigger = chatLine('d1', NOW - MIN, { content: 'θυμάσαι το βιβλίο;' });
  const text = textOf(
    buildRequest(
      input({
        history: [trigger],
        trigger,
        triggerKind: 'private',
        currentChannelId: 'dm1',
        privateChat: { accountId: 'a-d1' },
      })
    )
  );
  assert.equal(blockOf(text, 'participation'), null);
  assert.ok(!text.includes(labels.senses.participation));
});

test('participation block: the audience and the current channel decide what is offered', () => {
  const onlyJardin = textOf(
    buildRequest(input({ participation: { state: state(), audience: (id: string) => id === 'c3' } }))
  );
  assert.ok(onlyJardin.includes('#jardin:') && !onlyJardin.includes('#journal'));
  const fromJournal = textOf(buildRequest(input({ currentChannelId: 'c2' })));
  assert.ok(!blockOf(fromJournal, 'participation')!.includes('#journal'), 'never the current channel');
  const noAudience = textOf(buildRequest(input({ participation: { state: state() } })));
  assert.equal(blockOf(noAudience, 'participation'), null, 'no audience predicate offers nothing');
});

test('participation block: a line shown in the chat, a neighbour or a pulled channel is dropped; an episode without an own line goes', () => {
  // a1 (a member's line of p1) is in the chat: dropped, p1 stays.
  const trigger = chatLine('m1', NOW - MIN, { content: 'θυμάσαι;' });
  const inChat = buildRequest(input({ history: [chatLine('a1', NOW - 2 * HOUR - MIN), trigger], trigger }));
  const chatBody = blockOf(textOf(inChat), 'participation');
  assert.ok(!chatBody!.includes('πού είναι το βιβλίο;') && chatBody!.includes('στο ράφι'));
  assert.equal(inChat.stats.participation.deduped, 1);
  // b1 (p2's only own line) is a neighbour's line: p2 goes whole.
  const neighbors = [
    { placeId: 'c4', channelName: 'next', messages: [chatLine('b1', NOW - 30 * MIN, { placeId: 'c4' })] },
  ];
  const inNeighbor = buildRequest(input({ neighbors }));
  const neighborBody = blockOf(textOf(inNeighbor), 'participation');
  assert.ok(!neighborBody!.includes('#jardin') && neighborBody!.includes('#journal'));
  assert.equal(inNeighbor.stats.participation.cut, 1);
  // a2 (p1's own line) in a pulled channel: p1 goes.
  const pulled = [
    {
      placeId: 'c5',
      channelName: 'pulled',
      messages: [chatLine('a2', NOW - 2 * HOUR, { placeId: 'c5' })],
      descriptions: new Map(),
      readOnly: false,
    },
  ];
  const inPulled = buildRequest(input({ pulled }));
  const pulledBody = blockOf(textOf(inPulled), 'participation');
  assert.ok(textOf(inPulled).includes('<channel_view>'), 'the pulled channel is shown');
  assert.ok(!pulledBody!.includes('#journal') && pulledBody!.includes('#jardin'), pulledBody!);
});

test('participation block: context.caps.participation cuts whole episodes, the picked one kept', () => {
  const probe = buildRequest(input({ participation: { state: state(), pickedIds: ['p1'], audience: () => true } }));
  const cap = probe.stats.participation.used - 3;
  const request = buildRequest(
    input({
      config: fakeConfig({ caps: { participation: cap } }),
      participation: { state: state(), pickedIds: ['p1'], audience: () => true },
    })
  );
  const body = blockOf(textOf(request), 'participation');
  assert.ok(body!.includes('#journal (a reading log):') && !body!.includes('#jardin'), body!);
  assert.equal(request.stats.participation.shown, 1);
  assert.equal(request.stats.participation.cut, 1);
  const none = buildRequest(input({ config: fakeConfig({ caps: { participation: 5 } }) }));
  assert.equal(blockOf(textOf(none), 'participation'), null, 'the header alone makes no block');
  assert.ok(!textOf(none).includes(labels.senses.participation));
});

test('participation block: a long episode is cut to episodeChars, keeping lines that share a word with the candidate', () => {
  const long = {
    id: 'p3',
    placeId: 'c3',
    continues: null,
    messages: [
      stored('c1m', NOW - 50 * MIN, { text: 'αρχή της κουβέντας εδώ' }),
      stored('c2m', NOW - 49 * MIN, { text: 'x'.repeat(600) }),
      stored('c3m', NOW - 48 * MIN, { text: 'y'.repeat(600) }),
      stored('c4m', NOW - 47 * MIN, { text: 'μιλάμε για ποδήλατο τώρα' }),
      stored('c5m', NOW - 46 * MIN, { text: 'z'.repeat(600) }),
      stored('c6m', NOW - 45 * MIN, { text: 'w'.repeat(600) }),
      stored('c7m', NOW - 44 * MIN, { self: true, text: 'εντάξει' }),
    ],
  };
  const trigger = chatLine('m1', NOW - MIN, { content: 'το Ποδήλατο;' });
  // PR 7d: `participation.episodeChars` is the constant 1800, so the lines between are 600 characters each.
  const request = buildRequest(
    input({
      history: [trigger],
      trigger,
      participation: { state: { episodes: [long], nextId: 4 }, audience: () => true },
    })
  );
  const body = blockOf(textOf(request), 'participation');
  assert.ok(body!.includes('μιλάμε για ποδήλατο τώρα'), 'the line sharing a word with the candidate is kept');
  assert.ok(body!.includes('εντάξει'), "the persona's own line is kept");
  assert.ok(
    body!.includes(fill(labels.participation.skipped, { count: 1 })) ||
      body!.includes(fill(labels.participation.skipped, { count: 2 })),
    body!
  );
});

test('participation block: a channel with no stored name takes the live name, and no name at all drops it', () => {
  const names: Record<string, string> = { c3: 'jardin-live' };
  const live = blockOf(
    textOf(
      buildRequest(
        input({
          channels: [],
          participation: { state: state(), audience: () => true, channelName: (id: string) => names[id] ?? null },
        })
      )
    ),
    'participation'
  );
  assert.ok(live!.includes('#jardin-live:') && !live!.includes('journal'));
});

// --- <earlier>: this channel's lines the chat window let go of ----------------------

/** p7 in the current channel: Ana asks 40 min ago, the persona answers, Nikos follows. */
function hereEpisode() {
  return {
    id: 'p7',
    placeId: HERE,
    continues: null,
    messages: [
      stored('e1', NOW - 40 * MIN, { text: 'θα το στείλεις στο άλλο κανάλι;' }),
      stored('e2', NOW - 39 * MIN, { self: true, text: 'ναι, εντάξει' }),
      stored('e3', NOW - 20 * MIN, { name: 'Nikos', authorId: 'u2', text: 'τέλεια' }),
    ],
  };
}

const selfLabel = () => fill(labels.self, { name: 'Zoë' });

/** The config of the anchored window (code, PR 7d), which `<earlier>` belongs to. */
const anchoredConfig = (rest = {}) => fakeConfig(rest);

test('earlier block: the stored lines of this channel older than the chat, in the tail after <participation>, before <chat>', () => {
  const window = [chatLine('m0', NOW - 30 * MIN), chatLine('m1', NOW - MIN, { content: 'θυμάσαι;' })];
  const request = buildRequest(
    input({
      config: anchoredConfig(),
      history: window,
      trigger: window[1],
      participation: { state: state([hereEpisode()]), audience: () => true },
    })
  );
  const text = textOf(request);
  assert.equal(
    blockOf(text, 'earlier'),
    [
      fill(labels.participation.earlierHeader, { hours: 3 }),
      `[${clock(NOW - 40 * MIN)}] Ana: θα το στείλεις στο άλλο κανάλι;`,
      `[${clock(NOW - 39 * MIN)}] ${selfLabel()}: ναι, εντάξει`,
    ].join('\n'),
    'e3 is younger than the window start: it is not repeated'
  );
  const at = (tag: string) => text.indexOf(`<${tag}>`);
  assert.ok(at('participation') !== -1 && at('earlier') > at('participation') && at('chat') > at('earlier'), text);
  const parts = request.messages[1].content.filter((part: Part) => part.type === 'text');
  assert.ok(
    parts.filter((part: Part) => part.cacheSegment).every((part: Part) => !part.text.includes('<earlier>')),
    'never in a cached part'
  );
  assert.ok(parts.at(-1)!.text.includes('<earlier>') && !parts.at(-1)!.cacheSegment);
  assert.ok(!blockOf(text, 'participation')!.includes('εντάξει'), 'the current channel stays out of <participation>');
});

test('earlier block: the same stretch renders the same text as turns go by; a stored line leaving the chat joins it', () => {
  const st = state([hereEpisode()]);
  const turn = (history: Array<unknown>, now: number) =>
    blockOf(
      textOf(
        buildRequest(
          input({
            config: anchoredConfig(),
            now,
            history,
            trigger: history.at(-1),
            participation: { state: st, audience: () => true },
          })
        )
      ),
      'earlier'
    );
  const first = turn([chatLine('m0', NOW - 30 * MIN), chatLine('m1', NOW - MIN)], NOW);
  // Five minutes on, the window lost m0 (not stored) and starts at m5, still before e3: nothing stored crossed it.
  const second = turn(
    [chatLine('m5', NOW - 25 * MIN), chatLine('m1', NOW - MIN), chatLine('m2', NOW + 4 * MIN)],
    NOW + 5 * MIN
  );
  assert.equal(second, first);
  // Lines past context.ageAfterMinutes keep their bare clock: an hour on, the same text.
  assert.equal(turn([chatLine('m5', NOW - 25 * MIN), chatLine('m6', NOW + HOUR)], NOW + HOUR), first);
  // Once the window starts after e3, e3 joins the block and nothing else moves.
  const third = turn([chatLine('m3', NOW - 10 * MIN), chatLine('m4', NOW - MIN)], NOW);
  assert.equal(third, [first, `[${clock(NOW - 20 * MIN)}] Nikos: τέλεια`].join('\n'));
});

// PR 7d: `participation.earlierHours` (3) and the switch are constants and code, so the bound is not moved here.
test('earlier block: off without the label and in a private chat', () => {
  const window = [chatLine('m1', NOW - MIN)];
  const run = (overrides: Record<string, unknown>) =>
    blockOf(
      textOf(
        buildRequest(
          input({
            config: anchoredConfig(),
            history: window,
            trigger: window[0],
            participation: { state: state([hereEpisode()]), audience: () => true },
            ...overrides,
          })
        )
      ),
      'earlier'
    );
  assert.ok(run({})!.includes('τέλεια'));
  assert.equal(
    run({ prompts: prompts({ ...labels, participation: { ...labels.participation, earlierHeader: '' } }) }),
    null
  );
  assert.equal(run({ privateChat: { accountId: 'a-m1' }, triggerKind: 'private' }), null);
});

test('earlier block: the newest episodes win the cap, rendered oldest first with the gap label between them', () => {
  const older = {
    id: 'p6',
    placeId: HERE,
    continues: null,
    messages: [stored('o1', NOW - 90 * MIN, { self: true, text: 'παλιό' })],
  };
  const window = [chatLine('m1', NOW - MIN)];
  const run = (config: object) =>
    buildRequest(
      input({
        config,
        history: window,
        trigger: window[0],
        participation: { state: state([older, hereEpisode()]), audience: () => true },
      })
    );
  const both = blockOf(textOf(run(anchoredConfig())), 'earlier');
  assert.ok(
    both!.indexOf('παλιό') < both!.indexOf(`\n${labels.participation.earlierGap}\n`) &&
      both!.indexOf(labels.participation.earlierGap) < both!.indexOf('εντάξει'),
    both!
  );
  const used = run(anchoredConfig()).stats.earlier.used;
  const tight = blockOf(textOf(run(anchoredConfig({ caps: { earlier: used - 5 } }))), 'earlier');
  assert.ok(tight!.includes('εντάξει') && !tight!.includes('παλιό'), tight!);
});
