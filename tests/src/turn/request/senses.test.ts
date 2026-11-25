// Tests for src/turn/request/senses.ts: what the persona is told about looking things up in each search configuration,
// and the line of the abilities that are off.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fill } from '../../../../src/format.ts';
import { renderSenses } from '../../../../src/turn/request/senses.ts';
import { chainsOf } from '../../../fixtures/chains.ts';
import { labels } from '../../../fixtures/labels.ts';
import { fakeConfig, framed, MIN, NOW, baseInput, fakePrompts, makeMessage } from '../../../fixtures/prompt-rig.ts';
import { userText as textOf, skillsInventoryText } from '../../../../src/behavior/prompt.ts';
import { buildRequest } from '../../../fixtures/built-request.ts';
import type { Built, Part } from '../../../fixtures/built-request.ts';
import { createRoleHealth } from '../../../../src/llm/role-health.ts';
import { createDescriber } from '../../../../src/memory/describe.ts';
import { NOW as HARNESS_NOW, coreTurn, fakeStore } from '../../../fixtures/turn-harness.ts';
import { objectMediaCache } from '../../../../src/memory/store-media.ts';

function linesOf(enabled: boolean, searchAvailable: boolean, toolsGranted: Array<string>): Array<string> {
  const config = { web: { quickSearch: { enabled } } } as Parameters<typeof renderSenses>[0];
  const { stable, turn } = renderSenses(config, labels, { searchAvailable, toolsGranted });
  return [stable, turn].filter(Boolean).join('\n').split('\n');
}

test('the persona is told the way they have: quick alone, deep alone, both, or neither, and a known page stays readable', () => {
  // Bug: with quick search off the persona is told nothing, or told a search exists when no way does.
  const { searchTool, deepSearchTool, readTool } = labels.senses;
  const quick = linesOf(true, true, ['web.search']);
  assert.ok(quick.includes(searchTool) && !quick.includes(deepSearchTool));
  const deep = linesOf(false, true, ['web.search', 'errand.scout']);
  assert.ok(deep.includes(deepSearchTool) && !deep.includes(searchTool));
  const both = linesOf(true, true, ['web.search', 'errand.scout']);
  assert.ok(both.includes(searchTool) && !both.includes(deepSearchTool));
  const neither = linesOf(false, false, ['web.read']);
  assert.ok(!neither.includes(searchTool) && !neither.includes(deepSearchTool));
  assert.ok(neither.includes(readTool));
});

// ---- the line of the abilities that are off ---------------------------------------------------------------------

// An optional model role with a null model is off (src/llm/roles.ts#offRoles). While one is, the stable half of
// `<senses>` carries one line naming the abilities that are down, in the words of `labels.tools.result.params.ability`.
// The labels here are this file's own words.

const OFF_LINE = 'Down for you at the moment: {abilities}.';
const SEPARATOR = ' and ';
const WORDS = {
  imagesIn: 'looking at pictures',
  videoIn: 'watching videos',
  imagesOut: 'drawing',
  audioOut: 'voice messages',
};

/** The fixture labels with the off line, its separator and the ability words. */
const OFF_LABELS = {
  ...labels,
  senses: { ...labels.senses, abilitiesOff: OFF_LINE, abilitiesOffSeparator: SEPARATOR },
  tools: { ...labels.tools, result: { ...labels.tools.result, params: { ability: WORDS } } },
};

const ALL_ON = { vision: 'x/v', video: 'x/w', drawing: 'x/d', speech: 'x/s' };

/** The request config with a chain for each role of `base` that names a model. */
const configWith = (base: Record<string, unknown>) => ({ ...fakeConfig(), models: { routes: chainsOf(base) } });

/** The line for these abilities, as the label fills it. */
const lineOf = (...abilities: Array<keyof typeof WORDS>) =>
  fill(OFF_LINE, { abilities: abilities.map((ability) => WORDS[ability]).join(SEPARATOR) });

// Bug caught: a deployment with every role on getting a new line, which moves its cached request and its replies.
// An optional role with no chain is off, so a config with no models differs from one with every role on.
test('renderSenses: with every optional role on, no line names an ability that is down', () => {
  const on = renderSenses(configWith(ALL_ON), OFF_LABELS);
  assert.equal(`${on.stable}\n${on.turn}`.includes('Down for you'), false);
});

// Bug caught: the line absent, so the persona claims to see pictures they are not given, or names roles in a random
// order.
test('renderSenses: off roles add one stable line naming their abilities in the order vision, video, drawing, speech', () => {
  const bare = renderSenses(configWith(ALL_ON), OFF_LABELS);
  const off = renderSenses(configWith({ speech: null, drawing: null, video: 'x/w', vision: null }), OFF_LABELS);
  const line = lineOf('imagesIn', 'imagesOut', 'audioOut');
  assert.equal(off.stable.split('\n').filter((entry) => entry === line).length, 1);
  assert.equal(
    off.stable
      .split('\n')
      .filter((entry) => entry !== line)
      .join('\n'),
    bare.stable,
    'nothing else moved'
  );
  assert.equal(off.turn, bare.turn, 'the per-turn half is untouched');
});

// Bug caught: the line placed in the per-turn half, which would break the prompt cache's stable part every turn.
test('renderSenses: the line sits right after the files line', () => {
  const lines = renderSenses(configWith({ ...ALL_ON, video: null }), OFF_LABELS).stable.split('\n');
  const at = lines.indexOf(labels.senses.files);
  assert.ok(at >= 0);
  assert.equal(lines[at + 1], lineOf('videoIn'));
});

// Bug caught: false and null read differently, so a role set off the old way is announced as on.
test('renderSenses: a false model counts as off like a null one', () => {
  const lines = renderSenses(configWith({ ...ALL_ON, vision: false }), OFF_LABELS).stable.split('\n');
  assert.ok(lines.includes(lineOf('imagesIn')));
});

const DIARY_NOW = Date.UTC(2026, 8, 20, 10, 0, 0);

const DIARY_MIN = 60_000;

function identityCalibrator() {
  return { ratio: 1, apply: (n: number) => n };
}

function diaryPrompts(overrides: Record<string, unknown> = {}) {
  return {
    main: 'SYSTEM_TEXT for {{name}}',
    persona: 'CARD_TEXT',
    rules: 'RULES_TEXT',
    format: 'FORMAT_TEXT',
    'turn/reply': 'REPLY_TASK',
    interject: 'INTERJECT_TASK',
    'diary/task': 'DIARY_TASK for {{name}}',
    labels,
    ...overrides,
  };
}

function diaryConfig(overrides: { context?: object; features?: object; llm?: object; diary?: object } = {}) {
  return {
    bot: { timezone: 'UTC' },
    context: {
      gapMarkerMinutes: 20,
      maxMessageChars: 800,
      caps: { interlocutor: 2500, aboutChat: 2500, people: 4000, neighbors: 3000, server: 2500, lore: 1500 },
      vision: { maxImages: 2, tokensPerImage: 400, imageSize: 512, recentImages: 0, recentImageMinutes: 0 },
      tempo: { liveMessages10min: 4, deadSilenceMinutes: 45 },
      ...overrides.context,
    },
    features: {
      vision: true,
      relationships: true,
      episodes: true,
      lore: true,
      recent: true,
      imageGeneration: true,
      ...overrides.features,
    },
    llm: { maxRequestTokens: 50000, safetyMargin: 0.9, ...overrides.llm },
    memory: { recentHours: 72 },
    diary: { historyPosts: 150, ...overrides.diary },
  };
}

function diaryMessage(id: number | string, ts: number, overrides = {}) {
  return {
    id: String(id),
    ts,
    authorId: `author-${id}`,
    authorName: `User${id}`,
    self: false,
    content: `content of message ${id}`,
    attachments: [],
    stickers: [],
    replyToId: null,
    ...overrides,
  };
}

function diaryInput(overrides = {}) {
  const input = {
    config: diaryConfig(),
    prompts: diaryPrompts(),
    calibrator: identityCalibrator(),
    mode: 'reply',
    now: DIARY_NOW,
    selfName: 'Nept',
    history: [diaryMessage(1, DIARY_NOW - DIARY_MIN)],
    neighbors: [],
    trigger: null,
    triggerKind: null,
    placeMemory: {},
    interlocutor: null,
    otherProfiles: [],
    ...overrides,
  };
  // Every request is built on its turn frame (slice 7).
  return framed(input);
}

// The whole user text, every cache part: the stable part always carries the static senses lines.
const userText = (request: Built) => {
  const message = request.messages[1];
  return textOf(message.content);
};

test('renderSenses: names the diary channel when set', () => {
  const text = userText(buildRequest(diaryInput({ diaryChannel: 'ημερολόγιο' })));
  assert.ok(text.includes(fill(labels.senses.diary, { channel: 'ημερολόγιο' })), text);
});

test('renderSenses: does not name the diary channel when unset', () => {
  for (const diaryChannel of [undefined, null, '']) {
    const text = userText(buildRequest(diaryInput({ diaryChannel })));
    assert.ok(!text.includes(fill(labels.senses.diary, { channel: '' }).slice(0, 20)), String(diaryChannel));
  }
});

// --- <senses> ------------------------------------------------------------

/** The `<senses>` bodies of a request: the stable part's (`stable`) and the tail's (`turn`), '' when absent. */
function sensesHalves(request: Built) {
  const message = request.messages[1];
  const parts = message.content.filter((part) => part.type === 'text');
  const bodyIn = (part: Part | undefined) =>
    part ? (/<senses>\n([\s\S]*?)\n<\/senses>/.exec(part.text)?.[1] ?? '') : '';
  return {
    stable: bodyIn(parts.find((part) => part.cacheSegment === 'stable')),
    turn: bodyIn(parts.find((part) => !part.cacheSegment)),
  };
}

/** Every `<senses>` line of a request, the stable half first; null with no block at all. */
function sensesOf(request: Built) {
  const { stable, turn } = sensesHalves(request);
  return [stable, turn].filter(Boolean).join('\n') || null;
}

test('buildRequest: the senses carry the described forms of pictures, GIFs and videos', () => {
  // PR 7d: the descriptions are code, so there are no blind forms and the video line is videoWatch.
  const senses = sensesOf(buildRequest(baseInput()));
  assert.ok(senses!.includes(labels.senses.imageDescribed));
  assert.ok(senses!.includes(labels.senses.videoWatch));
  assert.ok(!senses!.includes(labels.senses.videoDescribed));
});

// --- <senses>: GIF watching -------------------------------------------------------

/** The GIF line of a request's <senses> block under `config` and `prompts` overrides. */
function gifSenses({
  prompts = {},
  labelsOverride,
}: { prompts?: Record<string, unknown>; labelsOverride?: object } = {}) {
  const config = fakeConfig();
  const promptSet = fakePrompts({ ...(labelsOverride ? { labels: labelsOverride } : {}), ...prompts });
  return sensesOf(buildRequest(baseInput({ config, prompts: promptSet })))!.split('\n');
}

// A GIF is never described from one frame.
test('buildRequest: GIFs watched (video vision on, a watch prompt) -> senses.gifWatched', () => {
  for (const prompts of [
    { 'describe/video': 'V' },
    { 'describe/gif': 'G' },
    { 'describe/video': 'V', 'describe/gif': 'G' },
  ]) {
    const lines = gifSenses({ prompts });
    assert.ok(lines.includes(labels.senses.gifWatched), JSON.stringify(Object.keys(prompts)));
  }
});

// A GIF is never described from one frame.
test('buildRequest: no <senses> line tells of a single GIF frame, GIFs watched or not', () => {
  const frameLine = 'STAND-IN: a GIF is one frame';
  const labelsOverride = { ...labels, senses: { ...labels.senses, gifDescribed: frameLine } };
  for (const prompts of [{ 'describe/video': 'V' }, {}, { 'describe/video': '' }]) {
    const lines = gifSenses({ prompts, labelsOverride });
    assert.ok(!lines.includes(frameLine), JSON.stringify(prompts));
  }
});

// --- <senses>: video watching ---------------------------------------------------

test('buildRequest: the senses carry videoWatch and linksWatch', () => {
  const senses = sensesOf(buildRequest(baseInput()));
  assert.ok(senses!.includes(labels.senses.videoWatch));
  assert.ok(senses!.includes(labels.senses.linksWatch));
  assert.ok(!senses!.includes(labels.senses.videoDescribed));
  assert.ok(!senses!.split('\n').includes(labels.senses.links));
});

// --- <senses>: stickers/Lottie -----------------------------------------------

// Slice 7: the Lottie sentence left the shared senses for the Discord interface's own text.
test('buildRequest: the senses carry stickerDescribed and no Lottie line', () => {
  const request = buildRequest(baseInput());
  const senses = sensesOf(request);
  assert.ok(senses!.includes(labels.senses.stickerDescribed));
  assert.ok(!senses!.includes(labels.senses.lottie));
});

// --- the web lookup: <lookup>, read links, senses -----------------------------------

function webConfig(web: { links?: object; search?: object } = {}) {
  const config: ReturnType<typeof fakeConfig> & { web?: object } = fakeConfig();
  config.web = { links: { enabled: true, ...web.links }, quickSearch: { enabled: true, ...web.search } };
  return config;
}

test('buildRequest: the links line stays and linksRead follows it; a search key and the grant -> the search line after that', () => {
  const senses = sensesOf(
    buildRequest(baseInput({ config: webConfig(), searchAvailable: true, toolsGranted: ['web.search'] }))
  )!.split('\n');
  const at = senses.indexOf(labels.senses.linksWatch);
  assert.ok(at !== -1, 'the links line is the same as without the lookup');
  assert.equal(senses[at + 1], labels.senses.linksRead);
  assert.equal(senses[at + 2], labels.senses.searchTool);
  assert.equal(senses[at + 3], labels.senses.files);
});

test('buildRequest: the search line needs searchAvailable and the grant -- no key, no grant or searchAvailable omitted shows no search line', () => {
  for (const [searchAvailable, toolsGranted] of [
    [false, ['web.search']],
    [undefined, ['web.search']],
    [true, []],
  ]) {
    const senses = sensesOf(buildRequest(baseInput({ config: webConfig(), searchAvailable, toolsGranted })))!.split(
      '\n'
    );
    assert.ok(!senses.includes(labels.senses.searchTool));
    assert.ok(senses.includes(labels.senses.linksRead), 'reading links needs no search key');
  }
});

test('buildRequest: search disabled -> no search line even with a key and the grant', () => {
  const noSearch = sensesOf(
    buildRequest(
      baseInput({
        config: webConfig({ search: { enabled: false } }),
        searchAvailable: true,
        toolsGranted: ['web.search'],
      })
    )
  )!.split('\n');
  assert.ok(noSearch.includes(labels.senses.linksRead));
  assert.ok(!noSearch.includes(labels.senses.searchTool));
});

// Slice 7: the request is built on its frame, whose cached `<self>` holds both halves of the senses
// (docs/prompt-contract.md), so the order is read in the one block: the per-turn lines close it.
test('buildRequest: recallAvailable true and the grant -> the recall line leads the per-turn senses, before the drawing line', () => {
  const request = buildRequest(
    baseInput({
      config: webConfig(),
      searchAvailable: true,
      recallAvailable: true,
      drawOn: true,
      toolsGranted: ['web.search', 'memory.search'],
    })
  );
  const lines = sensesOf(request)!.split('\n');
  const at = lines.indexOf(labels.senses.searchTool);
  assert.ok(at !== -1);
  assert.equal(lines[at + 1], labels.senses.files, 'the search line stays among the config lines');
  assert.deepEqual(lines.slice(-2), [labels.senses.recallTool, labels.senses.draw]);
});

test('buildRequest: no recall line unless recallAvailable is true and the grant is there', () => {
  for (const [recallAvailable, toolsGranted] of [
    [false, ['memory.search']],
    [undefined, ['memory.search']],
    [null, ['memory.search']],
    [true, []],
  ]) {
    const senses = sensesOf(
      buildRequest(baseInput({ config: webConfig(), searchAvailable: true, recallAvailable, toolsGranted }))
    )!.split('\n');
    assert.ok(!senses.includes(labels.senses.recallTool), String(recallAvailable));
  }
});

test('buildRequest: a private chat shows the recall line when the turn says recall is available, none otherwise', () => {
  const toolsGranted = ['memory.search'];
  const on = sensesOf(buildRequest(privateScene({ recallAvailable: true, toolsGranted })))!.split('\n');
  assert.ok(on.includes(labels.senses.recallTool));
  const off = sensesOf(buildRequest(privateScene({ recallAvailable: false, toolsGranted })))!.split('\n');
  assert.ok(!off.includes(labels.senses.recallTool));
});

// Slice 7: on the frame both halves of the senses sit in the cached `<self>` (docs/prompt-contract.md), so the draw
// line is the last line of the one block rather than a line of the tail.
test('renderSenses: draw line shows when the persona can draw', () => {
  const lines = sensesOf(buildRequest(baseInput({ drawOn: true })))!.split('\n');
  assert.equal(lines.at(-1), labels.senses.draw);
  assert.ok(lines.includes(labels.senses.files));
});

// PR 7d: the daily picture quota is gone, so the input says only whether the persona can draw (`drawOn`).
test('renderSenses: draw line is absent without drawOn (no image client wired)', () => {
  assert.ok(!sensesOf(buildRequest(baseInput()))!.includes(labels.senses.draw));
});

// --- private chat (dmChat) ------------------------------------------------

function privateScene(overrides: Record<string, unknown> = {}) {
  const trigger = makeMessage(1, NOW - MIN, { authorId: 'u1', authorName: 'Alice' });
  return baseInput({
    history: [trigger],
    trigger,
    triggerKind: 'private',
    prompts: fakePrompts({ 'turn/private': 'PRIVATE_TASK for {{name}} with {{author}}' }),
    dmChat: { accountId: 'u1' },
    interlocutor: {
      id: 'u1',
      names: ['Alice'],
      relationship: 'PUBLIC_REL',
      details: [{ id: 1, text: 'PUBLIC_DETAIL', weight: 1 }],
      affinity: { score: 10, reason: 'public reason', history: [] },
    },
    privateProfile: {
      relationship: 'PRIVATE_REL',
      details: [{ id: 1, text: 'PRIVATE_DETAIL', weight: 1 }],
      affinity: { score: 5, reason: 'private reason', history: [] },
    },
    channels: [{ id: 'c1', name: 'general', lastMessageAt: NOW, days: {} }],
    currentChannelId: 'c1',
    neighbors: [{ placeId: 'c1', channelName: 'general', messages: [makeMessage(9, NOW - 5 * MIN)] }],
    ...overrides,
  });
}

test('buildRequest: <senses> carries senses.dmChat in a private chat, never senses.privateAware', () => {
  for (const enabled of [true, false, undefined]) {
    const config = fakeConfig({ dm: { enabled } });
    const senses = sensesOf(buildRequest(privateScene({ config })));
    assert.ok(senses!.includes(labels.senses.dmChat));
    assert.ok(!senses!.includes(labels.senses.privateAware));
  }
});

test('buildRequest: with context.memory.openPrivate on, the private wording is the open one in a private chat and a group', () => {
  // Bug: the switch opens the persona's memory while the frame still orders them to keep each private chat out of every other place.
  const open = { context: { memory: { openPrivate: true } } };
  const dm = buildRequest(privateScene({ config: fakeConfig(open) }));
  const dmSenses = sensesOf(dm)!;
  assert.ok(dmSenses.includes(labels.senses.dmChatOpen) && !dmSenses.includes(labels.senses.dmChat));
  // Changed: the task of a private chat is one prompt whatever the switch, so the open wording lives in the senses
  // alone; the next test holds the task to `turn/private`.
  const group = sensesOf(buildRequest(baseInput({ config: fakeConfig({ ...open, dm: { enabled: true } }) })))!;
  assert.ok(group.includes(labels.senses.privateAwareOpen) && !group.includes(labels.senses.privateAware));
});

test('buildRequest: <senses> carries senses.privateAware outside a private chat only when dm.enabled is true', () => {
  const on = sensesOf(buildRequest(baseInput({ config: fakeConfig({ dm: { enabled: true } }) })));
  assert.ok(on!.includes(labels.senses.privateAware));
  assert.ok(!on!.includes(labels.senses.dmChat));
  for (const enabled of [false, undefined, 'yes']) {
    const senses = sensesOf(buildRequest(baseInput({ config: fakeConfig({ dm: { enabled } }) })));
    assert.ok(!senses!.includes(labels.senses.privateAware));
    assert.ok(!senses!.includes(labels.senses.dmChat));
  }
});

test('buildRequest: senses carry the time line right after the files line, in a private chat too', () => {
  const server = sensesOf(buildRequest(baseInput()))!.split('\n');
  assert.equal(server[server.indexOf(labels.senses.files) + 1], labels.senses.time);
  const privateLines = sensesOf(buildRequest(privateScene()))!.split('\n');
  assert.equal(privateLines[privateLines.indexOf(labels.senses.files) + 1], labels.senses.time);
});

test('buildRequest: senses without a time label show no time line', () => {
  const { time, ...olderSenses } = labels.senses;
  const older = sensesOf(
    buildRequest(baseInput({ prompts: fakePrompts({ labels: { ...labels, senses: olderSenses } }) }))
  )!.split('\n');
  assert.ok(!older.includes(time));
  // Slice 7: `senses.channels` is deleted, so a blank time label is checked as no empty line.
  const blank = sensesOf(
    buildRequest(baseInput({ prompts: fakePrompts({ labels: { ...labels, senses: { ...labels.senses, time: '' } } }) }))
  )!.split('\n');
  assert.ok(!blank.includes(time) && !blank.includes(''));
});

// --- the skills granted to the persona, always listed in the stable part ------------------------------

test("skillsInventoryText: each line lists the skill's arguments -- required marked, enum values with the cut shown, a range -- in a stable order", () => {
  const argLabels = {
    ...labels,
    tools: {
      ...labels.tools,
      line: '{name}: {title} -- {whenToUse} ({access}){args}',
      args: { list: ' args: {list}', required: '{arg}*', values: '{arg}={values}', range: '{arg}={min}..{max}' },
    },
  };
  const rows = [
    {
      name: 'memory.journal.read',
      title: 'Διάβασε',
      whenToUse: 'το ημερολόγιο',
      allowed: true,
      reason: 'allowed',
      args: [
        { name: 'day', required: false },
        { name: 'kind', required: false, values: ['turn', 'action'], more: true },
        { name: 'n', required: false, minimum: 1, maximum: 50 },
      ],
    },
    {
      name: 'message.create',
      title: 'Στείλε',
      whenToUse: 'σε άλλη συζήτηση',
      allowed: true,
      reason: 'carried-over',
      args: [
        { name: 'channel', required: false },
        { name: 'text', required: true },
      ],
    },
    {
      name: 'memory.server.read',
      title: 'Θυμήσου',
      whenToUse: 'τον server',
      allowed: true,
      reason: 'allowed',
      args: [],
    },
    {
      name: 'rule.remove',
      title: 'Ξέχνα',
      whenToUse: 'ένα μάθημα',
      allowed: true,
      reason: 'allowed',
      args: [
        { name: 'number', required: true, minimum: 1 },
        { name: 'detail', required: false, values: ['true', 'false'] },
      ],
    },
    {
      name: 'memory.wipe',
      title: 'Σβήσε',
      whenToUse: 'ποτέ',
      allowed: false,
      reason: 'not-grantable',
      args: [{ name: 'confirm', required: true }],
    },
  ];
  const text = skillsInventoryText(rows, argLabels);
  assert.deepEqual(text.split('\n'), [
    'memory.journal.read: Διάβασε -- το ημερολόγιο (allowed) args: day, kind=turn|action|…, n=1..50',
    'memory.server.read: Θυμήσου -- τον server (allowed)',
    '',
    'message.create: Στείλε -- σε άλλη συζήτηση (allowed here) args: channel, text*',
    '',
    'rule.remove: Ξέχνα -- ένα μάθημα (allowed) args: number=1..*, detail=true|false',
  ]);
  assert.equal(skillsInventoryText(rows, argLabels), text, 'the same rows, the same text');
  // Without the args labels the slot is empty; a missing form leaves the bare name.
  const bare = skillsInventoryText(rows.slice(0, 1), {
    ...argLabels,
    tools: { ...argLabels.tools, args: undefined },
  });
  assert.equal(bare, 'memory.journal.read: Διάβασε -- το ημερολόγιο (allowed)');
  const listOnly = skillsInventoryText(rows.slice(0, 2), {
    ...argLabels,
    tools: { ...argLabels.tools, args: { list: ' args: {list}' } },
  });
  assert.deepEqual(listOnly.split('\n'), [
    'memory.journal.read: Διάβασε -- το ημερολόγιο (allowed) args: day, kind, n',
    '',
    'message.create: Στείλε -- σε άλλη συζήτηση (allowed here) args: channel, text',
  ]);
  // A row without args (an older caller) renders as before.
  assert.equal(
    skillsInventoryText([{ ...rows[0], args: undefined }], argLabels),
    'memory.journal.read: Διάβασε -- το ημερολόγιο (allowed)'
  );
});

const ABILITY_WORDS = {
  imagesIn: 'A:imagesIn',
  videoIn: 'A:videoIn',
  imagesOut: 'A:imagesOut',
  audioOut: 'A:audioOut',
} as const;

const WHY_WORDS = {
  'no-model': 'W:no-model',
  'no-key': 'W:no-key',
  unauthorized: 'W:unauthorized',
  payment: 'W:payment',
  'not-found': 'W:not-found',
  'daily-limit': 'W:daily-limit',
  malformed: 'W:malformed',
} as const;

type Ability = keyof typeof ABILITY_WORDS;

type Why = keyof typeof WHY_WORDS;

const ROUTE = { fallback: 'core does {ability}: {why}', unavailable: 'gone {ability}: {why}', separator: ' | ' };

const UNAVAILABLE = 'cannot {ability}: {why}; the core cannot either';

/** The fixture labels with the route keys and the `ability-unavailable` reason in this file's own words. */
const labelsTools = labels.tools;
const ROUTE_LABELS = {
  ...labels,
  tools: {
    ...labels.tools,
    route: ROUTE,
    result: {
      ...labels.tools.result,
      reasons: { ...labelsTools.result.reasons, 'ability-unavailable': UNAVAILABLE },
      params: { ability: ABILITY_WORDS, why: WHY_WORDS },
    },
  },
};

/** The words of an `ability-unavailable` result's reason. */
const unavailableReason = (ability: Ability, why: Why): string =>
  fill(UNAVAILABLE, { ability: ABILITY_WORDS[ability], why: WHY_WORDS[why] });

type Run = Awaited<ReturnType<typeof coreTurn>>;

type Message = { role: string; text: string };

/** The text of a message's content, its parts joined. */
function textOfContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part: unknown) => {
      const text: unknown = part !== null && typeof part === 'object' ? Reflect.get(part, 'text') : null;
      return typeof text === 'string' ? text : '';
    })
    .join('');
}

/** The messages of the persona's request `index` in the turn; throws when the turn made no such request. */
function requestOf(run: Run, index: number): Array<Message> {
  const calls: unknown = run.llm.calls;
  const request: unknown = Array.isArray(calls) ? calls[index] : undefined;
  if (!Array.isArray(request)) throw new Error(`the turn made no request ${index}`);
  return request.map((item: unknown) => {
    const role: unknown = item !== null && typeof item === 'object' ? Reflect.get(item, 'role') : null;
    const content: unknown = item !== null && typeof item === 'object' ? Reflect.get(item, 'content') : null;
    return { role: String(role), text: textOfContent(content) };
  });
}

/** How many lines of every message of `request` are exactly `line`. */
const linesEqual = (request: Array<Message>, line: string): number =>
  request.flatMap((message) => message.text.split('\n')).filter((text) => text === line).length;

/** A health tracker on the turn's clock, every key present. */
const healthAt = () => createRoleHealth({ now: () => HARNESS_NOW, hasKey: () => true });

/** Zoë's message m0 (`#1`) carries one picture. */
const PICTURE = new Map([
  [
    'pa',
    {
      id: 'pa',
      contentType: 'image/png',
      name: 'lampe.png',
      url: 'https://cdn.discordapp.com/attachments/1/2/lampe.png',
    },
  ],
]);

const fakePictures = {
  fetchAsDataUrl: () =>
    Promise.resolve({ dataUrl: 'data:image/webp;base64,ZmFrZQ==', bytes: 4, contentType: 'image/webp' }),
};

// ---- roles that are off ----------------------------------------------------------------------------------------------
// An optional role with an empty chain (`models.routes.<role>`) is off. The tools it serves are not in the persona's request's
// `tools`, a picture, GIF or video that needs it is not described, and the request carries the words of the
// `ability-unavailable` answer once for each ability that is down, so the persona can say they cannot see it.

const ON_ROLES = { vision: 'x/vision', video: 'x/video', drawing: 'x/draw', speech: 'x/speech' };

const CORE_AND_TEXT = { core: 'x/core', analyzer: 'x/text' };

// Bug caught: any change to the request of a deployment where every role has a model.
const GIF = new Map([
  [
    'ga',
    {
      id: 'ga',
      contentType: 'image/gif',
      name: 'anim.gif',
      url: 'https://cdn.discordapp.com/attachments/1/2/anim.gif',
    },
  ],
]);

const CLIP = new Map([
  [
    'va',
    {
      id: 'va',
      contentType: 'video/mp4',
      name: 'clip.mp4',
      size: 1000,
      url: 'https://cdn.discordapp.com/attachments/1/2/clip.mp4',
    },
  ],
]);

const DESCRIBE_PROMPTS = {
  'describe/picture': 'Describe it in {{maxChars}}.',
  'describe/video': 'Watch it in {{maxChars}}.',
};

/** A turn whose first message carries `attachments`, with the real describer over a recording model and fetchers. */
async function mediaTurn(base: Record<string, unknown>, attachments: Map<string, unknown>) {
  const described: Array<unknown> = [];
  const describeLlm = {
    complete: (messages: unknown, options: { model?: unknown }) => {
      described.push({ messages, model: options.model });
      return Promise.resolve({ text: 'une chose décrite', usage: {}, estimated: 5 });
    },
  };
  const store = { ...fakeStore(), ...objectMediaCache({}) };
  let turnHot: { config: unknown; prompts: unknown } | null = null;
  const hot = {
    get config() {
      return turnHot?.config;
    },
    get prompts() {
      return turnHot?.prompts;
    },
  };
  const fetched: Array<string> = [];
  const videoFetcher = {
    fetchAttachment: (url: string) => {
      fetched.push(url);
      return Promise.resolve({ ok: false, reason: 'error' });
    },
  };
  const describer = createDescriber({
    hot,
    store,
    llm: describeLlm,
    imageFetcher: fakePictures,
    videoFetcher,
    state: { data: {}, markDirty() {} },
  });
  const run = await coreTurn({
    answers: ['<skip/>'],
    allowed: [],
    firstAttachments: attachments,
    store,
    config: { models: { routes: chainsOf({ ...CORE_AND_TEXT, ...base }) }, media: { maxOutputTokens: 120 } },
    prompts: { ...DESCRIBE_PROMPTS, labels: ROUTE_LABELS },
    runner: { describer, imageFetcher: fakePictures, videoFetcher, roleHealth: healthAt() },
    withHot: (given: { config: unknown; prompts: unknown }) => {
      turnHot = given;
    },
  });
  return { run, described, fetched };
}

/** How many lines of the persona's first request are exactly the words of the ability-unavailable answer for `ability`. */
function toldOnce(run: Run, ability: Ability): number {
  return linesEqual(requestOf(run, 0), unavailableReason(ability, 'no-model'));
}

// Bug caught: a picture sent to a vision model nobody set, or the turn silent about not having seen it.
test('a picture with vision off is not described and the request carries the ability-unavailable words for pictures', async () => {
  const { run, described } = await mediaTurn({ ...ON_ROLES, vision: null }, PICTURE);
  assert.equal(described.length, 0, 'no model request for the picture');
  assert.equal(toldOnce(run, 'imagesIn'), 1);
  assert.equal(toldOnce(run, 'videoIn'), 0, 'video is on and no video is there');
});

// Bug caught: the same picture, vision on, losing its caption or being announced as unseen.
test('a picture with vision on is described and the request carries no ability-unavailable words', async () => {
  const { run, described } = await mediaTurn(ON_ROLES, PICTURE);
  assert.equal(described.length, 1);
  assert.equal(toldOnce(run, 'imagesIn'), 0);
  assert.equal(toldOnce(run, 'videoIn'), 0);
});

// Bug caught: a GIF read through the vision model while video is off, or the loss told as the picture's.
test('a GIF with video off is not described and the request carries the ability-unavailable words for videos', async () => {
  const { run, described } = await mediaTurn({ ...ON_ROLES, video: null }, GIF);
  assert.equal(described.length, 0, 'no request on any role');
  assert.equal(toldOnce(run, 'videoIn'), 1);
  assert.equal(toldOnce(run, 'imagesIn'), 0, 'pictures are on and none is there');
});

// Bug caught: a video fetched and sent to a video model that is off.
test('a video with video off is not fetched or watched and the request carries the ability-unavailable words for videos', async () => {
  const { run, described, fetched } = await mediaTurn({ ...ON_ROLES, video: null }, CLIP);
  assert.equal(described.length, 0);
  assert.equal(fetched.length, 0);
  assert.equal(toldOnce(run, 'videoIn'), 1);
});

// Bug caught: every role off telling nothing when there is no media, which would add a line to every request.
test('with every media role off and no media in the window, the request carries no ability-unavailable words', async () => {
  const { run } = await mediaTurn({ ...ON_ROLES, vision: null, video: null }, new Map());
  assert.equal(toldOnce(run, 'imagesIn') + toldOnce(run, 'videoIn'), 0);
});
