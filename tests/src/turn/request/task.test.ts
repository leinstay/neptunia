// Tests for src/turn/request/task.ts: which prompt file frames the task of a turn's request, how its placeholders are
// filled, and the labels a split message, queued calls and folded messages append. The shipped prompt files are read
// as tracked; no provider.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../../../fixtures/source-tree.ts';
import {
  userText as contentText,
  usesFollowUpTask,
  userText as promptUserText,
} from '../../../../src/behavior/prompt.ts';
import { buildRequest } from '../../../fixtures/built-request.ts';
import { bodyOf, userText } from '../../../fixtures/prompt-text.ts';
import { fill } from '../../../../src/format.ts';
import { labels } from '../../../fixtures/labels.ts';
import type { labels as contractLabels } from '../../../fixtures/labels.ts';
import { MIN, NOW, baseInput, fakeConfig, fakePrompts, makeMessage, framed } from '../../../fixtures/prompt-rig.ts';
import { fileURLToPath } from 'node:url';
import { SnowflakeUtil } from 'discord.js';
import { joinLabels } from '../../../../src/config/labels.ts';
import { deepMerge } from '../../../../src/config.ts';
import { DAY_MS, HOUR_MS, MINUTE_MS, utcDay } from '../../../../src/time.ts';
import { normalizeMessage } from '../../../../interfaces/discord/index.ts';
import { useIface, useSelf } from '../../../fixtures/turn-world.ts';
import { withTextPreviews } from '../../../../src/media/text-preview.ts';
import { createCalibrator } from '../../../../src/llm/tokens.ts';
import { chainsOf } from '../../../fixtures/chains.ts';

useIface('fake');
useSelf('900000000000000001');

const PROMPTS = path.join(ROOT, 'prompts');

const read = (name: string): string => fs.readFileSync(path.join(PROMPTS, `${name}.md`), 'utf8');

// The platform and the server are named by the interface's own text. These files are read in a chat on any
// interface, so they speak of the chat, the chat and the places the persona follows.
const PLATFORM_FREE = ['turn/private', 'turn/follow'];

for (const name of PLATFORM_FREE) {
  test(`${name}.md names no platform and no server`, () => {
    // Bug: a persona on another interface is told they live on a Discord server.
    assert.deepEqual(read(name).match(/\b(?:Discord|servers?)\b/gi) ?? [], []);
  });
}

test('buildRequest: fills {{author}}, {{trigger}}, {{target}} and {{name}} in the task template', () => {
  const trigger = makeMessage(1, NOW - MIN, { authorName: 'Alice' });
  const request = buildRequest(baseInput({ history: [trigger], trigger, triggerKind: 'mention' }));
  const messages = request.messages;
  const user = contentText(messages[1].content);
  assert.ok(user.includes(`Called by Alice, they ${labels.triggers.mention}. Answer #1 as Nept. Target: #1.`));
});

test('buildRequest: target is the #index of the trigger message in the transcript', () => {
  const m1 = makeMessage(1, NOW - 3 * MIN);
  const m2 = makeMessage(2, NOW - 2 * MIN);
  const trigger = makeMessage(3, NOW - MIN, { authorName: 'Bob' });
  const request = buildRequest(baseInput({ history: [m1, m2, trigger], trigger, triggerKind: 'reply' }));
  const messages = request.messages;
  const user = contentText(messages[1].content);
  assert.ok(user.includes('Answer #3 as Nept. Target: #3.'));
});

// A follow-up (a classifier yes) and an untagged reply (a Discord reply to the persona with no
// typed tag, taggedCall false) take prompts['turn/follow'] as their task; every other call keeps turn/reply.md.
const FOLLOW_UP_TASK = 'FOLLOW_UP_TASK: {{author}} {{trigger}} at {{target}}; you are {{name}}.';

test('buildRequest: triggerKind "followUp" takes prompts["turn/follow"] as its task, every placeholder filled, no turn/reply.md text', () => {
  const m1 = makeMessage(1, NOW - 2 * MIN);
  const trigger = makeMessage(2, NOW - MIN, { authorName: 'Élodie' });
  const request = buildRequest(
    baseInput({
      prompts: fakePrompts({ 'turn/follow': FOLLOW_UP_TASK }),
      history: [m1, trigger],
      trigger,
      triggerKind: 'followUp',
    })
  );
  const messages = request.messages;
  const user = contentText(messages[1].content);
  assert.ok(user.includes(`FOLLOW_UP_TASK: Élodie ${labels.triggers.followUp} at #2; you are Nept.`), user);
  assert.ok(!user.includes('Called by'), 'turn/reply.md is not used on a follow-up');
});

test('buildRequest: an untagged reply (taggedCall false) takes prompts["turn/follow"] with the reply label', () => {
  const trigger = makeMessage(1, NOW - MIN, { authorName: 'Élodie' });
  const request = buildRequest(
    baseInput({
      prompts: fakePrompts({ 'turn/follow': FOLLOW_UP_TASK }),
      history: [trigger],
      trigger,
      triggerKind: 'reply',
      taggedCall: false,
    })
  );
  const messages = request.messages;
  const user = contentText(messages[1].content);
  assert.ok(user.includes(`FOLLOW_UP_TASK: Élodie ${labels.triggers.reply} at #1; you are Nept.`), user);
  assert.ok(!user.includes('Called by'));
});

test('buildRequest: a tagged reply, a reply without taggedCall, a mention and a name call keep turn/reply.md', () => {
  const trigger = makeMessage(1, NOW - MIN, { authorName: 'Élodie' });
  const cases = [
    { triggerKind: 'reply', taggedCall: true },
    { triggerKind: 'reply' },
    { triggerKind: 'mention', taggedCall: false },
    { triggerKind: 'private', taggedCall: false },
  ];
  for (const extra of cases) {
    const request = buildRequest(
      baseInput({ prompts: fakePrompts({ 'turn/follow': FOLLOW_UP_TASK }), history: [trigger], trigger, ...extra })
    );
    const messages = request.messages;
    const user = contentText(messages[1].content);
    assert.ok(
      user.includes(
        `Called by Élodie, they ${(labels.triggers as Record<string, string | undefined>)[extra.triggerKind] ?? ''}. Answer #1 as Nept.`
      ),
      JSON.stringify(extra)
    );
    assert.ok(!user.includes('FOLLOW_UP_TASK'), JSON.stringify(extra));
  }
});

test('buildRequest: a follow-up in a private chat keeps turn/reply.md', () => {
  const trigger = makeMessage(1, NOW - MIN, { authorName: 'Élodie' });
  const request = buildRequest(
    baseInput({
      prompts: fakePrompts({ 'turn/follow': FOLLOW_UP_TASK }),
      history: [trigger],
      trigger,
      triggerKind: 'followUp',
      dmChat: { accountId: 'author-1' },
    })
  );
  const messages = request.messages;
  const user = contentText(messages[1].content);
  assert.ok(user.includes('Called by Élodie'));
  assert.ok(!user.includes('FOLLOW_UP_TASK'));
});

test('buildRequest: without prompts["turn/follow"] (missing or blank) a follow-up and an untagged reply use turn/reply.md', () => {
  const trigger = makeMessage(1, NOW - MIN, { authorName: 'Élodie' });
  for (const followUp of [undefined, '', '   ']) {
    for (const extra of [{ triggerKind: 'followUp' }, { triggerKind: 'reply', taggedCall: false }]) {
      const request = buildRequest(
        baseInput({ prompts: fakePrompts({ 'turn/follow': followUp }), history: [trigger], trigger, ...extra })
      );
      const messages = request.messages;
      const user = contentText(messages[1].content);
      assert.ok(
        user.includes(
          `Called by Élodie, they ${(labels.triggers as Record<string, string | undefined>)[extra.triggerKind]}. Answer #1 as Nept.`
        ),
        JSON.stringify({ followUp, ...extra })
      );
    }
  }
});

// Slice 7: the routed turn is deleted, so its case left this test.
test('usesFollowUpTask: a follow-up or an untagged reply in reply mode, never private or another mode', () => {
  assert.equal(usesFollowUpTask({ mode: 'reply', triggerKind: 'followUp' }), true);
  assert.equal(usesFollowUpTask({ mode: 'reply', triggerKind: 'reply', taggedCall: false }), true);
  assert.equal(usesFollowUpTask({ mode: 'reply', triggerKind: 'reply', taggedCall: true }), false);
  assert.equal(usesFollowUpTask({ mode: 'reply', triggerKind: 'reply', taggedCall: null }), false);
  assert.equal(usesFollowUpTask({ mode: 'reply', triggerKind: 'mention', taggedCall: false }), false);
  assert.equal(usesFollowUpTask({ mode: 'reply', triggerKind: 'overheard' }), false);
  assert.equal(usesFollowUpTask({ mode: 'reply', triggerKind: 'followUp', dmChat: true }), false);
  assert.equal(usesFollowUpTask({ mode: 'interject', triggerKind: 'followUp' }), false);
});

// An overheard turn: a line about the persona, said to someone else or to the room.
const OVERHEARD_TASK = 'OVERHEARD_TASK: {{author}} {{trigger}} at {{target}}; you are {{name}}.';

test('buildRequest: triggerKind "overheard" takes prompts["turn/overheard"] as its task, every placeholder filled, no turn/reply.md text', () => {
  const m1 = makeMessage(1, NOW - 2 * MIN);
  const trigger = makeMessage(2, NOW - MIN, { authorName: 'Élodie' });
  const request = buildRequest(
    baseInput({
      prompts: fakePrompts({ 'turn/overheard': OVERHEARD_TASK }),
      history: [m1, trigger],
      trigger,
      triggerKind: 'overheard',
    })
  );
  const messages = request.messages;
  const user = contentText(messages[1].content);
  assert.ok(user.includes(`OVERHEARD_TASK: Élodie ${labels.triggers.overheard} at #2; you are Nept.`));
  assert.ok(!user.includes('Called by'), 'turn/reply.md is not used on an overheard turn');
});

test('buildRequest: triggerKind "overheard" without prompts["turn/overheard"] (missing or blank) uses the mode prompt with the overheard label', () => {
  const trigger = makeMessage(1, NOW - MIN, { authorName: 'Élodie' });
  for (const overheard of [undefined, '', '   ']) {
    const request = buildRequest(
      baseInput({ prompts: fakePrompts({ overheard }), history: [trigger], trigger, triggerKind: 'overheard' })
    );
    const messages = request.messages;
    const user = contentText(messages[1].content);
    assert.ok(
      user.includes(`Called by Élodie, they ${labels.triggers.overheard}. Answer #1 as Nept.`),
      JSON.stringify(overheard)
    );
  }
});

// The turn a finished errand opens with no origin message (asked in an inner turn of the persona's).
const ERRAND_TASK = 'ERRAND_TASK: you are {{name}}, your errand ended.';

test('buildRequest: a task trigger kind without a trigger takes prompts["turn/errand"] as its task; missing, the mode prompt; with a trigger, the reply task', () => {
  const m1 = makeMessage(1, NOW - 2 * MIN);
  const own = (overrides: Record<string, unknown> = {}) =>
    contentText(
      buildRequest(baseInput({ mode: 'interject', history: [m1], trigger: null, triggerKind: 'errand', ...overrides }))
        .messages[1].content
    );
  const withFile = own({ prompts: fakePrompts({ 'turn/errand': ERRAND_TASK }) });
  assert.ok(withFile.includes('ERRAND_TASK: you are Nept, your errand ended.'), withFile.slice(-300));
  assert.ok(!withFile.includes('INTERJECT'), "interject.md is not the task of the persona's own errand's end");
  for (const missing of [undefined, '', '  ']) {
    const user = own({ prompts: fakePrompts({ 'turn/errand': missing }) });
    assert.ok(user.includes('INTERJECT'), `without the file the mode prompt applies (${JSON.stringify(missing)})`);
  }
  const trigger = makeMessage(2, NOW - MIN, { authorName: 'Élodie' });
  const answered = contentText(
    buildRequest(
      baseInput({
        prompts: fakePrompts({ 'turn/errand': ERRAND_TASK }),
        history: [m1, trigger],
        trigger,
        triggerKind: 'errand',
      })
    ).messages[1].content
  );
  assert.ok(!answered.includes('ERRAND_TASK'), 'with the origin message the reply task text frames the result');
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

test('buildRequest: dmChat appends the filled prompts["turn/private"] after the mode prompt', () => {
  const user = contentText(buildRequest(privateScene()).messages[1].content);
  const task = user.slice(user.indexOf('<task>'));
  assert.ok(
    task.includes(`Called by Alice, they ${labels.triggers.private}.`),
    '{{trigger}} comes from labels.triggers.private'
  );
  assert.ok(task.includes('PRIVATE_TASK for Nept with Alice'));
  assert.ok(task.indexOf('Called by Alice') < task.indexOf('PRIVATE_TASK'));
});

test('buildRequest: without dmChat prompts["turn/private"] is never appended', () => {
  const user = contentText(buildRequest(privateScene({ dmChat: null })).messages[1].content);
  assert.ok(!user.includes('PRIVATE_TASK'));
});

test('buildRequest: dmChat with no prompts["turn/private"] leaves the task as the mode prompt alone', () => {
  const prompts = fakePrompts();
  const user = contentText(buildRequest(privateScene({ prompts })).messages[1].content);
  const task = /<task>\n([\s\S]*?)\n<\/task>/.exec(user)![1];
  assert.equal(task, `Called by Alice, they ${labels.triggers.private}. Answer #1 as Nept. Target: #1.`);
});

test('buildRequest: a private chat appends turn/private to its task with context.memory.openPrivate on and off', () => {
  // Catches: the switch picking a second private file, so one setting gives a private chat two different tasks.
  const prompts = fakePrompts({ 'turn/private': 'PRIVATE_TASK', 'private-open': 'OPEN_PRIVATE_TASK' });
  for (const openPrivate of [true, false]) {
    const config = fakeConfig({ context: { memory: { openPrivate } } });
    const task = userText(buildRequest(privateScene({ config, prompts })));
    assert.ok(task.includes('PRIVATE_TASK') && !task.includes('OPEN_PRIVATE_TASK'), `openPrivate ${openPrivate}`);
  }
});

test('buildRequest: a part of a split message appends labels.task.part with the part and the other parts', () => {
  const trigger = makeMessage(1, NOW - MIN, {
    authorName: 'Alice',
    content: 'ποιος είναι ο Νίκος, κοίτα το κανάλι, και το μιμίδιο',
  });
  const parts = ['ποιος είναι ο Νίκος', 'κοίτα το κανάλι', 'και το μιμίδιο'];
  const task = (overrides: Record<string, unknown>) =>
    bodyOf(
      userText(buildRequest(baseInput({ history: [trigger], trigger, triggerKind: 'mention', ...overrides }))),
      'task'
    );
  const plain = task({ tasks: null });
  const others = ['1. ποιος είναι ο Νίκος', '3. και το μιμίδιο'].join('; ');
  const second = { part: { index: 2, total: 3, parts }, queued: [], added: [] };
  assert.equal(
    task({ tasks: second }),
    [plain, fill(labels.task.part, { index: 2, total: 3, part: 'κοίτα το κανάλι', others })].join('\n\n')
  );
  const { task: _task, ...older } = labels;
  assert.equal(
    task({ tasks: second, prompts: fakePrompts({ labels: older }) }),
    plain,
    'an older labels file adds nothing'
  );
  assert.equal(
    task({ tasks: { ...second, part: { index: 4, total: 3, parts } } }),
    plain,
    'a part out of range adds nothing'
  );
});

test("buildRequest: the author's queued calls follow a part's others, numbered on; without a part they get labels.task.queued", () => {
  const trigger = makeMessage(1, NOW - MIN, { authorName: 'Alice' });
  const parts = ['ένα', 'δύο'];
  const task = (tasks: unknown) =>
    bodyOf(userText(buildRequest(baseInput({ history: [trigger], trigger, triggerKind: 'mention', tasks }))), 'task');
  const plain = task(null);
  assert.equal(
    task({ part: { index: 1, total: 2, parts }, queued: ['τρία', 'τέσσερα'], added: [] }),
    [plain, fill(labels.task.part, { index: 1, total: 2, part: 'ένα', others: '2. δύο; 3. τρία; 4. τέσσερα' })].join(
      '\n\n'
    )
  );
  assert.equal(
    task({ part: null, queued: ['τρία', 'τέσσερα'], added: [] }),
    [plain, fill(labels.task.queued, { others: '1. τρία; 2. τέσσερα' })].join('\n\n')
  );
  const { queued: _queued, ...noQueued } = labels.task;
  const older = fakePrompts({ labels: { ...labels, task: noQueued } });
  assert.equal(
    bodyOf(
      userText(
        buildRequest(
          baseInput({
            history: [trigger],
            trigger,
            triggerKind: 'mention',
            prompts: older,
            tasks: { part: null, queued: ['τρία'], added: [] },
          })
        )
      ),
      'task'
    ),
    plain
  );
});

test("buildRequest: other members' waiting calls append labels.task.queuedOthers, on a part too; an older labels file adds nothing", () => {
  const trigger = makeMessage(1, NOW - MIN, { authorName: 'Alice' });
  const task = (tasks: unknown, prompts = fakePrompts()) =>
    bodyOf(
      userText(buildRequest(baseInput({ history: [trigger], trigger, triggerKind: 'mention', tasks, prompts }))),
      'task'
    );
  const plain = task(null);
  const others = [
    { author: 'Léa', text: 'δύο' },
    { author: 'Bjørn', text: 'τρία' },
  ];
  const othersText = fill(labels.task.queuedOthers, { others: '1. Léa: δύο; 2. Bjørn: τρία' });
  assert.equal(
    task({ part: null, queued: ['ένα'], queuedOthers: others, added: ['λοιπόν;'] }),
    [
      plain,
      fill(labels.task.queued, { others: '1. ένα' }),
      othersText,
      fill(labels.task.added, { added: 'λοιπόν;' }),
    ].join('\n\n')
  );
  const part = { index: 1, total: 2, parts: ['α', 'β'] };
  assert.equal(
    task({ part, queued: [], queuedOthers: others, added: [] }),
    [plain, fill(labels.task.part, { index: 1, total: 2, part: 'α', others: '2. β' }), othersText].join('\n\n')
  );
  const { queuedOthers: _others, ...older } = labels.task;
  assert.equal(
    task(
      { part: null, queued: [], queuedOthers: others, added: [] },
      fakePrompts({ labels: { ...labels, task: older } })
    ),
    plain
  );
});

test('buildRequest: messages folded into the call append labels.task.added after the other task labels', () => {
  const trigger = makeMessage(1, NOW - MIN, { authorName: 'Alice' });
  const task = (tasks: unknown, prompts = fakePrompts()) =>
    bodyOf(
      userText(buildRequest(baseInput({ history: [trigger], trigger, triggerKind: 'mention', tasks, prompts }))),
      'task'
    );
  const plain = task(null);
  const tasks = { part: null, queued: ['τρία'], added: ['και το δεύτερο;', 'λοιπόν;'] };
  assert.equal(
    task(tasks),
    [
      plain,
      fill(labels.task.queued, { others: '1. τρία' }),
      fill(labels.task.added, { added: 'και το δεύτερο;; λοιπόν;' }),
    ].join('\n\n')
  );
  const { added: _added, ...noAdded } = labels.task;
  assert.equal(
    task({ ...tasks, queued: [] }, fakePrompts({ labels: { ...labels, task: noAdded } })),
    plain,
    'an older labels file adds nothing'
  );
});

/** The fixed words of a label before its first placeholder. */
const labelHead = (label: string) => label.split('{')[0];

// The chats of the turns, the pipeline and the classifiers are held by a fake interface named `fake`, the
// persona being `SELF_ID`; the recall runner keeps reading the platform's own objects through the recall bridge.

// ---- the shipped layer --------------------------------------------------------

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

const PROMPTS_DIR = path.join(REPO_ROOT, 'prompts');

/** The tracked prompt files at any depth, by key: the path relative to prompts/ without `.md`, `/` between the parts. */
const PROMPT_FILES = fs
  .readdirSync(PROMPTS_DIR, { recursive: true, encoding: 'utf8' })
  .filter((file) => file.endsWith('.md'))
  .map((file) => file.slice(0, -'.md'.length).split(path.sep).join('/'))
  .sort();

const BOM = String.fromCharCode(0xfeff);

/** `prompts/<name>.md` as src/hot.ts reads it: the BOM and carriage returns dropped, trimmed. */
function readPrompt(name: string) {
  const text = fs.readFileSync(path.join(PROMPTS_DIR, `${name}.md`), 'utf8');
  return (text.startsWith(BOM) ? text.slice(1) : text).replace(/\r\n/g, '\n').trim();
}

/** The tracked layer alone: config/ with the labels read joined, and prompts/, never a local override. */
const SHIPPED = {
  config: JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'config', 'config.json'), 'utf8')),
  prompts: {
    ...Object.fromEntries(PROMPT_FILES.map((name) => [name, readPrompt(name)])),
    labels: joinLabels(JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'config', 'labels.json'), 'utf8'))),
  },
};

// The shipped labels carry the keys of the contract (the fixture covers every one).
const LABELS = SHIPPED.prompts.labels as typeof contractLabels;

/**
 * A prompt that carries `{{` or a `{key}` as text on purpose: its file name -> `{ literal, why }`.
 * The literal may remain in a request; anything else in braces may not. None today.
 */
const LITERAL_BRACES: Record<string, { literal: string; why: string }> = {};

/** `text` without the literals of LITERAL_BRACES. */
function withoutLiterals(text: string) {
  let rest = text;
  for (const { literal } of Object.values(LITERAL_BRACES)) rest = rest.split(literal).join('');
  return rest;
}

// The rules prompt reaches a request only while the memory table `rules` holds a rule (src/rules-list.ts). The requests
// here are built with no memory, the way a deployment starts, so it stays in NOT_BUILT: putting it in SYSTEM would mean
// a rule in every fixture, and tests/src/rules-list.test.ts already checks the block with and without one.
const SYSTEM = ['main', 'persona', 'format'];

/** Every kind of diary entry and the prompt file of its own task, which follows the common `diary/task.md`. */
const DIARY_KIND_FILES: Record<string, string> = Object.fromEntries(
  ['story', 'selfPicture', 'picture', 'photoset', 'randomSet', 'news', 'facts', 'thought', 'people', 'meme'].map(
    (kind) => [kind, `diary/kinds/${kind}`]
  )
);

/** The prompt files each request below must carry whole, by request. */
const LOADS = {
  reply: [...SYSTEM, 'turn/reply'],
  followUp: [...SYSTEM, 'turn/follow'],
  overheard: [...SYSTEM, 'turn/overheard'],
  errandResult: [...SYSTEM, 'turn/errand'],
  private: [...SYSTEM, 'turn/reply', 'turn/private'],
  draw: ['draw', 'appearance'],
  ...Object.fromEntries(
    Object.entries(DIARY_KIND_FILES).map(([kind, file]) => [`diary ${kind}`, [...SYSTEM, 'diary/task', file]])
  ),
  inner: [...SYSTEM, 'turn/inner'],
  heartbeat: [...SYSTEM, 'heartbeat/task'],
  describe: ['describe/picture'],
  avatar: ['describe/avatar'],
  describeGif: ['describe/gif'],
  describeVideo: ['describe/video'],
  rewatchAnswer: ['describe/rewatch'],
  searchSummary: ['summarize/search'],
  split: ['classify/split'],
  merge: ['classify/merge'],
  missed: ['classify/missed'],
  mediaPick: ['classify/pick'],
  humanizer: ['humanizer/linter', 'humanizer/editor'],
  turn: [...SYSTEM, 'turn/reply'],
};

/** The shipped config.json with `overrides` deep-merged over a fresh copy. */
function shippedConfig(overrides: Record<string, unknown> = {}) {
  const on = {
    models: { routes: chainsOf({ vision: 'x/vision', video: 'x/video', drawing: 'x/drawing', speech: 'x/speech' }) },
  }; // off when shipped
  return deepMerge(deepMerge(structuredClone(SHIPPED.config), on), overrides);
}

// ---- the checks -----------------------------------------------------------------

/** The text of one message content: a string as is, an array of parts as its text parts. */
function shippedContentText(content: unknown) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((part) => part?.type === 'text')
    .map((part) => part.text)
    .join('\n');
}

/** Every text a request carries, as one string. */
function requestText(messages: Array<{ content: unknown }>) {
  return messages.map((message) => shippedContentText(message.content)).join('\n\n');
}

/** The double-brace sequences left in `text`, LITERAL_BRACES aside. */
function strayPlaceholders(text: string) {
  return [...new Set(withoutLiterals(text).match(/\{\{[^{}\n]{0,40}\}\}|\{\{/g) ?? [])];
}

/** The single-brace `{key}` label placeholders left in `text`, LITERAL_BRACES aside. */
function strayLabelKeys(text: string) {
  return [...new Set(withoutLiterals(text).match(/\{[A-Za-z_]\w*\}/g) ?? [])];
}

/** The lines of prompt `name` without a placeholder: a request that loads the file carries each one verbatim. */
function literalLines(name: string) {
  const text = (SHIPPED.prompts as Record<string, unknown>)[name] as string;
  assert.equal(typeof text, 'string', `prompts/${name}.md is not loaded`);
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.includes('{{'));
}

/** Whether `text` carries prompt `name` whole. */
function carries(text: string, name: string) {
  return literalLines(name).every((line) => text.includes(line));
}

/**
 * Asserts one built request: no `{{placeholder}}` and no label `{key}` left, every prompt file of
 * `files` carried whole, every block of `blocks` rendered. Returns the request's text.
 */
function assertFilled(
  messages: unknown,
  { files = [], blocks = [] }: { files?: Array<string>; blocks?: Array<string> },
  where: string
) {
  assert.ok(Array.isArray(messages) && messages.length > 0, `${where}: no request was built`);
  const text = requestText(messages);
  assert.deepEqual(strayPlaceholders(text), [], `${where}: a placeholder reached the request unfilled`);
  assert.deepEqual(strayLabelKeys(text), [], `${where}: a label placeholder reached the request unfilled`);
  for (const name of files) {
    const missing = literalLines(name).filter((line) => !text.includes(line));
    assert.equal(
      missing.length,
      0,
      `${where}: prompts/${name}.md is not carried whole, e.g. ${JSON.stringify(missing.slice(0, 2))}`
    );
  }
  for (const tag of blocks) {
    if (tag === 'tempo') {
      // Slice 2 (g): `<tempo>` is the foot of `<chat>`, not a block, so its verdict line ends the chat's body.
      const chat = /<chat>\n([\s\S]*?)\n<\/chat>/.exec(text)?.[1] ?? '';
      const verdict = labelHead(LABELS.tempo.verdict);
      assert.ok(chat.split('\n').at(-1)?.startsWith(verdict), `${where}: no tempo at the foot of <chat>`);
      continue;
    }
    assert.ok(text.includes(`<${tag}>\n`), `${where}: no <${tag}> block`);
  }
  return text;
}

// ---- the scene: one server, its members and channels --------------------------------

const SHIPPED_NOW = Date.UTC(2026, 9, 5, 12, 0, 0);

const SELF_ID = '900000000000000001';

const SELF_NAME = 'Zoë';

const ANA = '411111111111111111';

const NIKOS = '422222222222222222';

const BJORN = '433333333333333333';

const ELODIE = '444444444444444444';

const GENERAL = '700000000000000001';

const GARDEN = '700000000000000002';

const DIARY = '700000000000000003';

const CHANNEL_INCREMENT: Record<string, bigint> = { [GENERAL]: 1n, [GARDEN]: 2n, [DIARY]: 3n };

const PEOPLE = {
  [ANA]: { id: ANA, name: 'Ana' },
  [NIKOS]: { id: NIKOS, name: 'Nikos' },
  [BJORN]: { id: BJORN, name: 'Björn' },
  [SELF_ID]: { id: SELF_ID, name: SELF_NAME },
};

const iso = (ms: number) => new Date(ms).toISOString();

/** A stored member profile, every field the renderers read filled. */
function profile(id: string, names: Array<string>, extra: Record<string, unknown> = {}) {
  return {
    id,
    names,
    character: `${names[0]} is curious and warm`,
    style: 'short lines, many questions',
    interests: [
      {
        topic: 'gardening',
        note: 'grows tomatoes on a balcony',
        weight: 4,
        firstSeen: iso(SHIPPED_NOW - 30 * DAY_MS),
        lastSeen: iso(SHIPPED_NOW - DAY_MS),
      },
      {
        topic: 'chess',
        note: '',
        weight: 1,
        firstSeen: iso(SHIPPED_NOW - 200 * DAY_MS),
        lastSeen: iso(SHIPPED_NOW - 200 * DAY_MS),
      },
    ],
    details: [
      {
        id: 1,
        text: 'lives near the sea',
        weight: 3,
        firstSeen: iso(SHIPPED_NOW - 40 * DAY_MS),
        lastSeen: iso(SHIPPED_NOW - 2 * DAY_MS),
      },
    ],
    aliases: [
      {
        name: `${names[0].slice(0, 3)}ou`,
        weight: 3,
        firstSeen: iso(SHIPPED_NOW - 20 * DAY_MS),
        lastSeen: iso(SHIPPED_NOW - DAY_MS),
      },
    ],
    relationship: 'an old friend of the chat',
    relationshipScore: 20,
    relationshipWrittenAt: iso(SHIPPED_NOW - 10 * DAY_MS),
    affinity: {
      score: 22,
      reason: 'brought crêpes to the meetup',
      history: [{ delta: 5, ts: SHIPPED_NOW - 3 * DAY_MS }],
    },
    episodes: [
      {
        date: '2026-09-28',
        what: 'taught the persona a card trick',
        quote: 'regarde bien',
        feeling: 'delighted',
        weight: 3,
        addedAt: iso(SHIPPED_NOW - 7 * DAY_MS),
      },
      {
        date: '2026-10-04',
        what: 'asked about the weather',
        quote: '',
        feeling: 'calm',
        weight: 1,
        addedAt: iso(SHIPPED_NOW - DAY_MS),
      },
    ],
    messageCount: 420,
    firstSeen: iso(SHIPPED_NOW - 90 * DAY_MS),
    lastSeen: iso(SHIPPED_NOW - 2 * MINUTE_MS),
    ...extra,
  };
}

const PROFILES: Record<string, ReturnType<typeof profile>> = {
  [ANA]: profile(ANA, ['Ana', 'Anaïs']),
  [NIKOS]: profile(NIKOS, ['Nikos']),
  [BJORN]: profile(BJORN, ['Björn']),
  [ELODIE]: profile(ELODIE, ['Élodie']),
};

const nameOf = (id: string) => {
  const names = PROFILES[id]?.names;
  return names?.[0] ?? null;
};

const GUILD_MEMORY = {
  patterns: 'quick banter, many emoji',
  starters: 'a photo of lunch, a question to the room',
  injokes: ['the eternal tomato'],
  self: ['once claimed to like rain'],
  learned: [
    {
      id: 1,
      text: 'say bonjour before anything else',
      from: `<@${ANA}>`,
      weight: 3,
      firstSeen: iso(SHIPPED_NOW - 9 * DAY_MS),
      lastSeen: iso(SHIPPED_NOW - DAY_MS),
    },
    {
      id: 2,
      text: 'never spoil a film',
      weight: 1,
      firstSeen: iso(SHIPPED_NOW - DAY_MS),
      lastSeen: iso(SHIPPED_NOW - DAY_MS),
    },
  ],
  emojiUsage: { E1: { name: 'zoe_wave', count: 4, last: SHIPPED_NOW - DAY_MS } },
  updatedAt: iso(SHIPPED_NOW - 3 * DAY_MS),
};

const CHANNELS = [
  {
    id: GENERAL,
    name: 'général',
    category: 'Café',
    topic: 'tout et rien',
    purpose: 'everyday chat',
    topics: 'plants, films, food',
    tone: 'warm teasing',
    lastMessageAt: SHIPPED_NOW - 2 * MINUTE_MS,
    messageCount: 900,
    days: { [utcDay(SHIPPED_NOW)]: 40 },
    topWriters: [
      { id: ANA, count: 30 },
      { id: NIKOS, count: 20 },
    ],
    updatedAt: iso(SHIPPED_NOW - 8 * DAY_MS),
  },
  {
    id: GARDEN,
    name: 'jardin',
    category: 'Café',
    topic: null,
    purpose: 'garden photos',
    topics: 'seeds',
    tone: 'calm',
    lastMessageAt: SHIPPED_NOW - 20 * MINUTE_MS,
    messageCount: 120,
    days: {},
  },
  {
    id: DIARY,
    name: 'journal',
    category: 'Notes',
    topic: 'one member per thread',
    purpose: 'personal diaries',
    topics: 'daily life',
    tone: 'quiet',
    lastMessageAt: SHIPPED_NOW - 5 * MINUTE_MS,
    messageCount: 60,
    days: {},
  },
];

const LORE = [
  {
    id: 'l1',
    title: 'Le grand gel',
    keys: ['tomate'],
    text: 'The winter the balcony tomatoes froze.',
    always: false,
    source: 'analyzer',
    weight: 3,
  },
];

const CUSTOM_EMOJI = [
  { id: 'E1', name: 'zoe_wave' },
  { id: 'E2', name: 'tomate_triste' },
];

const RECENT_LINES = [
  {
    id: 1,
    at: SHIPPED_NOW - 2 * HOUR_MS,
    addedAt: iso(SHIPPED_NOW - HOUR_MS),
    placeId: GARDEN,
    text: `<@${NIKOS}> planted garlic`,
    who: [NIKOS],
    weight: 2,
  },
];

const LOOKUP_RESULT = {
  query: 'tomato frost',
  text: 'Tomatoes die below zero degrees [1].',
  sources: [{ title: 'Garden notes', url: 'https://www.example.com/frost', site: 'example.com' }],
};

/**
 * A discord.js-shaped message, enough for normalizeMessage: `author` a PEOPLE entry, media as
 * plain lists (attachments `{ id, name, contentType, url, size?, duration? }`, embeds as Discord
 * sends them, stickers `{ id, name, format }`, reactions `{ name, id?, count, me? }`).
 */
function rawMessage(
  channel: { id: string; name: string | null; category?: string | null; topic?: string | null },
  {
    ts,
    author,
    content = '',
    attachments = [],
    embeds = [],
    stickers = [],
    reactions = [],
    replyTo = null,
    mentions = [],
    forwarded = null,
  }: {
    ts: number;
    author: { id: string; name: string };
    content?: string;
    attachments?: Array<{ id: string; [key: string]: unknown }>;
    embeds?: Array<unknown>;
    stickers?: Array<{ id: string; [key: string]: unknown }>;
    reactions?: Array<{ name: string; id?: string; count: number; me?: boolean }>;
    replyTo?: string | null;
    mentions?: Array<string>;
    forwarded?: string | null;
  }
) {
  // The same id on every call: the time, and the channel as the increment.
  const id = SnowflakeUtil.generate({ timestamp: ts, increment: CHANNEL_INCREMENT[channel.id] ?? 0n }).toString();
  return {
    id,
    channelId: channel.id,
    channel: {
      name: channel.name,
      parent: channel.category ? { name: channel.category } : null,
      topic: channel.topic ?? null,
    },
    guild: null,
    author: { id: author.id, bot: false, globalName: author.name, username: author.name },
    member: { displayName: author.name },
    content,
    cleanContent: content,
    createdTimestamp: ts,
    reference: replyTo ? { messageId: replyTo } : null,
    attachments: new Map(attachments.map((a) => [a.id, a])),
    embeds,
    stickers: new Map(stickers.map((s) => [s.id, s])),
    messageSnapshots: new Map(
      forwarded
        ? [
            [
              'fwd',
              { content: forwarded, cleanContent: forwarded, attachments: new Map(), embeds: [], stickers: new Map() },
            ],
          ]
        : []
    ),
    mentions: { users: new Map(mentions.map((accountId) => [accountId, { id: accountId }])) },
    reactions: {
      cache: new Map(
        reactions.map((r, i) => [
          String(i),
          { emoji: { name: r.name, id: r.id ?? null }, count: r.count, me: r.me ?? false },
        ])
      ),
    },
    flags: { has: () => false },
  };
}

const GENERAL_INFO = { id: GENERAL, name: 'général', category: 'Café', topic: 'tout et rien' };

const GARDEN_INFO = { id: GARDEN, name: 'jardin', category: 'Café', topic: null };

const GIF_EMBED = {
  url: 'https://tenor.com/view/cat-wave-123',
  provider: { name: 'Tenor' },
  thumbnail: { url: 'https://media.tenor.com/cat.png' },
  video: { url: 'https://media.tenor.com/cat.mp4' },
};

const PAGE_EMBED = {
  url: 'https://example.org/tomates',
  title: 'Tomates en pot',
  description: 'Comment cultiver des tomates sur un balcon',
};

/** The chat of #général the turn answers, oldest first: every kind of media the transcript renders. */
function generalRaws() {
  const at = (minutes: number) => SHIPPED_NOW - minutes * MINUTE_MS;
  const raws: Array<ReturnType<typeof rawMessage>> = [];
  const add = (fields: Parameters<typeof rawMessage>[1]) => {
    const raw = rawMessage(GENERAL_INFO, fields);
    raws.push(raw);
    return raw;
  };
  add({
    ts: at(55),
    author: PEOPLE[NIKOS],
    content: 'bonjour à tous, la tomate a gelé',
    reactions: [
      { name: '🍅', count: 3 },
      { name: 'zoe_wave', id: 'E1', count: 1, me: true },
    ],
  });
  const own = add({ ts: at(50), author: PEOPLE[SELF_ID], content: 'oh non, pauvre tomate' });
  add({
    ts: at(45),
    author: PEOPLE[BJORN],
    content: 'la preuve',
    attachments: [
      {
        id: '800000000000000001',
        name: 'photo.png',
        contentType: 'image/png',
        url: 'https://cdn.discordapp.com/attachments/1/2/photo.png',
        size: 2000,
      },
    ],
  });
  add({
    ts: at(40),
    author: PEOPLE[NIKOS],
    content: 'regardez https://tenor.com/view/cat-wave-123',
    embeds: [GIF_EMBED],
  });
  const video = add({
    ts: at(35),
    author: PEOPLE[ANA],
    content: 'une vidéo des oranges',
    attachments: [
      {
        id: '800000000000000002',
        name: 'oranges.mp4',
        contentType: 'video/mp4',
        url: 'https://cdn.discordapp.com/attachments/1/2/oranges.mp4',
        size: 90000,
        duration: 20,
      },
    ],
  });
  add({ ts: at(30), author: PEOPLE[BJORN], content: 'un article https://example.org/tomates', embeds: [PAGE_EMBED] });
  add({
    ts: at(26),
    author: PEOPLE[ANA],
    content: '',
    stickers: [{ id: '810000000000000001', name: 'tomato_dance', format: 1 }],
  });
  add({
    ts: at(22),
    author: PEOPLE[NIKOS],
    content: 'mes graines',
    attachments: [
      {
        id: '800000000000000003',
        name: 'graines.txt',
        contentType: 'text/plain',
        url: 'https://cdn.discordapp.com/attachments/1/2/graines.txt',
        size: 40,
      },
    ],
  });
  add({ ts: at(18), author: PEOPLE[BJORN], content: 'vu ailleurs', forwarded: 'le gel arrive mardi' });
  add({ ts: at(14), author: PEOPLE[SELF_ID], content: 'jolie vidéo', replyTo: video.id });
  add({ ts: at(10), author: PEOPLE[NIKOS], content: 'Zoë, tu as aimé ?', replyTo: own.id });
  add({
    ts: at(2),
    author: PEOPLE[ANA],
    content: '@Zoë de quelle couleur sont les oranges dans la vidéo ? et quand gèle la tomate ?',
    mentions: [SELF_ID],
  });
  return raws;
}

const normalize = (raws: Array<ReturnType<typeof rawMessage>>) =>
  raws.map((raw) => {
    const media = SHIPPED.config.media;
    const line = normalizeMessage(raw, SELF_ID, {
      videoSites: media.video.sites,
    });
    // The interface's line names its channel natively; the core reads the same line under its place.
    return { ...line, placeId: line.channelId };
  });

/** A fetch stand-in for text attachment previews: every file reads the same short text. */
const previewFetch = async () => ({
  ok: true,
  headers: { get: () => null },
  text: async () => 'graines: tomate, basilic, ail',
});

/** The #général chat, normalized, text previews filled, oldest first. */
async function generalHistory() {
  return withTextPreviews(normalize(generalRaws()), 500, previewFetch);
}

/** Captions, watched videos and read pages for every media item of `history`, as a turn hands them in. */
function mediaMaps(history: ReturnType<typeof normalize>) {
  const descriptions = new Map();
  const videos = new Map();
  const reads = new Map();
  for (const message of history) {
    for (const item of (message.attachments ?? []) as Array<{ id: string; kind: string }>) {
      if (item.kind === 'image' || item.kind === 'gif') descriptions.set(item.id, 'a tomato plant covered in frost');
      if (item.kind === 'video')
        videos.set(item.id, {
          state: 'watched',
          text: 'a person juggles three oranges',
          answer: { question: 'what colour?', text: 'orange' },
        });
    }
    for (const link of (message.links ?? []) as Array<{ id: string; kind: string }>) {
      if (link.kind === 'gif') descriptions.set(link.id, 'a cat waves');
      else reads.set(link.id, 'How to grow tomatoes in pots on a balcony.');
    }
    for (const sticker of (message.stickers ?? []) as Array<{ id: string }>)
      descriptions.set(sticker.id, 'a dancing tomato');
  }
  return { descriptions, videos, reads };
}

/** The GIF library of the server, holding the GIF of the chat. */
function gifLibrary(history: ReturnType<typeof normalize>) {
  const gif = history.flatMap((m) => m.links ?? []).find((link) => link.kind === 'gif')!;
  return {
    nextId: 2,
    entries: {
      [gif.id]: {
        id: 'g1',
        kind: 'link',
        url: gif.url,
        site: 'tenor.com',
        itemId: gif.id,
        count: 3,
        last: SHIPPED_NOW - DAY_MS,
        firstSeen: SHIPPED_NOW - 9 * DAY_MS,
      },
    },
  };
}

/** One neighbour channel with a line of its own. */
function neighbors() {
  const line = rawMessage(GARDEN_INFO, {
    ts: SHIPPED_NOW - 20 * MINUTE_MS,
    author: PEOPLE[BJORN],
    content: 'les semis sont sortis',
  });
  return [{ placeId: GARDEN, channelName: 'jardin', readOnly: false, messages: normalize([line]) }];
}

/** The input of a server turn in #général answering Ana, every optional block given. */
async function turnInput(overrides: Record<string, unknown> = {}) {
  const history = await generalHistory();
  const trigger = history.at(-1);
  const { descriptions, videos, reads } = mediaMaps(history);
  const config = shippedConfig({
    // PR 7d: the switches are code; the private chats are `dm.enabled`.
    dm: { enabled: true },
    memory: { mainChannelIds: [GENERAL] },
  });
  const input = {
    config,
    prompts: SHIPPED.prompts,
    calibrator: createCalibrator(),
    mode: 'reply',
    forced: false,
    now: SHIPPED_NOW,
    selfName: SELF_NAME,
    history,
    neighbors: neighbors(),
    trigger,
    triggerKind: 'mention',
    placeMemory: GUILD_MEMORY,
    interlocutor: PROFILES[ANA],
    otherProfiles: [PROFILES[NIKOS], PROFILES[BJORN]],
    candidateProfiles: Object.values(PROFILES),
    nameOf,
    channels: CHANNELS,
    loreEntries: LORE,
    currentChannelId: GENERAL,
    descriptions,
    neighborDescriptions: new Map(),
    videos,
    reads,
    lookup: LOOKUP_RESULT,
    searchAvailable: true,
    drawQuota: { spent: false, userSpent: false },
    customEmoji: CUSTOM_EMOJI,
    mediaCache: { 'emoji:E1': { text: 'a small waving hand', ts: SHIPPED_NOW - DAY_MS } },
    gifs: gifLibrary(history),
    readOnlyIds: new Set([DIARY]),
    recentLines: RECENT_LINES,
    recentAudience: () => true,
    ...overrides,
  };
  // Every request is built on its turn frame (slice 7).
  return Object.hasOwn(overrides, 'frame') ? input : framed(input);
}

// The blocks a fully fed server turn renders, each headed or filled by labels. Slice 7: every request is built on its
// turn frame (docs/prompt-contract.md), so these are the frame's blocks and none of the old ones.
const TURN_BLOCKS = [
  'self',
  'senses',
  'surroundings',
  'memory',
  'people',
  'spatial_awareness',
  'chat',
  'tempo',
  'task',
];

test('buildRequest: an overheard line fills turn/overheard.md in place of the reply task', async () => {
  const request = buildRequest(await turnInput({ triggerKind: 'overheard' }));
  const text = assertFilled(request.messages, { files: LOADS.overheard, blocks: TURN_BLOCKS }, 'overheard');
  assert.ok(!carries(text, 'turn/reply'), 'the reply task is not sent as well');
});

test('buildRequest: the turn a finished errand opens without an origin message fills turn/errand.md in place of interject.md', async () => {
  const history = await generalHistory();
  const request = buildRequest(
    await turnInput({
      mode: 'interject',
      trigger: null,
      triggerKind: 'errand',
      interlocutor: null,
      focus: history.at(-2),
    })
  );
  const text = assertFilled(
    request.messages,
    { files: LOADS.errandResult, blocks: ['senses', 'chat', 'tempo', 'task'] },
    'errand-result'
  );
  // Slice 5: interject.md is deleted, so no second task file can ride along and the old check on it went.
  assert.ok(text.includes('<task>\n'));
});

test('buildRequest: a private chat fills turn/private.md after the reply task', async () => {
  const dm = { id: 'dm1', name: null, category: null, topic: null };
  const at = (minutes: number) => SHIPPED_NOW - minutes * MINUTE_MS;
  const history = normalize([
    rawMessage(dm, { ts: at(6), author: PEOPLE[ANA], content: 'tu es là ?' }),
    rawMessage(dm, { ts: at(5), author: PEOPLE[SELF_ID], content: 'oui' }),
    rawMessage(dm, { ts: at(1), author: PEOPLE[ANA], content: 'je peux te dire un secret ?' }),
  ]);
  const privateProfile = {
    relationship: 'a quiet confidante',
    affinity: { score: 30, reason: 'shared a secret', history: [] },
    episodes: [
      {
        date: '2026-10-03',
        what: 'told the persona about a new job',
        quote: 'chut',
        feeling: 'trusted',
        weight: 3,
        addedAt: iso(SHIPPED_NOW - 2 * DAY_MS),
      },
    ],
    details: [
      {
        id: 1,
        text: 'starts a new job on Monday',
        weight: 2,
        firstSeen: iso(SHIPPED_NOW - 2 * DAY_MS),
        lastSeen: iso(SHIPPED_NOW - 2 * DAY_MS),
      },
    ],
  };
  const request = buildRequest(
    await turnInput({
      history,
      trigger: history.at(-1),
      triggerKind: 'private',
      currentChannelId: 'dm1',
      dmChat: { accountId: ANA },
      privateProfile,
      neighbors: [],
      lookup: null,
      descriptions: new Map(),
      videos: new Map(),
      reads: new Map(),
    })
  );
  const text = assertFilled(
    request.messages,
    { files: LOADS.private, blocks: ['senses', 'people', 'chat', 'tempo', 'task'] },
    'private'
  );
  assert.ok(text.includes(LABELS.senses.dmChat), 'the private senses line');
});

test('buildRequest: a private chat with context.memory.openPrivate on fills turn/private.md after the reply task', async () => {
  const dm = { id: 'dm1', name: null, category: null, topic: null };
  const history = normalize([
    rawMessage(dm, { ts: SHIPPED_NOW - MINUTE_MS, author: PEOPLE[ANA], content: 'je peux te dire un secret ?' }),
  ]);
  const request = buildRequest(
    await turnInput({
      config: shippedConfig({ dm: { enabled: true }, context: { memory: { openPrivate: true } } }),
      history,
      trigger: history.at(-1),
      triggerKind: 'private',
      currentChannelId: 'dm1',
      dmChat: { accountId: ANA },
      neighbors: [],
      lookup: null,
      descriptions: new Map(),
      videos: new Map(),
      reads: new Map(),
    })
  );
  const text = assertFilled(
    request.messages,
    // Changed: one private prompt serves the switch on and off, so the open chat loads the files of any private chat.
    { files: LOADS.private, blocks: ['senses', 'chat', 'task'] },
    'private (open)'
  );
  assert.ok(text.includes(LABELS.senses.dmChatOpen), 'the open private senses line');
});

/** The input of an inner turn woken by a wake of `wakeKind`. */
const wakeInput = (wakeKind: string) =>
  turnInput({ mode: 'inner', trigger: null, triggerKind: 'inner', interlocutor: null, wake: '', wakeKind });

// Slice 5: the review is gone; a due intention is the inner turn that keeps turn/inner.md.
test('buildRequest: an inner turn woken by a heartbeat fills heartbeat.md in place of turn/inner.md; a due intention keeps turn/inner.md', async () => {
  const beat = await wakeInput('heartbeat');
  const beatRequest = buildRequest(beat);
  const beatText = assertFilled(beatRequest.messages, { files: LOADS.heartbeat, blocks: ['task'] }, 'heartbeat turn');
  const messages = beatRequest.messages;
  assert.ok(!/^<chat>\s*$/m.test(promptUserText(messages[1].content)), 'a heartbeat has no current chat to answer');
  assert.ok(
    // Slice 2 (g): no `<tempo>` block exists any more, so the check looks for the tempo's verdict line anywhere.
    !promptUserText(messages[1].content)
      .split('\n')
      .some((line) => line.startsWith(labelHead(LABELS.tempo.verdict))),
    'silence in an anchor channel is not heartbeat tempo'
  );
  assert.ok(!carries(beatText, 'turn/inner'), 'turn/inner.md is not sent as well');
  const due = await wakeInput('intention_due');
  const dueText = assertFilled(
    buildRequest(due).messages,
    { files: LOADS.inner, blocks: ['chat', 'task'] },
    'intention turn'
  );
  assert.ok(!carries(dueText, 'heartbeat/task'), 'heartbeat/task.md is not sent on an intention turn');
  const missing = await wakeInput('heartbeat');
  missing.prompts = { ...SHIPPED.prompts, 'heartbeat/task': '  ' } as typeof SHIPPED.prompts;
  assertFilled(buildRequest(missing).messages, { files: LOADS.inner }, 'heartbeat with no heartbeat/task.md');
});

test('buildRequest: a recovery turn names its messages under labels.task.missed and its trigger label', async () => {
  const tasks = {
    part: null,
    queued: [],
    queuedOthers: [],
    added: [],
    missed: [{ author: 'Ana', text: 'tu es là ?' }],
  };
  const request = buildRequest(await turnInput({ triggerKind: 'missed', tasks }));
  const text = assertFilled(request.messages, { files: LOADS.reply, blocks: TURN_BLOCKS }, 'reply (missed)');
  assert.ok(text.includes(LABELS.triggers.missed), 'the trigger label fills {{trigger}}');
  assert.ok(text.includes(fill(LABELS.task.missed, { missed: '1. Ana: tu es là ?' })), 'the task names the messages');
});
