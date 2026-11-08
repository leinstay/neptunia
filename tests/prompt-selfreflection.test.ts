// Tests for the diary side of src/behavior/prompt.ts: the `<world>` block only
// in a diary request, whenever world.md has text, the `{{when}}` line of the drawing
// prompt, the diary channel in `<senses>`, the diary post's own blocks and
// their budget, and the plan request. Fake prompts/config/labels only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDrawPrompt, userText as textOf, worldText } from '../src/behavior/prompt.ts';
import { fill } from '../src/format.ts';
import { labels } from './fixtures/labels.ts';
import { buildRequest, type Built } from './fixtures/built-request.ts';
import { framed } from './fixtures/prompt-rig.ts';
import { blocksOf } from '../src/turn/request/frame.ts';
import {
  JOURNAL,
  MARK,
  PAGES,
  PLAN,
  TEXT,
  blockOf,
  frameTurn,
  inOrderOf,
  partOf,
  rootTags,
} from './fixtures/selfreflection-frame.ts';

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
  const input = {
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
  // Every request is built on its turn frame (slice 7).
  return framed(input);
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

// The writer on the turn frame (plan 2026-11-06-turn-frame, slice 6, with the owner's answers of 2026-11-07): the turn
// runs with `conversation: null`, its request holds the selfreflection list of the frame, `<virtual_world>` is the
// `world.md` text whenever the file is non-empty (`selfreflection.world` is gone), and `<publication_places>` is a part of
// `<inner>` that lists the mirrors when there are two or more. tests/fixtures/selfreflection-frame.ts holds the scene.

/** The selfreflection list without `persona`, which is the system message and no root tag of the user text. */
const WRITER_TAGS = blocksOf('selfreflection', null).filter((name) => name !== 'persona');

test('the writer request holds the frame list, with no <chat>, <surroundings>, <about_chat> or root <places>', async () => {
  // Bug: the writer is still built as a reply in the first mirror, with its chat, surroundings and the old place blocks.
  const run = await frameTurn();
  const text = run.writer[0] ?? '';
  const tags = rootTags(text);
  assert.ok(inOrderOf(tags, WRITER_TAGS), tags.join(' '));
  for (const tag of ['self', 'meanwhile', 'virtual_world', 'spatial_awareness', 'task'])
    assert.ok(tags.includes(tag), `holds <${tag}>`);
  for (const tag of ['chat', 'surroundings', 'about_chat', 'places'])
    assert.ok(!tags.includes(tag), `no root <${tag}>`);
  assert.ok(blockOf(text, 'task').includes(MARK.writer), 'its own task');
});

test('<virtual_world> holds world.md even where the old selfreflection.world switch says false', async () => {
  // Bug: the deleted switch is still read, so a non-empty world.md never reaches her (the 13:55 post had no world).
  const run = await frameTurn({ selfreflection: { world: false } });
  assert.ok(blockOf(run.writer[0] ?? '', 'virtual_world').includes(TEXT.world));
});

test('<virtual_world> is absent when world.md is empty', async () => {
  // Bug: an empty file still renders an empty block or the frame's own placeholder.
  for (const world of ['', '  \n']) {
    const run = await frameTurn({ world });
    assert.ok(!rootTags(run.writer[0] ?? '').includes('virtual_world'), JSON.stringify(world));
  }
});

test('the writer <plan> sits in <inner> as lines, with no JSON', async () => {
  // Bug: the plan stays one JSON line, while nothing in a request is JSON.
  const run = await frameTurn();
  const plan = partOf(blockOf(run.writer[0] ?? '', 'inner'), 'plan');
  assert.ok(plan.includes(PLAN.brief), plan);
  assert.ok(!plan.includes('{"'), plan);
});

test('<publication_places> is absent with one mirror', async () => {
  // Bug: the list shows with nothing to choose, or lists every group room memory knows.
  const run = await frameTurn({ mirrors: [JOURNAL] });
  assert.ok(!(run.writer[0] ?? '').includes('<publication_places>'));
});

test('<publication_places> in <inner> lists two mirrors, each on its own line with its interface, and no other room', async () => {
  // Bug: the part lists every group place of memory (`c2` here), or drops the interface a mirror is on.
  const run = await frameTurn({ mirrors: [JOURNAL, PAGES] });
  const part = partOf(blockOf(run.writer[0] ?? '', 'inner'), 'publication_places');
  const lines = part.split('\n');
  const journal = lines.findIndex((line) => line.includes('fake:channel:d1') && line.includes('fake'));
  const pages = lines.findIndex((line) => line.includes('tele:channel:k9') && line.includes('tele'));
  assert.ok(journal >= 0 && pages >= 0 && journal !== pages, part);
  assert.ok(!part.includes('fake:channel:c2'), part);
});
