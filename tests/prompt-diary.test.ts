// Tests for the diary side of src/behavior/prompt.ts: the `{{when}}` line of the drawing
// prompt, the diary channel in `<senses>`, the diary post's own blocks and
// their budget, and the plan request. Fake prompts/config/labels only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDrawPrompt, userText as textOf } from '../src/behavior/prompt.ts';
import { fill } from '../src/format.ts';
import { labels } from './fixtures/labels.ts';
import { buildRequest, type Built } from './fixtures/built-request.ts';
import { framed } from './fixtures/prompt-rig.ts';
import { blocksOf } from '../src/turn/request/frame.ts';
import { JOURNAL, MARK, PAGES, PLAN, blockOf, frameTurn, inOrderOf, partOf, rootTags } from './fixtures/diary-frame.ts';

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
    diary: 'DIARY_TASK for {{name}}',
    'diary-planner': 'PLAN_SYSTEM for {{name}}',
    labels,
    ...overrides,
  };
}

function fakeConfig(overrides: { context?: object; features?: object; llm?: object; diary?: object } = {}) {
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

// The writer on the turn frame (plan 2026-11-06-turn-frame, slice 6, with the owner's answers of 2026-11-07): the turn
// runs with `chat: null`, its request holds the diary list of the frame, and `<publication_places>` is a part of
// `<inner>` that lists the mirrors when there are two or more. tests/fixtures/diary-frame.ts holds the scene.

/** The diary list without `persona`, which is the system message and no root tag of the user text. */
const WRITER_TAGS = blocksOf('diary', null).filter((name) => name !== 'persona');

test('the writer request holds the frame list, with no <chat>, <surroundings>, <about_chat> or root <places>', async () => {
  // Bug: the writer is still built as a reply in the first mirror, with its chat, surroundings and the old place blocks.
  const run = await frameTurn();
  const text = run.writer[0] ?? '';
  const tags = rootTags(text);
  assert.ok(inOrderOf(tags, WRITER_TAGS), tags.join(' '));
  for (const tag of ['self', 'meanwhile', 'spatial_awareness', 'task']) assert.ok(tags.includes(tag), `holds <${tag}>`);
  for (const tag of ['chat', 'surroundings', 'about_chat', 'places'])
    assert.ok(!tags.includes(tag), `no root <${tag}>`);
  assert.ok(blockOf(text, 'task').includes(MARK.writer), 'its own task');
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

// The owner on 2026-11-17: the diary planner and the diary writer read her appearance beside the character card, in the
// system message. The appearance sentence is the test's own.
const LOOKS = 'ΕΜΦΑΝΙΣΗ a tall figure in a mustard raincoat with a crooked umbrella';

test('the planner and the writer read <appearance> in the system message, after the card', async () => {
  // Bug: only the chat turns get the appearance, so her diary describes someone she does not look like.
  const run = await frameTurn({ prompts: { appearance: LOOKS } });
  const block = `<appearance>\n${LOOKS}\n</appearance>`;
  for (const [who, text] of [
    ['planner', run.planner[0] ?? ''],
    ['writer', run.writer[0] ?? ''],
  ] as const) {
    const at = text.indexOf(block);
    assert.ok(at > text.indexOf('CARD_TEXT'), `${who}: ${text.slice(0, 300)}`);
    assert.ok(at < text.indexOf('<self>'), `${who}: in the system message, before the user message`);
  }
});
