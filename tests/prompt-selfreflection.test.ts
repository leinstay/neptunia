// Tests for the diary side of src/behavior/prompt.ts: the `<world>` block only
// in a diary request under `diary.world`, the `{{when}}` line of the drawing
// prompt, the diary channel in `<senses>`, the diary post's own blocks and
// their budget, and the plan request. Fake prompts/config/labels only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSelfreflectionPlanRequest,
  buildDrawPrompt,
  userText as textOf,
  worldText,
} from '../src/behavior/prompt.ts';
import { fill } from '../src/format.ts';
import { labels } from './fixtures/labels.ts';
import { buildRequest, type Built } from './fixtures/built-request.ts';

const NOW = Date.UTC(2026, 8, 20, 10, 0, 0);
const MIN = 60_000;
const DAY = 24 * 60 * MIN;

function identityCalibrator() {
  return { ratio: 1, apply: (n: number) => n };
}

function fakePrompts(overrides: Record<string, unknown> = {}) {
  return {
    'system-prompt': 'SYSTEM_TEXT for {{name}}',
    'character-card': 'CARD_TEXT',
    rules: 'RULES_TEXT',
    format: 'FORMAT_TEXT',
    reply: 'REPLY_TASK',
    interject: 'INTERJECT_TASK',
    selfreflection: 'DIARY_TASK for {{name}}',
    'selfreflection-planner': 'PLAN_SYSTEM for {{name}}',
    world: 'A world of {{name}}.',
    labels,
    ...overrides,
  };
}

function fakeConfig(overrides: { context?: object; features?: object; llm?: object; selfreflection?: object } = {}) {
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
    lore: { scanMessages: 30, maxMatches: 8 },
    memory: { recentHours: 72 },
    selfreflection: { historyPosts: 150, ...overrides.selfreflection },
  };
}

function makeMessage(id: number | string, ts: number, overrides = {}) {
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

function baseInput(overrides = {}) {
  return {
    config: fakeConfig(),
    prompts: fakePrompts(),
    calibrator: identityCalibrator(),
    mode: 'reply',
    now: NOW,
    selfName: 'Nept',
    history: [makeMessage(1, NOW - MIN)],
    neighbors: [],
    trigger: null,
    triggerKind: null,
    placeMemory: {},
    interlocutor: null,
    otherProfiles: [],
    ...overrides,
  };
}

// The whole user text, every cache part: the stable part always carries the static senses lines.
const userText = (request: Built) => textOf(request.messages[1].content);

const post = (at: number, kind: string | null, gist: string, picture: string | null = null) => ({
  at,
  kind,
  gist,
  picture,
  messageIds: [],
  search: null,
});

test('buildRequest: the world block appears in diary mode with diary.world on only', () => {
  const on = fakeConfig({ selfreflection: { world: true } });
  const selfreflectionOn = userText(
    buildRequest(
      baseInput({ mode: 'selfreflection', config: on, selfreflection: { posts: [], plan: null, found: null } })
    )
  );
  assert.ok(selfreflectionOn.includes('<world>\nA world of Nept.\n</world>'), selfreflectionOn);

  const reply = userText(buildRequest(baseInput({ mode: 'reply', config: on })));
  assert.ok(!reply.includes('<world>'), 'never in an ordinary turn');

  const off = userText(
    buildRequest(
      baseInput({
        mode: 'selfreflection',
        config: fakeConfig({ selfreflection: { world: false } }),
        selfreflection: {},
      })
    )
  );
  assert.ok(!off.includes('<world>'), 'selfreflection.world false');

  const missing: { selfreflection: { historyPosts: number; world?: unknown } } = fakeConfig();
  delete missing.selfreflection.world;
  const unset = userText(buildRequest(baseInput({ mode: 'selfreflection', config: missing, selfreflection: {} })));
  assert.ok(!unset.includes('<world>'), 'a missing selfreflection.world counts as off');

  const truthy = userText(
    buildRequest(
      baseInput({
        mode: 'selfreflection',
        config: fakeConfig({ selfreflection: { world: 'yes' } }),
        selfreflection: {},
      })
    )
  );
  assert.ok(!truthy.includes('<world>'), 'read as === true');
});

test('buildRequest: no world block without the file', () => {
  const config = fakeConfig({ selfreflection: { world: true } });
  for (const world of [undefined, '', '   \n']) {
    const text = userText(
      buildRequest(baseInput({ mode: 'selfreflection', config, prompts: fakePrompts({ world }), selfreflection: {} }))
    );
    assert.ok(!text.includes('<world>'), JSON.stringify(world));
  }
  assert.equal(
    worldText(config, fakePrompts({ world: undefined }) as unknown as Parameters<typeof worldText>[1], 'Nept'),
    ''
  );
});

test('buildDrawPrompt: fills {{when}} when given and leaves no hole when empty', () => {
  const prompts = fakePrompts({ draw: 'Draw for {{name}}.\n\n{{when}}\n\n{{request}}' });
  const timed = buildDrawPrompt({
    prompts,
    selfName: 'Nept',
    request: 'a quay at dusk',
    self: false,
    when: 'Tue 10 Mar, 21:40',
  });
  assert.equal(timed, `Draw for Nept.\n\n${fill(labels.draw.when, { when: 'Tue 10 Mar, 21:40' })}\n\na quay at dusk`);

  const untimed = buildDrawPrompt({ prompts, selfName: 'Nept', request: 'a quay at dusk', self: false });
  assert.equal(untimed, 'Draw for Nept.\n\na quay at dusk');
  assert.ok(!untimed.includes('{{when}}'));
});

test('renderSenses: names the diary channel when set', () => {
  const text = userText(buildRequest(baseInput({ selfreflectionChannel: 'ημερολόγιο' })));
  assert.ok(text.includes(fill(labels.senses.selfreflection, { channel: 'ημερολόγιο' })), text);
});

test('renderSenses: does not name the diary channel when unset', () => {
  for (const selfreflectionChannel of [undefined, null, '']) {
    const text = userText(buildRequest(baseInput({ selfreflectionChannel })));
    assert.ok(
      !text.includes(fill(labels.senses.selfreflection, { channel: '' }).slice(0, 20)),
      String(selfreflectionChannel)
    );
  }
});

test('buildRequest: diary mode renders diary, plan and found blocks before the chat and uses prompts.selfreflection as the task', () => {
  const posts = [
    post(NOW - 2 * DAY, 'status', 'café au lait again'),
    post(NOW - DAY, null, 'un phare la nuit', 'a lighthouse at night'),
  ];
  const plan = { kind: 'selfPicture', brief: 'a rooftop at dawn', picture: true };
  const text = userText(
    buildRequest(
      baseInput({
        mode: 'selfreflection',
        selfreflection: { posts, plan, found: 'Une comète passe ce soir.' },
        config: fakeConfig({ selfreflection: { world: true } }),
      })
    )
  );
  const at = (tag: string) => text.indexOf(`<${tag}>`);
  for (const tag of ['world', 'diary', 'plan', 'found', 'chat', 'task']) assert.ok(at(tag) >= 0, `${tag} present`);
  assert.ok(
    at('world') < at('diary') && at('diary') < at('plan') && at('plan') < at('found') && at('found') < at('chat')
  );
  assert.ok(text.includes(`<diary>\n${labels.selfreflection.intro}\n`));
  assert.ok(
    text.includes(fill(labels.selfreflection.line, { date: '2026-09-18', kind: 'status', gist: 'café au lait again' }))
  );
  assert.ok(
    text.includes(
      fill(labels.selfreflection.line, {
        date: '2026-09-19',
        kind: labels.selfreflection.kindUnknown,
        gist: 'un phare la nuit',
      })
    )
  );
  assert.ok(text.includes(`<plan>\n${labels.selfreflection.plan}\n${JSON.stringify(plan)}\n</plan>`));
  assert.ok(text.includes(`<found>\n${labels.selfreflection.found}\nUne comète passe ce soir.\n</found>`));
  assert.ok(text.includes('<task>\nDIARY_TASK for Nept\n</task>'));
});

test('buildRequest: a diary post with seeds renders them right after the plan, never cut; none without', () => {
  const plan = { kind: 'tour', brief: 'a harbour walk', picture: true };
  const seeds = `${labels.selfreflection.seeds}
- a pier; fog
- a market; rain`;
  const posts = Array.from({ length: 40 }, (_, i) =>
    post(NOW - (40 - i) * DAY, 'thought', `σκέψη ${i} ${'λόγος '.repeat(30)}`)
  );
  const full = buildRequest(baseInput({ mode: 'selfreflection', selfreflection: { posts, plan, found: null, seeds } }));
  const text = userText(full);
  assert.ok(
    text.includes(`<plan>
${labels.selfreflection.plan}
${JSON.stringify(plan)}
</plan>

<seeds>
${seeds}
</seeds>`)
  );
  const base = full.stats.used - full.stats.selfreflection.used;
  const tight = buildRequest(
    baseInput({
      mode: 'selfreflection',
      selfreflection: { posts, plan, found: null, seeds },
      config: fakeConfig({ llm: { maxRequestTokens: Math.ceil((base + 60) / 0.9) } }),
    })
  );
  assert.ok(tight.stats.selfreflection.dropped > 0, 'the history is cut');
  assert.ok(
    userText(tight).includes(`<seeds>
${seeds}
</seeds>`),
    'the seeds are not'
  );
  assert.ok(
    !userText(
      buildRequest(baseInput({ mode: 'selfreflection', selfreflection: { posts, plan, found: null } }))
    ).includes('<seeds>')
  );
  assert.ok(
    !userText(buildRequest(baseInput({ mode: 'reply', selfreflection: { posts, plan, found: null, seeds } }))).includes(
      '<seeds>'
    )
  );
});

test('buildRequest: no diary blocks outside diary mode, none without posts or a find', () => {
  const selfreflection = {
    posts: [post(NOW - DAY, 'status', 'bonjour')],
    plan: { kind: 'status', brief: 'x', picture: false },
    found: 'y',
  };
  const reply = userText(buildRequest(baseInput({ mode: 'reply', selfreflection })));
  for (const tag of ['selfreflection', 'plan', 'found']) assert.ok(!reply.includes(`<${tag}>`), tag);

  const bare = userText(
    buildRequest(
      baseInput({
        mode: 'selfreflection',
        selfreflection: { posts: [], plan: { kind: 'status', brief: 'x', picture: false }, found: null },
      })
    )
  );
  assert.ok(!bare.includes('<diary>') && !bare.includes('<found>'));
  assert.ok(bare.includes('<plan>'));
});

test('buildRequest: diary block loses its oldest lines first under budget', () => {
  const posts = Array.from({ length: 60 }, (_, i) =>
    post(NOW - (60 - i) * DAY, 'thought', `pensée numéro ${i} ${'λόγος '.repeat(30)}`)
  );
  const full = buildRequest(baseInput({ mode: 'selfreflection', selfreflection: { posts, plan: null, found: null } }));
  const base = full.stats.used - full.stats.selfreflection.used;
  // Room for about a third of the history.
  const limitTokens = Math.ceil((base + full.stats.selfreflection.used / 3 + 60) / 0.9);
  const tight = buildRequest(
    baseInput({
      mode: 'selfreflection',
      selfreflection: { posts, plan: null, found: null },
      config: fakeConfig({ llm: { maxRequestTokens: limitTokens } }),
    })
  );
  const text = userText(tight);
  assert.ok(
    tight.stats.selfreflection.dropped > 0 && tight.stats.selfreflection.kept > 0,
    JSON.stringify(tight.stats.selfreflection)
  );
  assert.ok(text.includes('pensée numéro 59 '), 'the newest post stays');
  assert.ok(!text.includes('pensée numéro 0 '), 'the oldest post goes first');
  assert.ok(text.includes(`<diary>\n${labels.selfreflection.intro}\n`), 'the intro stays with the kept lines');
});

test('buildSelfreflectionPlanRequest: the plan prompt as system, the blocks in order, kinds and seeds whole', () => {
  const config = fakeConfig({ selfreflection: { world: true } });
  const channels = [
    { id: 'd1', name: 'journal', purpose: 'the persona posts here', topics: '', tone: '', days: {}, topWriters: [] },
  ];
  const request = buildSelfreflectionPlanRequest({
    config,
    prompts: fakePrompts(),
    calibrator: identityCalibrator(),
    now: NOW,
    selfName: 'Nept',
    history: [],
    placeMemory: { patterns: 'short lines, lots of jokes' },
    channels,
    loreEntries: [],
    currentChannelId: 'd1',
    recentLines: [],
    recentAudience: null,
    candidateProfiles: [],
    nameOf: null,
    posts: [post(NOW - DAY, 'status', 'ennui')],
    kinds: { status: 3, picture: 0, thought: 2 },
    seedsText: `${labels.selfreflection.seeds}\n- a pier; fog`,
  });
  assert.equal(request.messages[0].content, 'PLAN_SYSTEM for Nept');
  const text = request.messages[1].content;
  const order = ['now', 'places', 'about_chat', 'world', 'diary', 'kinds', 'seeds'];
  const positions = order.map((tag) => text.indexOf(`<${tag}>`));
  for (const [i, tag] of order.entries()) assert.ok(positions[i] >= 0, `${tag} present`);
  assert.deepEqual(
    [...positions].sort((a, b) => a - b),
    positions,
    'in the planned order'
  );
  assert.ok(text.includes(fill(labels.selfreflection.kindLine, { key: 'status', weight: 3, count: 1, window: 1 })));
  assert.ok(
    !text.includes(fill(labels.selfreflection.kindLine, { key: 'picture', weight: 0, count: 0, window: 1 })),
    'a weight 0 kind is not offered'
  );
  assert.ok(text.includes('<seeds>\n' + labels.selfreflection.seeds + '\n- a pier; fog\n</seeds>'));
  assert.ok(!text.includes('<chat>') && !text.includes('<task>'));
});

test('buildSelfreflectionPlanRequest: no world block with diary.world off, no seeds block without seeds', () => {
  const request = buildSelfreflectionPlanRequest({
    config: fakeConfig(),
    prompts: fakePrompts(),
    calibrator: identityCalibrator(),
    now: NOW,
    selfName: 'Nept',
    posts: [],
    kinds: { status: 1 },
    seedsText: '',
  });
  const text = request.messages[1].content;
  assert.ok(!text.includes('<world>') && !text.includes('<seeds>') && !text.includes('<diary>'));
  assert.ok(text.includes('<kinds>'));
});

/** The user text of a plan request over `posts`, with `selfreflection.sceneChars` at 30. */
function planText(posts: Array<object>): string {
  const request = buildSelfreflectionPlanRequest({
    config: fakeConfig({ selfreflection: { sceneChars: 30 } }),
    prompts: fakePrompts(),
    calibrator: identityCalibrator(),
    now: NOW,
    selfName: 'Nept',
    posts,
    kinds: { picture: 1 },
    seedsText: '',
  });
  // The lead: the message named first, for the chain rule.
  const user = request.messages[1];
  return user.content;
}

const DRAWN = 'a cafe interior, warm light';
const scene = (text: string) => fill(labels.selfreflection.picture, { scene: text });

test('buildSelfreflectionPlanRequest: a planned picture post shows its brief as the scene in <diary>', () => {
  // Bug: the diary shows the drawing prompt, which names the room and stops before the activity.
  const planned = {
    ...post(NOW - DAY, 'picture', 'μια μέρα στη λίμνη', DRAWN),
    pictureDescription: 'a girl at a window table',
    plan: { brief: 'she learns to skate on a frozen lake', seeds: [['a lake', 'skating']], seed: 1 },
  };
  const text = planText([planned]);
  assert.ok(text.includes(scene('she learns to skate on a frozen lake')), text);
  assert.equal(text.includes(DRAWN), false);
});

test('buildSelfreflectionPlanRequest: a picture post with no plan shows its picture description cut to sceneChars', () => {
  // Bug: an old row shows its drawing prompt although its picture was described, or the description is not cut.
  const described = {
    ...post(NOW - DAY, 'picture', 'une longue descente', DRAWN),
    pictureDescription: 'a girl rides a red bicycle\ndown a wet hill road at dawn',
  };
  const text = planText([described]);
  assert.ok(text.includes(scene('a girl rides a red bicycle')), text);
  assert.equal(text.includes('hill road'), false);
  assert.equal(text.includes(DRAWN), false);
});

test('buildSelfreflectionPlanRequest: a picture post with neither shows its drawing prompt', () => {
  // Bug: the fallback drops the scene of a row that has only its drawing prompt.
  const text = planText([post(NOW - DAY, 'picture', 'καφές', DRAWN)]);
  assert.ok(text.includes(scene(DRAWN)), text);
});

test('buildRequest: the server block marks the diary channel', () => {
  const channel = (id: string, name: string) => ({
    id,
    name,
    purpose: '',
    topics: '',
    tone: '',
    days: {},
    topWriters: [],
  });
  const channels = [channel('c-talk', 'agora'), channel('c-diary', 'journal-κ')];
  const input = { channels, currentChannelId: 'c-talk', neighbors: [{ placeId: 'c-diary', messages: [] }] };
  const mark = fill(labels.server.selfreflection, { channel: 'journal-κ' });

  // Stage 3 design, section 5: the places of her diary are its mirrors, which the turn reads from memory and hands the
  // builder as `selfreflectionChannelIds`; `diary.placeId` is only a seed.
  const on = userText(buildRequest(baseInput({ ...input, selfreflectionChannelIds: ['c-diary'] })));
  const entries = on.slice(on.indexOf('<server>'), on.indexOf('</server>')).split('\n\n');
  const selfreflectionEntry = entries.find((entry) => entry.includes('# journal-κ'));
  const talkEntry = entries.find((entry) => entry.includes('# agora'));
  assert.ok(selfreflectionEntry && selfreflectionEntry.includes(mark), on);
  assert.ok(talkEntry && !talkEntry.includes(mark), 'another channel does not carry the mark');

  const off = userText(buildRequest(baseInput({ ...input })));
  assert.ok(off.includes('# journal-κ') && !off.includes(mark), 'no mark without a mirror on it');
});
