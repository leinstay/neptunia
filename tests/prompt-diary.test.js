// Tests for the diary side of src/behavior/prompt.js: the `<world>` block only
// in a diary request under `diary.world`, the `{{when}}` line of the drawing
// prompt, the diary channel in `<senses>`, the diary post's own blocks and
// their budget, and the plan request. Fake prompts/config/labels only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDiaryPlanRequest,
  buildDrawPrompt,
  buildRequest,
  userText as textOf,
  worldText,
} from '../src/behavior/prompt.js';
import { fill } from '../src/format.js';
import { labels } from './fixtures/labels.js';

const NOW = Date.UTC(2026, 8, 20, 10, 0, 0);
const MIN = 60_000;
const DAY = 24 * 60 * MIN;

function identityCalibrator() {
  return { ratio: 1, apply: (n) => n };
}

function fakePrompts(overrides = {}) {
  return {
    'system-prompt': 'SYSTEM_TEXT for {{name}}',
    'character-card': 'CARD_TEXT',
    rules: 'RULES_TEXT',
    format: 'FORMAT_TEXT',
    reply: 'REPLY_TASK',
    interject: 'INTERJECT_TASK',
    diary: 'DIARY_TASK for {{name}}',
    'diary-plan': 'PLAN_SYSTEM for {{name}}',
    world: 'A world of {{name}}.',
    labels,
    ...overrides,
  };
}

function fakeConfig(overrides = {}) {
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
    diary: { historyPosts: 150, ...overrides.diary },
  };
}

function makeMessage(id, ts, overrides = {}) {
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
    guildMemory: {},
    interlocutor: null,
    otherProfiles: [],
    ...overrides,
  };
}

// The whole user text, every cache part: the stable part always carries the static senses lines.
const userText = (request) => textOf(request.messages[1].content);

const post = (at, kind, gist, picture = null) => ({ at, kind, gist, picture, messageIds: [], search: null });

test('buildRequest: the world block appears in diary mode with diary.world on only', () => {
  const on = fakeConfig({ diary: { world: true } });
  const diaryOn = userText(
    buildRequest(baseInput({ mode: 'diary', config: on, diary: { posts: [], plan: null, found: null } }))
  );
  assert.ok(diaryOn.includes('<world>\nA world of Nept.\n</world>'), diaryOn);

  const reply = userText(buildRequest(baseInput({ mode: 'reply', config: on })));
  assert.ok(!reply.includes('<world>'), 'never in an ordinary turn');

  const off = userText(
    buildRequest(baseInput({ mode: 'diary', config: fakeConfig({ diary: { world: false } }), diary: {} }))
  );
  assert.ok(!off.includes('<world>'), 'diary.world false');

  const missing = fakeConfig();
  delete missing.diary.world;
  const unset = userText(buildRequest(baseInput({ mode: 'diary', config: missing, diary: {} })));
  assert.ok(!unset.includes('<world>'), 'a missing diary.world counts as off');

  const truthy = userText(
    buildRequest(baseInput({ mode: 'diary', config: fakeConfig({ diary: { world: 'yes' } }), diary: {} }))
  );
  assert.ok(!truthy.includes('<world>'), 'read as === true');
});

test('buildRequest: no world block without the file', () => {
  const config = fakeConfig({ diary: { world: true } });
  for (const world of [undefined, '', '   \n']) {
    const text = userText(
      buildRequest(baseInput({ mode: 'diary', config, prompts: fakePrompts({ world }), diary: {} }))
    );
    assert.ok(!text.includes('<world>'), JSON.stringify(world));
  }
  assert.equal(worldText(config, fakePrompts({ world: undefined }), 'Nept'), '');
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
  const text = userText(buildRequest(baseInput({ diaryChannel: 'ημερολόγιο' })));
  assert.ok(text.includes(fill(labels.senses.diary, { channel: 'ημερολόγιο' })), text);
});

test('renderSenses: does not name the diary channel when unset', () => {
  for (const diaryChannel of [undefined, null, '']) {
    const text = userText(buildRequest(baseInput({ diaryChannel })));
    assert.ok(!text.includes(fill(labels.senses.diary, { channel: '' }).slice(0, 20)), String(diaryChannel));
  }
});

test('buildRequest: diary mode renders diary, plan and found blocks before the chat and uses prompts.diary as the task', () => {
  const posts = [
    post(NOW - 2 * DAY, 'status', 'café au lait again'),
    post(NOW - DAY, null, 'un phare la nuit', 'a lighthouse at night'),
  ];
  const plan = { kind: 'selfPicture', brief: 'a rooftop at dawn', picture: true };
  const text = userText(
    buildRequest(
      baseInput({
        mode: 'diary',
        diary: { posts, plan, found: 'Une comète passe ce soir.' },
        config: fakeConfig({ diary: { world: true } }),
      })
    )
  );
  const at = (tag) => text.indexOf(`<${tag}>`);
  for (const tag of ['world', 'diary', 'plan', 'found', 'chat', 'task']) assert.ok(at(tag) >= 0, `${tag} present`);
  assert.ok(
    at('world') < at('diary') && at('diary') < at('plan') && at('plan') < at('found') && at('found') < at('chat')
  );
  assert.ok(text.includes(`<diary>\n${labels.diary.intro}\n`));
  assert.ok(text.includes(fill(labels.diary.line, { date: '2026-09-18', kind: 'status', gist: 'café au lait again' })));
  assert.ok(
    text.includes(
      fill(labels.diary.line, { date: '2026-09-19', kind: labels.diary.kindUnknown, gist: 'un phare la nuit' })
    )
  );
  assert.ok(text.includes(`<plan>\n${labels.diary.plan}\n${JSON.stringify(plan)}\n</plan>`));
  assert.ok(text.includes(`<found>\n${labels.diary.found}\nUne comète passe ce soir.\n</found>`));
  assert.ok(text.includes('<task>\nDIARY_TASK for Nept\n</task>'));
});

test('buildRequest: a diary post with seeds renders them right after the plan, never cut; none without', () => {
  const plan = { kind: 'tour', brief: 'a harbour walk', picture: true };
  const seeds = `${labels.diary.seeds}
- a pier; fog
- a market; rain`;
  const posts = Array.from({ length: 40 }, (_, i) =>
    post(NOW - (40 - i) * DAY, 'thought', `σκέψη ${i} ${'λόγος '.repeat(30)}`)
  );
  const full = buildRequest(baseInput({ mode: 'diary', diary: { posts, plan, found: null, seeds } }));
  const text = userText(full);
  assert.ok(
    text.includes(`<plan>
${labels.diary.plan}
${JSON.stringify(plan)}
</plan>

<seeds>
${seeds}
</seeds>`)
  );
  const base = full.stats.used - full.stats.diary.used;
  const tight = buildRequest(
    baseInput({
      mode: 'diary',
      diary: { posts, plan, found: null, seeds },
      config: fakeConfig({ llm: { maxRequestTokens: Math.ceil((base + 60) / 0.9) } }),
    })
  );
  assert.ok(tight.stats.diary.dropped > 0, 'the history is cut');
  assert.ok(
    userText(tight).includes(`<seeds>
${seeds}
</seeds>`),
    'the seeds are not'
  );
  assert.ok(
    !userText(buildRequest(baseInput({ mode: 'diary', diary: { posts, plan, found: null } }))).includes('<seeds>')
  );
  assert.ok(
    !userText(buildRequest(baseInput({ mode: 'reply', diary: { posts, plan, found: null, seeds } }))).includes(
      '<seeds>'
    )
  );
});

test('buildRequest: no diary blocks outside diary mode, none without posts or a find', () => {
  const diary = {
    posts: [post(NOW - DAY, 'status', 'bonjour')],
    plan: { kind: 'status', brief: 'x', picture: false },
    found: 'y',
  };
  const reply = userText(buildRequest(baseInput({ mode: 'reply', diary })));
  for (const tag of ['diary', 'plan', 'found']) assert.ok(!reply.includes(`<${tag}>`), tag);

  const bare = userText(
    buildRequest(
      baseInput({
        mode: 'diary',
        diary: { posts: [], plan: { kind: 'status', brief: 'x', picture: false }, found: null },
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
  const full = buildRequest(baseInput({ mode: 'diary', diary: { posts, plan: null, found: null } }));
  const base = full.stats.used - full.stats.diary.used;
  // Room for about a third of the history.
  const limitTokens = Math.ceil((base + full.stats.diary.used / 3 + 60) / 0.9);
  const tight = buildRequest(
    baseInput({
      mode: 'diary',
      diary: { posts, plan: null, found: null },
      config: fakeConfig({ llm: { maxRequestTokens: limitTokens } }),
    })
  );
  const text = userText(tight);
  assert.ok(tight.stats.diary.dropped > 0 && tight.stats.diary.kept > 0, JSON.stringify(tight.stats.diary));
  assert.ok(text.includes('pensée numéro 59 '), 'the newest post stays');
  assert.ok(!text.includes('pensée numéro 0 '), 'the oldest post goes first');
  assert.ok(text.includes(`<diary>\n${labels.diary.intro}\n`), 'the intro stays with the kept lines');
});

test('buildDiaryPlanRequest: the plan prompt as system, the blocks in order, kinds and seeds whole', () => {
  const config = fakeConfig({ diary: { world: true } });
  const channels = [
    { id: 'd1', name: 'journal', purpose: 'the persona posts here', topics: '', tone: '', days: {}, topWriters: [] },
  ];
  const request = buildDiaryPlanRequest({
    config,
    prompts: fakePrompts(),
    calibrator: identityCalibrator(),
    now: NOW,
    selfName: 'Nept',
    history: [],
    guildMemory: { patterns: 'short lines, lots of jokes' },
    channels,
    loreEntries: [],
    currentChannelId: 'd1',
    recentLines: [],
    recentAudience: null,
    candidateProfiles: [],
    nameOf: null,
    posts: [post(NOW - DAY, 'status', 'ennui')],
    kinds: { status: 3, picture: 0, thought: 2 },
    seedsText: `${labels.diary.seeds}\n- a pier; fog`,
  });
  assert.equal(request.messages[0].content, 'PLAN_SYSTEM for Nept');
  const text = request.messages[1].content;
  const order = ['now', 'server', 'about_chat', 'world', 'diary', 'kinds', 'seeds'];
  const positions = order.map((tag) => text.indexOf(`<${tag}>`));
  for (const [i, tag] of order.entries()) assert.ok(positions[i] >= 0, `${tag} present`);
  assert.deepEqual(
    [...positions].sort((a, b) => a - b),
    positions,
    'in the planned order'
  );
  assert.ok(text.includes(fill(labels.diary.kindLine, { key: 'status', weight: 3, count: 1, window: 1 })));
  assert.ok(
    !text.includes(fill(labels.diary.kindLine, { key: 'picture', weight: 0, count: 0, window: 1 })),
    'a weight 0 kind is not offered'
  );
  assert.ok(text.includes('<seeds>\n' + labels.diary.seeds + '\n- a pier; fog\n</seeds>'));
  assert.ok(!text.includes('<chat>') && !text.includes('<task>'));
});

test('buildDiaryPlanRequest: no world block with diary.world off, no seeds block without seeds', () => {
  const request = buildDiaryPlanRequest({
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

test('buildRequest: the server block marks the diary channel', () => {
  const channel = (id, name) => ({ id, name, purpose: '', topics: '', tone: '', days: {}, topWriters: [] });
  const channels = [channel('c-talk', 'agora'), channel('c-diary', 'journal-κ')];
  const input = { channels, currentChannelId: 'c-talk', neighbors: [{ channelId: 'c-diary', messages: [] }] };
  const mark = fill(labels.server.diary, { channel: 'journal-κ' });

  const on = userText(buildRequest(baseInput({ ...input, config: fakeConfig({ diary: { channelId: 'c-diary' } }) })));
  const entries = on.slice(on.indexOf('<server>'), on.indexOf('</server>')).split('\n\n');
  const diaryEntry = entries.find((entry) => entry.includes('# journal-κ'));
  const talkEntry = entries.find((entry) => entry.includes('# agora'));
  assert.ok(diaryEntry && diaryEntry.includes(mark), on);
  assert.ok(talkEntry && !talkEntry.includes(mark), 'another channel does not carry the mark');

  const off = userText(buildRequest(baseInput({ ...input })));
  assert.ok(off.includes('# journal-κ') && !off.includes(mark), 'no mark without diary.channelId');
});
