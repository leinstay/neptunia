// Tests for the diary side of src/behavior/prompt.ts: the `{{when}}` line of the drawing
// prompt, the diary channel in `<senses>`, the diary post's own blocks and
// their budget, and the request of a diary entry. Fake prompts/config/labels only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDrawPrompt, userText as textOf } from '../src/behavior/prompt.ts';
import { fill } from '../src/format.ts';
import { labels } from './fixtures/labels.ts';
import { buildRequest, type Built } from './fixtures/built-request.ts';
import { framed } from './fixtures/prompt-rig.ts';
import { blocksOf } from '../src/turn/request/frame.ts';
import {
  EMOJI_NAME,
  JOURNAL,
  MARK,
  PAGES,
  SCENE,
  blockOf,
  frameTurn,
  inOrderOf,
  partOf,
  rootTags,
} from './fixtures/diary-frame.ts';
import { shippedLabels } from './fixtures/shipped-labels.ts';

const NOW = Date.UTC(2026, 8, 20, 10, 0, 0);
const MIN = 60_000;
const DAY = 24 * 60 * MIN;

function identityCalibrator() {
  return { ratio: 1, apply: (n: number) => n };
}

function fakePrompts(overrides: Record<string, unknown> = {}) {
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

test('buildRequest: no diary blocks outside diary mode, and no <diary> or <scene> without entries or scenes', () => {
  const diary = { posts: [post(NOW - DAY, 'status', 'bonjour')], kind: 'story', scenes: ['A PIER'] };
  const reply = userText(buildRequest(baseInput({ mode: 'reply', diary })));
  for (const tag of ['diary', 'kind', 'scene']) assert.ok(!reply.includes(`<${tag}>`), tag);

  const bare = userText(buildRequest(baseInput({ mode: 'diary', diary: { posts: [], kind: 'status', scenes: [] } })));
  assert.ok(!bare.includes('<diary>') && !bare.includes('<scene>'));
  assert.ok(bare.includes('<kind>\nstatus\n</kind>'), bare);
});

/** The `<task>` of a diary request of `kind` over the prompts `overrides` laid on the fake ones. */
function diaryTask(kind: string, overrides: Record<string, unknown> = {}): string {
  const text = userText(
    buildRequest(baseInput({ mode: 'diary', prompts: fakePrompts(overrides), diary: { posts: [], kind, scenes: [] } }))
  );
  return /<task>\n([\s\S]*?)\n<\/task>/.exec(text)?.[1] ?? '';
}

const KIND_FILES = { 'diary/kinds/story': 'STORY_PART', 'diary/kinds/randomSet': 'RANDOM_SET_PART' };

test('the task of a diary entry is the common text and then the file of its kind', () => {
  // Bug: the persona reads every kind's instructions, or another kind's, or none.
  assert.equal(diaryTask('story', KIND_FILES), 'DIARY_TASK for Nept\n\nSTORY_PART');
  assert.equal(diaryTask('randomSet', KIND_FILES), 'DIARY_TASK for Nept\n\nRANDOM_SET_PART');
});

test("a deployment's own diary text replaces the common text and keeps the kind's file", () => {
  assert.equal(diaryTask('story', { ...KIND_FILES, 'diary/task': 'OWN_TASK' }), 'OWN_TASK\n\nSTORY_PART');
});

test("a deployment's own kind file replaces only that kind's part", () => {
  const own = { ...KIND_FILES, 'diary/kinds/story': 'OWN_STORY' };
  assert.equal(diaryTask('story', own), 'DIARY_TASK for Nept\n\nOWN_STORY');
  assert.equal(diaryTask('randomSet', own), 'DIARY_TASK for Nept\n\nRANDOM_SET_PART');
});

test('a kind whose file is emptied gets the common text alone', () => {
  assert.equal(diaryTask('story', { ...KIND_FILES, 'diary/kinds/story': '  ' }), 'DIARY_TASK for Nept');
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
  for (const tag of ['self', 'inner', 'spatial_awareness', 'task']) assert.ok(tags.includes(tag), `holds <${tag}>`);
  for (const tag of ['chat', 'surroundings', 'about_chat', 'places', 'meanwhile'])
    assert.ok(!tags.includes(tag), `no root <${tag}>`);
  assert.ok(blockOf(text, 'task').includes(MARK.writer), 'its own task');
});

test('a story asks the director first, and its request holds <kind> and the scene in <inner>, and no <plan> or <seeds>', async () => {
  // Bug: the persona writes a scene kind with no scene, or reads the planner's blocks that no longer exist.
  const run = await frameTurn({ kind: 'story' });
  assert.equal(run.director.length, 1, 'one director request');
  const text = run.writer[0] ?? '';
  const inner = blockOf(text, 'inner');
  assert.equal(partOf(inner, 'kind'), 'story');
  assert.equal(partOf(inner, 'scene'), SCENE);
  for (const tag of ['plan', 'seeds', 'kinds']) assert.ok(!text.includes(`<${tag}>`), tag);
});

test('a status asks no director, and its request holds no <scene>', async () => {
  // Bug: a kind with no scene waits on the director, or reads a scene meant for another kind.
  const run = await frameTurn({ kind: 'status' });
  assert.equal(run.director.length, 0);
  assert.equal(partOf(blockOf(run.writer[0] ?? '', 'inner'), 'kind'), 'status');
  assert.ok(!(run.writer[0] ?? '').includes('<scene>'));
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

// The owner on 2026-11-17: the diary's turn reads her appearance beside the character card, in the
// system message. The appearance sentence is the test's own.
const LOOKS = 'ΕΜΦΑΝΙΣΗ a tall figure in a mustard raincoat with a crooked umbrella';

test('the diary turn reads <appearance> in the system message, after the card', async () => {
  // Bug: only the chat turns get the appearance, so her diary describes someone she does not look like.
  // Changed: the planner's request went with the planner, so the turn's own request is the one checked.
  const run = await frameTurn({ prompts: { appearance: LOOKS } });
  const block = `<appearance>\n${LOOKS}\n</appearance>`;
  const text = run.writer[0] ?? '';
  const at = text.indexOf(block);
  assert.ok(at > text.indexOf('CARD_TEXT'), text.slice(0, 300));
  assert.ok(at < text.indexOf('<self>'), 'in the system message, before the user message');
});

// The owner on 2026-11-17: `world.md` and the virtual world are deleted and get no new home. The label is the test's.
test('the diary turn does not tell her she is in a virtual world of her own', async () => {
  // Bug: `<spatial_awareness>` of the diary's request says she is in her own virtual world, a removed concept.
  const labels = { ...shippedLabels, spatial: { ...shippedLabels.spatial, world: 'MARK-OWN-WORLD {when}' } };
  const run = await frameTurn({ prompts: { labels } });
  assert.ok(run.writer.length > 0, 'the request ran');
  for (const text of run.writer) assert.ok(!text.includes('MARK-OWN-WORLD'), text.slice(-600));
});

// The owner on 2026-11-17: a custom emoji stands in every text under its stable name, and its description stands once
// in the block `<media>` of the request that names it.
test('a past entry that names a custom emoji gives the diary turn <media> with its line', async () => {
  // Bug: the legend covers `<chat>` and `<meanwhile>` alone, so an entry in `<diary>` keeps a bare code.
  const run = await frameTurn({ emoji: 'named', entries: 2, entryGist: (index) => `ΣΕΛΙΔΑ-${index} :e1:` });
  const text = run.writer[0] ?? '';
  assert.ok(blockOf(text, 'media').includes(`:e1: ${EMOJI_NAME}`), text.slice(-1500));
});
