// Tests for src/turn/skill-calls.ts: how the skill calls of a turn are planned, checked, refused and made, with their
// journal lines, cooldowns and results. Synthetic ids and text, fake adapters, no provider.
import { after, test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { userText as textOf } from '../../../src/behavior/prompt.ts';
import { fill } from '../../../src/format.ts';
import { labels } from '../../fixtures/labels.ts';
import { withCapturedLogs } from '../../fixtures/capture-logs.ts';
import type { LogEntry } from '../../fixtures/capture-logs.ts';
import { call, toolAnswer, completionOf } from '../../fixtures/tool-answers.ts';
import { handleOf } from '../../../src/behavior/handles.ts';
import { callMarksOf, createJournal } from '../../../src/memory/journal.ts';
import { createFakeAdapter } from '../../../scripts/lib/fake.ts';
import '../../../src/tools/operations/index.ts';
import { skillRegistry } from '../../../src/tools/registry.ts';
import { createAdmin } from '../../../src/admin.ts';
import { createDiscordInterface } from '../../../interfaces/discord/index.ts';
import { world, useIface } from '../../fixtures/turn-world.ts';
import { createTurnRunner } from '../../fixtures/turn-runner.ts';
import { openTestMemorySync, journalLineLabel } from '../../fixtures/memory-db/service.ts';
import type { JournalLinesWrite } from '../../../src/memory/db/journal-lines.ts';
import { asRecord } from '../../fixtures/records.ts';
import type { Untyped } from '../../../src/tools/types.ts';
import {
  NOW as KIT_NOW,
  fakeClient,
  fakeHot,
  fakeStore,
  fakeTurnChannel,
  identityCalibrator,
  normalizedTrigger,
  rawMessage as kitRawMessage,
} from '../../fixtures/turn-kit.ts';
import { OWNER_PERSON } from '../../fixtures/owner-accounts.ts';
import { directorAnswer } from '../../fixtures/scene-answer.ts';
import { objectMediaCache } from '../../../src/memory/store-media.ts';
import { worldTurnRunner } from '../../fixtures/world-runner.ts';
import { serviceTurn, serviceWake } from '../../fixtures/service-turn.ts';
import {
  appended,
  contentText,
  coreTurn,
  journalOverMemory,
  NOW,
  rawMessage,
  toolResults,
} from '../../fixtures/turn-harness.ts';
import type { FakeLlm } from '../../fixtures/turn-harness.ts';
import { skillTurn } from '../../fixtures/skill-tool-turns.ts';
import type { SkillTurn } from '../../fixtures/skill-tool-turns.ts';
import { skillText, skillsRig } from '../../fixtures/skills-rig.ts';
import type { SkillsRig } from '../../fixtures/skills-rig.ts';

useIface('discord');

/** The test memory databases opened here; closed when the file is done. */
const OPENED_MEMORY: Array<{ close: () => Promise<void> }> = [];

after(async () => {
  for (const mem of OPENED_MEMORY) await mem.close();
});

// The Discord interface's capabilities object, as src/index.ts injects it.
const DISCORD = createDiscordInterface().capabilities;

/** A fake createImageGen()-shaped dependency (see src/llm/images.ts). */
function fakeImages({ error = null, mediaType = 'image/png' }: { error?: Error | null; mediaType?: string } = {}) {
  const generateCalls: Array<Untyped> = [];
  return {
    generateCalls,
    generate: async (args: unknown) => {
      generateCalls.push(args);
      if (error) throw error;
      return {
        buffer: Buffer.from('fake picture'),
        mediaType,
        cost: 0.02,
        usage: {},
        model: 'fake/model',
        seconds: 1.5,
      };
    },
  };
}

/** A fake LLM answering each call with the next text of `answers` (the last one repeats). */
/** An LLM answering `answers` in turn (the last one repeats); an answer is its text, or the completion's fields over the defaults. */
function sequenceLlm(answers: Array<string | Record<string, unknown>>) {
  const calls: Array<Untyped> = [];
  const options: Array<Untyped> = [];
  return {
    calls,
    options,
    complete: async (messages: unknown, requestOptions: unknown) => {
      calls.push(messages);
      options.push(requestOptions ?? {});
      const answer = answers[Math.min(calls.length - 1, answers.length - 1)];
      return typeof answer === 'string'
        ? { text: answer, usage: {}, estimated: 10 }
        : { usage: {}, estimated: 10, ...answer };
    },
  };
}

// The server's custom emoji (features.customEmoji, src/behavior/emoji-index.ts).
function fakeEmojiIndex() {
  const emojis = [
    { id: '111111111111111111', name: 'e1', platformName: 'pepe_cry', animated: false },
    { id: '222222222222222222', name: 'e2', platformName: 'dance', animated: true },
  ];
  const byName = (name: string) => emojis.find((e) => e.name === name) ?? null;
  return { refresh: () => Promise.resolve(), byName, list: () => emojis.map((e) => ({ ...e })) };
}

test("skill call: format.stripDashes on posts the persona's own message.create without em dashes and guillemets", async () => {
  const { sends, logs } = await callTurn({
    answers: [toolAnswer('', [call('message.create', { text: 'ναι — «αύριο»' })]), '<skip/>'],
    configExtra: { format: { stripDashes: true } },
  });
  assert.deepEqual(
    sends.map((send) => send.text),
    ['ναι "αύριο"']
  );
  assert.equal(logs.find((entry) => entry.msg === 'turn: dashes stripped')?.count, 1);
});

test("skill call: format.stripDashes false posts the persona's own message.create as they wrote it", async () => {
  const { sends } = await callTurn({
    answers: [toolAnswer('', [call('message.create', { text: 'ναι — «αύριο»' })]), '<skip/>'],
    configExtra: { format: { stripDashes: false } },
  });
  assert.deepEqual(
    sends.map((send) => send.text),
    ['ναι — «αύριο»']
  );
});

test("skill call: format.stripDashes on edits the persona's own message without em dashes", async () => {
  const { port } = await callTurn({
    answers: [toolAnswer('', [call('message.edit', { message: '#1', text: 'πρώτη — δεύτερη' })]), '<skip/>'],
    allowed: ['message.edit'],
    configExtra: { format: { stripDashes: true } },
  });
  const edits = port.calls.filter((entry) => entry.op === 'edit').map((entry) => asRecord(entry.args[1]).text);
  assert.deepEqual(edits, ['πρώτη δεύτερη']);
});

/** A real journal over a test memory database whose writes also keep every line in memory. */
function turnJournalOverMemory() {
  const lines: Array<{ file: string; record: Untyped }> = [];
  const mem = openTestMemorySync();
  OPENED_MEMORY.push(mem);
  const memoryDb = {
    ...mem.memoryDb,
    writeJournalLines: (write: JournalLinesWrite) => {
      // Legacy labels are fixture export projections of the actual place and day.
      for (const line of write.lines)
        lines.push({ file: journalLineLabel('fake-data', write.placeId, line), record: line });
      return mem.memoryDb.writeJournalLines(write);
    },
  };
  let n = 0;
  const journal = createJournal({
    memoryDb,
    dataDir: 'fake-data',
    config: () => ({ thinkChars: 4000 }),
    now: () => KIT_NOW,
    uuid: () => `u${(n += 1)}`,
  });
  return { journal, lines };
}

/** The action records of `lines` for operation `name`, in order. */
function actionsNamed(lines: Untyped, name: string) {
  return lines
    .map(({ record }: Untyped) => record)
    .filter((record: Untyped) => record.kind === 'action' && record.name === name);
}

/** `bot.access` granting each of `names` to the persona (the fake client's user, `self-id`). */
function personaGrants(names: Untyped) {
  return Object.fromEntries(names.map((name: Untyped) => [name, { everyone: false, roles: [], users: ['self-id'] }]));
}

// ---------------------------------------------------------------------------
// Skill calls (src/tools/executors.ts): the persona's skills are the /nep commands; one `<call>` per turn,
// checked, run after the reply's own effects through the command's own path (a real admin over
// the same fake port), and one follow-up request with its result when the persona needs it.

/** The actions of the journal named `skill`, their phases in order. */
function skillPhases(lines: unknown) {
  return actionsNamed(lines, 'skill').map((record: Untyped) => record.phase);
}

/**
 * A mention by Alice (u1, #2) after a line of the persona (#1) in #general (c1), with #νέα (c9,
 * where the bot may do anything) and #αλλού (c8, where it may not send) in the guild; no
 * `tools.chats` list; the LLM answers `answers` in
 * order; `allowed` skills are granted to the persona (the persona's user id in bot.access); `owners` are the bot's
 * owners (Alice by default: the owner asks); the port is a fake adapter, the operations run on a
 * real admin over it; `emoji`: the server's custom emoji index, none by default; `later`: raw
 * messages that reach #general once the LLM has answered the first request; `labelSet`: the
 * labels in place of the fixture's.
 */
async function callTurn({
  answers,
  allowed = [],
  features = {},
  tools = {},
  owners = ['u1'],
  images = null,
  journal = null,
  store = fakeStore(),
  beforeSend = null,
  failNext = null,
  diary = null,
  configExtra = {},
  turnExtra = {},
  emoji = null,
  later = [],
  labelSet = null,
  runnerExtra = {},
}: Record<string, Untyped>) {
  const history = [
    kitRawMessage({ id: 'm0', ts: KIT_NOW - 5000, authorId: 'self-id', authorName: 'Bot', content: 'πρώτη' }),
    kitRawMessage({ id: 'm1', ts: KIT_NOW - 1000, authorId: 'u1', authorName: 'Alice', content: 'γράψε στο #νέα' }),
  ];
  const channel = fakeTurnChannel({ historyMessages: history });
  fakeTurnChannel({ id: 'c9', name: '💖νέα' });
  fakeTurnChannel({ id: 'c8', name: 'αλλού', permissions: { send: false } });
  const port = createFakeAdapter({ iface: 'fake', selfId: 'self-id', now: () => KIT_NOW });
  if (failNext) port.failNext(...(failNext as Parameters<typeof port.failNext>));
  const hot = fakeHot(
    { typingSimulation: false, journal: Boolean(journal), ...features },
    // The owner is `bot.ownerPerson` with these accounts bound to it; no owners, no owner person.
    (owners as Array<string>).length === 0
      ? { access: personaGrants(allowed) }
      : { ownerPerson: OWNER_PERSON, access: personaGrants(allowed) },
    { tools: { safeMode: false, resultMaxChars: 2000, ...tools }, ...configExtra }
  );
  hot.prompts.draw = 'Drawing for {{name}}.\n\n{{request}}';
  if (labelSet) hot.prompts.labels = labelSet;
  if (beforeSend) {
    const send = port.send.bind(port);
    port.send = async (...args) => {
      await beforeSend({ hot, store }, args);
      return send(...args);
    };
  }
  const client = fakeClient();
  const admin = createAdmin({
    discord: DISCORD,
    hot,
    store,
    client,
    isServedRoot: (id: unknown) => id === 'g1',
    reads: world().adopt(port),
    port,
    ...(images ? { images } : {}),
    ...(diary ? { diary: diary(hot) } : {}),
  });
  const llm = sequenceLlm(answers);
  const complete = llm.complete;
  llm.complete = async (...args) => {
    const answer = await complete(...args);
    if (llm.calls.length === 1) history.push(...later);
    return answer;
  };
  const turns = createTurnRunner({
    discord: DISCORD,
    hot,
    store,
    llm,
    calibrator: identityCalibrator(),
    client,
    now: () => KIT_NOW,
    port,
    skills: skillRegistry(),
    journal,
    images,
    runOp: admin.runSkillOp,
    runOwnOp: admin.runOwnSkillOp,
    ...(emoji ? { emoji } : {}),
    ...runnerExtra,
  });
  const { result, logs } = await withCapturedLogs(() =>
    turns.runTurn({
      channel,
      mode: 'reply',
      trigger: normalizedTrigger(history[1]),
      triggerKind: 'mention',
      ...turnExtra,
    })
  );
  const sends = port.calls
    .filter((call) => call.op === 'send')
    .map((call): Record<string, Untyped> => ({ to: asRecord(call.args[0]).chatId, ...asRecord(call.args[1]) }));
  return { result, logs, llm, port, sends, channel, store, hot };
}

/** The user text of the LLM's call `i`. */
function requestText(llm: Untyped, i: number): string {
  const call = llm.calls[i];
  return textOf(call[1].content);
}

/** The text of a message's content, parts joined. */
function contentOf(message: Untyped): string {
  return typeof message?.content === 'string'
    ? message.content
    : (message?.content ?? []).map((part: Untyped) => part.text ?? '').join('');
}

/** What the persona read of their call number `n` (0-based) in request `i`: the content of its tool message. */
function followUpTool(llm: Untyped, i: number, n = 0): string {
  const llmCalls = llm.calls;
  const message = llmCalls[i].filter((item: Untyped) => item.role === 'tool')[n];
  return typeof message?.content === 'string'
    ? message.content
    : (message?.content ?? []).map((part: Untyped) => part.text ?? '').join('');
}

test("skill call: message.create to another channel where the bot may send runs before the persona's reply, journaled proposed, started, succeeded, with its invocation id; their speech goes out after it and the post comes back to them in one step", async () => {
  const { journal, lines } = turnJournalOverMemory();
  const run = await callTurn({
    answers: [
      toolAnswer('<msg reply="#2">εντάξει</msg>\n', [
        call('message.create', { place: '#🍡νέα', text: 'καλημέρα :wave:' }),
      ]),
      '<skip/>',
    ],
    allowed: ['message.create'],
    journal,
  });
  assert.deepEqual([run.result.outcome, run.result.delivered], ['spoke', true]);
  assert.deepEqual(
    run.sends.map((send) => [send.to, send.text]),
    [
      ['c9', 'καλημέρα :wave:'],
      ['c1', 'εντάξει'],
    ],
    'the call runs first, the speech after it'
  );
  // Changed: content carries no mentions, so nothing is asserted of them.
  // A quiet call in a turn that answers someone is shown to the persona in one step.
  const runLlm = run.llm;
  assert.equal(runLlm.calls.length, 2, 'the post came back to the persona in one step, where they stayed silent');
  assert.deepEqual(skillPhases(lines), ['proposed', 'started', 'succeeded']);
  const actions = actionsNamed(lines, 'skill');
  const action = actions[0];
  assert.match(action.input.invocationId, /^[0-9a-f-]{36}$/, 'the invocation id is kept with its state');
  assert.match(action.input.toolCallId, /^s1c1$/, 'and the id of the tool call');
  const started = actions.find((record: Untyped) => record.phase === 'started');
  assert.equal(started.target.channel, 'c9');
  assert.ok(!JSON.stringify(actions).includes('καλημέρα'), 'the journal names ids, never the text');
  const turn = lines.map(({ record }) => record).find((record) => record.kind === 'turn');
  assert.ok(turn.actions.includes(started.opId));
  assert.ok(
    run.logs.some(
      (entry) => entry.msg === 'skills: called' && entry.skill === 'message.create' && entry.status === 'ok'
    )
  );
});

test('skill call: takes its invocation id from the id source the runner is given', async () => {
  const { journal, lines } = turnJournalOverMemory();
  let count = 0;
  await callTurn({
    answers: [toolAnswer('', [call('message.create', { place: '#🍡νέα', text: 'καλημέρα' })]), '<skip/>'],
    allowed: ['message.create'],
    journal,
    runnerExtra: {
      newId: () => {
        count += 1;
        return `harness-${count}`;
      },
    },
  });
  assert.equal(actionsNamed(lines, 'skill')[0].input.invocationId, 'harness-1');
});

// An emoji and a sticker go by a stable name of the engine.
test("skill call: the persona's message.create and message.edit text goes out like a <msg> -- a handle is named, a name, an unknown handle and @everyone stay text and name nobody; custom emoji, #N and channel links", async () => {
  const alice = `@${handleOf('u1')}`;
  const unknown = alice === '@uzzzz' ? '@u0000' : '@uzzzz';
  const written = `${alice} @Alice ${unknown} @everyone :e2: #2 #αλλού`;
  const rendered = `<@u1> @Alice ${unknown} @everyone <a:dance:222222222222222222> https://discord.com/channels/g1/c1/m1 <#c8>`;
  const created = await callTurn({
    // A quiet call in a turn that answers someone is shown to the persona in one step.
    answers: [toolAnswer(``, [call('message.create', { place: `#νέα`, text: `${written}` })]), '<skip/>'],
    allowed: ['message.create'],
    emoji: fakeEmojiIndex(),
  });
  assert.equal(created.result.outcome, 'spoke');
  assert.deepEqual(
    created.sends.map((send) => [send.to, send.text]),
    [['c9', rendered]]
  );
  // Changed: content carries no mentions, so the rendered text above is what shows the resolved member.
  // A reply keeps working.
  const replied = await callTurn({
    answers: [toolAnswer(``, [call('message.create', { reply: `#2`, text: `${alice} :e2:` })]), '<skip/>'],
    emoji: fakeEmojiIndex(),
  });
  assert.deepEqual(
    replied.sends.map((send) => [send.to, send.text, send.replyTo?.messageId]),
    [['c1', '<@u1> <a:dance:222222222222222222>', 'm1']]
  );
  // The edit path: the same rendering.
  const edited = await callTurn({
    answers: [toolAnswer(``, [call('message.edit', { message: `#1`, text: `${written}` })]), '<skip/>'],
    allowed: ['message.edit'],
    emoji: fakeEmojiIndex(),
  });
  const editedPort = edited.port;
  const edits = editedPort.calls
    .filter((call) => call.op === 'edit')
    .map((call) => [asRecord(call.args[0]).messageId, call.args[1]]);
  // Changed: content carries no mentions, so the edit carries the rendered text alone.
  assert.deepEqual(edits, [['m0', { text: rendered }]]);
  // A quiet call in a turn that answers someone is shown to the persona in one step.
  const editedLlm = edited.llm;
  assert.equal(editedLlm.calls.length, 2, 'the edit came back to the persona in one step');
});

// A quiet call's outcome is shown to the persona in one step when the turn answers someone. Without that step, an
// edit made on request ends the turn with Discord showing the persona typing and nothing said.
test('skill call: a quiet success in an addressed turn is shown to the persona in one step; a turn nobody asked for ends with it', async () => {
  const addressed = await callTurn({
    answers: [
      toolAnswer('', [call('message.edit', { message: '#1', text: 'διορθωμένη' })]),
      '<msg>έγινε, διόρθωσα</msg>',
    ],
    allowed: ['message.edit'],
  });
  assert.equal(addressed.result.outcome, 'spoke');
  const addressedLlm = addressed.llm;
  assert.equal(addressedLlm.calls.length, 2, 'the edit came back to the persona in a second request');
  assert.deepEqual(
    addressed.sends.map((send) => send.text),
    ['έγινε, διόρθωσα']
  );
  assert.equal(addressed.result.delivered, true, 'the edit went out');
  const silent = await callTurn({
    answers: [toolAnswer('', [call('message.edit', { message: '#1', text: 'διορθωμένη' })]), '<skip/>'],
    allowed: ['message.edit'],
  });
  const { calls: silentCalls } = silent.llm;
  assert.equal(silentCalls.length, 2);
  assert.deepEqual(silent.sends, [], 'the persona may stay silent after seeing it');
  // One step: a quiet call the persona makes in the shown step ends the turn with it.
  const twice = await callTurn({
    answers: [
      toolAnswer('', [call('message.edit', { message: '#1', text: 'διορθωμένη' })]),
      toolAnswer('', [call('message.edit', { message: '#1', text: 'ξανά διορθωμένη' })]),
      '<msg>δεν θα ζητηθεί</msg>',
    ],
    allowed: ['message.edit'],
  });
  const { calls: twiceCalls } = twice.llm;
  assert.equal(twiceCalls.length, 2, 'the quiet call of the shown step is not shown again');
  const task = {
    id: 'tabc',
    agent: 'scout',
    state: 'done',
    goal: 'find a meme',
    requester: { accountId: null, kind: 'persona' },
    origin: { placeId: 'c1', messageId: null },
    result: { text: 'found', files: [] },
  };
  const spontaneous = await callTurn({
    answers: [
      toolAnswer('<msg>κι αυτό</msg>', [call('message.create', { place: '#🍡νέα', text: 'να το' })]),
      '<msg>δεν θα ειπωθεί</msg>',
    ],
    allowed: ['message.create'],
    turnExtra: { mode: 'interject', trigger: null, triggerKind: 'errand', taskResult: task },
  });
  const spontaneousLlm = spontaneous.llm;
  assert.equal(spontaneousLlm.calls.length, 1);
  assert.deepEqual(
    spontaneous.sends.map((send) => send.text),
    ['να το', 'κι αυτό']
  ); // An errand's result turn quotes the message that asked for the errand as its trigger, and still nobody waits for it:
  // the errand's own outcome is what the persona reports, a quiet call ends the turn.
  const result = await callTurn({
    answers: [
      toolAnswer('<msg>βρήκα</msg>', [call('message.create', { place: '#🍡νέα', text: 'να το' })]),
      '<msg>δεν θα ειπωθεί</msg>',
    ],
    allowed: ['message.create'],
    turnExtra: { triggerKind: 'errand', taskResult: { ...task, requester: { accountId: 'u1', kind: 'owner' } } },
  });
  const { calls: resultCalls } = result.llm;
  assert.equal(resultCalls.length, 1, 'an errand result turn with a trigger ends with the call');
  assert.deepEqual(
    result.sends.map((send) => send.text),
    ['να το', 'βρήκα']
  );
});

test('skill call: a call alone is no skip; here it needs no grant and replies to a line of this chat', async () => {
  const here = await callTurn({
    answers: [toolAnswer('', [call('message.create', { reply: '#2', text: 'ναι' })]), '<skip/>'],
  });
  assert.equal(here.result.outcome, 'spoke');
  // A quiet call in a turn that answers someone is shown to the persona in one step.
  const { calls: hereCalls } = here.llm;
  assert.equal(hereCalls.length, 2, 'the post came back to the persona and they stayed silent');
  // The current chat: carried over as a reply. Changed: content carries no mentions, so no replied-author flag.
  assert.deepEqual(
    here.sends.map((send) => [send.to, send.text, send.replyTo?.messageId]),
    [['c1', 'ναι', 'm1']]
  );
  // A reply target outside the channel the persona named. message.create never takes the reply's channel over a destination the persona named, since that would post a reply in another channel than the one they chose. A mismatch is refused unknown-message (chat), nothing sent; react, edit and delete keep the rule because their channel only locates the message they act on.
  const across = await callTurn({
    answers: [
      toolAnswer('', [call('message.create', { place: '#νέα', reply: '#2', text: 'ναι' })]),
      '<msg>όχι τελικά</msg>',
    ],
    allowed: ['message.create'],
  });
  assert.deepEqual(
    across.sends.map((send) => [send.to, send.text]),
    [['c1', 'όχι τελικά']]
  );
});

test("skill call: not granted, or a channel where the bot may not send -- refused with a result, the persona's speech held; the corrected call and their words go out in the next answer", async () => {
  const { journal, lines } = turnJournalOverMemory();
  const run = await callTurn({
    answers: [
      toolAnswer('<msg>μισό</msg>', [call('message.create', { place: '#νέα', text: 'γεια' })]),
      toolAnswer('<msg>δεν μπορώ εκεί</msg>', [call('message.create', { text: 'ξανά' })]),
      '<skip/>',
    ],
    journal,
  });
  assert.deepEqual(
    run.sends.map((send) => [send.to, send.text]),
    [
      ['c1', 'ξανά'],
      ['c1', 'δεν μπορώ εκεί'],
    ],
    'the held "μισό" never went out'
  );
  // A quiet call in a turn that answers someone is shown to the persona in one step.
  const runLlm = run.llm;
  assert.equal(
    runLlm.calls.length,
    3,
    'the refusal came back, then the post that worked, where the persona stayed silent'
  );
  const followUp = runLlm.calls[1];
  const first = runLlm.calls[0];
  assert.deepEqual(followUp[0], first[0], 'the same system prompt');
  assert.equal(followUp[1], first[1], 'the first user message is the same object');
  const labelsResult = labels.tools.result;
  const tools = labels.tools;
  assert.equal(followUpTool(run.llm, 1), fill(tools.result.refused, { reason: labelsResult.reasons['not-allowed'] }));
  assert.deepEqual(skillPhases(lines), ['proposed', 'failed', 'proposed', 'started', 'succeeded']);
  assert.equal(actionsNamed(lines, 'skill')[1].result.code, 'not-allowed');

  // Granted, but the bot may not send in that channel: the operation's own rule, its own words.
  const closed = await callTurn({
    answers: [toolAnswer('', [call('message.create', { place: '#αλλού', text: 'γεια' })]), '<skip/>'],
    allowed: ['message.create'],
  });
  assert.deepEqual(closed.sends, []);
  const text = followUpTool(closed.llm, 1);
  assert.ok(
    text.startsWith(fill(tools.result.refused, { reason: labelsResult.reasons['channel-no-permission'] })),
    text
  );
  assert.ok(text.includes('channel c8'), text);
});

test("skill call: edit and delete reach only the persona's own message", async () => {
  const edited = await callTurn({
    answers: [toolAnswer('', [call('message.edit', { message: '#1', text: 'πρώτη, διορθωμένη' })]), '<skip/>'],
    allowed: ['message.edit'],
  });
  const editedPort = edited.port;
  assert.deepEqual(
    editedPort.calls
      .filter((call) => call.op === 'edit')
      .map((call) => [asRecord(call.args[0]).messageId, asRecord(call.args[1]).text]),
    [['m0', 'πρώτη, διορθωμένη']]
  );
  // A quiet call in a turn that answers someone is shown to the persona in one step.
  const editedLlm = edited.llm;
  assert.equal(editedLlm.calls.length, 2);
  const deleted = await callTurn({
    answers: [toolAnswer('', [call('message.delete', { message: '#1' })]), '<skip/>'],
    allowed: ['message.delete'],
  });
  const deletedPort = deleted.port;
  assert.deepEqual(
    deletedPort.calls.filter((call) => call.op === 'delete').map((call) => asRecord(call.args[0]).messageId),
    ['m0']
  );
  for (const answer of [
    toolAnswer('', [call('message.edit', { message: '#2', text: 'όχι' })]),
    toolAnswer('', [call('message.delete', { message: '#2' })]),
  ]) {
    const run = await callTurn({ answers: [answer, '<skip/>'], allowed: ['message.edit', 'message.delete'] });
    const runPort = run.port;
    assert.deepEqual(
      runPort.calls.filter((call) => call.op === 'edit' || call.op === 'delete'),
      [],
      String(answer)
    );
    const transcript = labels.transcript;
    const reason = fill(transcript.callReasons['not-own-message'], { arg: 'message' });
    const tools = labels.tools;
    assert.equal(
      followUpTool(run.llm, 1),
      fill(tools.result.refused, { reason }),
      'the persona reads whose message it was not'
    );
  }
});

test("skill call: the result turn of the persona's own errand runs their write on their grants, and so does the same turn with nobody behind it", async () => {
  const task = {
    id: 'tabc',
    agent: 'scout',
    state: 'done',
    goal: 'find a meme',
    requester: { accountId: null, kind: 'persona' },
    origin: { placeId: 'c1', messageId: null },
    result: { text: 'found', files: [] },
  };
  const answer = toolAnswer('', [call('message.create', { place: '#🍡νέα', text: 'να το' })]);
  // Without an origin message the turn is an interjection with a task result: the persona's call runs.
  const own = await callTurn({
    answers: [answer, '<skip/>'],
    allowed: ['message.create'],
    turnExtra: { mode: 'interject', trigger: null, triggerKind: 'errand', taskResult: task },
  });
  assert.deepEqual(
    own.sends.map((send) => [send.to, send.text]),
    [['c9', 'να το']],
    String(own.logs.filter((e) => e.msg === 'skills: called').map((e) => e.code))
  );
  // The same turn without the persona requester (the errand's origin lost its kind) is nobody's.
  const nobody = await callTurn({
    answers: [answer, '<skip/>'],
    allowed: ['message.create'],
    turnExtra: {
      mode: 'interject',
      trigger: null,
      triggerKind: 'errand',
      taskResult: { ...task, requester: { accountId: null, kind: 'member' } },
    },
  });
  // A call of the persona's runs on their grant alone, so nobody asking refuses no write.
  assert.deepEqual(
    nobody.sends.map((send) => [send.to, send.text]),
    [['c9', 'να το']],
    String(nobody.logs.filter((e) => e.msg === 'skills: called').map((e) => e.code))
  );
});

test("skill call: a read brings the operation's answer back in one more request; a member without the right has it run on the persona's grant", async () => {
  const store = fakeStore({ loreEntries: [] });
  const run = await callTurn({
    answers: [toolAnswer('', [call('lore.list')]), '<msg>τίποτα</msg>'],
    allowed: ['lore.list'],
    store,
  });
  const runLlm = run.llm;
  assert.equal(runLlm.calls.length, 2);
  const tools = labels.tools;
  assert.ok(followUpTool(run.llm, 1).startsWith(tools.result.ok), followUpTool(run.llm, 1));
  const runCalls = run.llm.calls;
  assert.ok(!runCalls[0].some((message: Untyped) => message.role === 'tool'), 'the first request carries no result');
  assert.deepEqual(
    run.sends.map((send) => send.text),
    ['τίποτα']
  );
  // Alice holds no owner account and no grant of lore.list.
  const member = await callTurn({
    answers: [toolAnswer('', [call('lore.list')]), '<skip/>'],
    allowed: ['lore.list'],
    owners: [],
    store,
  });
  // The persona's grant alone decides, so the member's missing right refuses nothing.
  assert.ok(
    followUpTool(member.llm, 1).startsWith(tools.result.ok),
    String(member.logs.filter((e) => e.msg === 'skills: called').map((e) => e.code))
  );
});

test("skill call: a member who may not run an owner-only operation asks for it and the persona's call runs on their grant", async () => {
  // No owner person: Alice, who asks, is a member, and memory.private.read is owner-only.
  const run = await callTurn({
    answers: [toolAnswer('', [call('memory.private.read', { user: 'Alice' })]), '<skip/>'],
    allowed: ['memory.private.read'],
    owners: [],
    store: fakeStore({ userProfiles: { u1: { id: 'u1', names: ['Alice'] } } }),
  });
  const result = followUpTool(run.llm, 1);
  const tools = labels.tools;
  assert.ok(
    result.startsWith(tools.result.ok),
    String(run.logs.filter((e) => e.msg === 'skills: called').map((e) => e.code))
  );
  assert.ok(result.includes('No private memory for this member'), result);
});

test('skill call: a turn answering several people runs a write the persona holds a grant for', async () => {
  const run = await callTurn({
    answers: [toolAnswer('', [call('message.create', { place: '#νέα', text: 'γεια' })]), '<skip/>'],
    allowed: ['message.create'],
    turnExtra: {
      missed: [
        { author: 'Alice', text: 'γράψε στο #νέα' },
        { author: 'Zoë', text: 'κι εγώ' },
      ],
    },
  });
  // Who asked changes nothing, so several people asking refuses no write.
  assert.deepEqual(
    run.sends.map((send) => [send.to, send.text]),
    [['c9', 'γεια']],
    String(run.logs.filter((e) => e.msg === 'skills: called').map((e) => e.code))
  );
});

test('skill call: safe mode lets only the carried-over reply through', async () => {
  const safe = await callTurn({
    answers: [
      toolAnswer('<msg>γεια</msg>', [call('message.create', { place: '#νέα', text: 'γεια' })]),
      '<msg>μόνο εδώ</msg>',
    ],
    allowed: ['message.create'],
    tools: { safeMode: true },
  });
  assert.deepEqual(
    safe.sends.map((send) => send.to),
    ['c1'],
    'the post elsewhere was refused, the words here go out in the next answer'
  );
  assert.ok(safe.logs.some((entry) => entry.msg === 'skill: refused' && entry.code === 'safe-mode'));
  const safeLlm = safe.llm;
  const option = safeLlm.options[0];
  assert.deepEqual(
    option.tools.map((tool: Untyped) => tool.function.name),
    // PR 7d: features.speech is code, so voice.say is carried over beside the others.
    ['draw_create', 'message_create', 'message_react_add', 'voice_say'],
    'safe mode exposes the carried-over ones alone'
  );
});

test('skill call: draw.create elsewhere generates once and the operation posts it there; a post of unknown fate is unknown, never redone', async () => {
  const withFamily = <TImages extends object>(images: TImages) => Object.assign(images, { familyOf: () => 'fake' });
  const images = withFamily(fakeImages());
  const { journal, lines } = turnJournalOverMemory();
  const run = await callTurn({
    answers: [
      toolAnswer('', [call('draw.create', { people: [], place: '#νέα', text: 'a lighthouse at dusk' })]),
      '<msg>δεν ξέρω αν βγήκε</msg>',
    ],
    allowed: ['draw.create'],
    images,
    journal,
    failNext: ['send', { status: 'unknown', error: { code: 'timeout', retryable: false } }],
  });
  assert.equal(images.generateCalls.length, 1);
  assert.deepEqual(skillPhases(lines), ['proposed', 'started', 'unknown']);
  const runPort = run.port;
  assert.equal(runPort.calls.filter((call) => call.op === 'send').length, 2, 'the picture once, then the answer here');
  const labelsResult = labels.tools.result;
  assert.ok(followUpTool(run.llm, 1).startsWith(labelsResult.unknown.split(':')[0]), followUpTool(run.llm, 1));

  const delivered = await callTurn({
    answers: [toolAnswer('', [call('draw.create', { people: [], place: '#νέα', text: 'a lighthouse' })]), '<skip/>'],
    allowed: ['draw.create'],
    images: withFamily(fakeImages()),
  });
  assert.deepEqual(
    delivered.sends.map((send) => [send.to, send.attachments.length]),
    [['c9', 1]]
  );
  // A quiet call in a turn that answers someone is shown to the persona in one step.
  const deliveredLlm = delivered.llm;
  assert.equal(
    deliveredLlm.calls.length,
    2,
    'the picture came back to the persona in one step, where they stayed silent'
  );
});

test("skill call: a call that did not work comes back as a result with its reason, the persona's speech is held, the corrected call goes through and the journal keeps both", async () => {
  const { journal, lines } = turnJournalOverMemory();
  const run = await callTurn({
    // The live failure: a deletion announced, called without the message to delete.
    answers: [
      toolAnswer('<msg>σβήνω και το ξαναγράφω</msg>', [call('message.delete')]),
      toolAnswer('<msg>έσβησα το πρώτο</msg>', [call('message.delete', { message: '#1' })]),
      '<skip/>',
    ],
    allowed: ['message.delete'],
    journal,
  });
  assert.equal(run.result.outcome, 'spoke');
  // A quiet call in a turn that answers someone is shown to the persona in one step.
  const runLlm = run.llm;
  assert.equal(
    runLlm.calls.length,
    3,
    'the refusal came back, then the deletion that worked, where the persona stayed silent'
  );
  const transcript = labels.transcript;
  const reason = fill(transcript.callReasons['missing-arg'], { arg: 'message' });
  const tools = labels.tools;
  assert.equal(followUpTool(run.llm, 1), fill(tools.result.refused, { reason }), 'the persona reads what was missing');
  const runPort = run.port;
  assert.deepEqual(
    runPort.calls.filter((call) => call.op === 'delete').map((call) => asRecord(call.args[0]).messageId),
    ['m0'],
    'the corrected call ran'
  );
  assert.deepEqual(
    run.sends.map((send) => send.text),
    ['έσβησα το πρώτο'],
    'the announcement of the first answer was held, never posted'
  );
  assert.deepEqual(skillPhases(lines), ['proposed', 'failed', 'proposed', 'started', 'succeeded']);
  // The journal: the one turn record, the failure with its reason; the call's mark rebuilt from it covers the post.
  const records = lines.map(({ record }) => record);
  const turn = records.find((record) => record.kind === 'turn');
  assert.equal(turn.posted.length, 1);
  // The deletion that worked is shown to the persona in a second step.
  assert.equal(turn.steps, 2);
  const failed = actionsNamed(lines, 'skill')[1];
  assert.deepEqual(
    [failed.result.code, failed.result.status, failed.result.reason],
    ['invalid-args', 'invalid', 'args.message:required']
  );
  const marks = callMarksOf(records).calls;
  assert.deepEqual(
    marks.map((mark) => asRecord(mark).status),
    ['invalid', 'ok']
  );
});

test("skill call: the next request shows a read's data as its tool message, a message that came meanwhile as a numbered line in the note, the cached parts unchanged", async () => {
  const store = fakeStore({ loreEntries: [] });
  const meanwhile = kitRawMessage({
    id: 'm2',
    ts: KIT_NOW - 500,
    authorId: 'u2',
    authorName: 'Zoë',
    content: 'κι εγώ θέλω',
  });
  const run = await callTurn({
    answers: [toolAnswer('<msg>κοιτάζω</msg>', [call('lore.list')]), '<msg>τίποτα ακόμα</msg>'],
    allowed: ['lore.list'],
    store,
    later: [meanwhile],
  });
  const runLlm = run.llm;
  assert.equal(runLlm.calls.length, 2);
  // The prompt cache: the system prompt and the whole first user message are the previous request's, not rebuilt.
  const runCalls = run.llm.calls;
  assert.equal(runCalls[1][0], runCalls[0][0], 'the same system prompt');
  assert.equal(runCalls[1][1], runCalls[0][1], 'the same user message');
  assert.ok(
    !requestText(run.llm, 1).includes('κι εγώ θέλω'),
    'it came after the first request; the message itself is not rebuilt'
  );
  const [assistant, tool, note] = runCalls[1].slice(2);
  // Stage U: a reply with no think is handed on with an empty one.
  assert.equal(assistant.content, '<think></think><msg>κοιτάζω</msg>');
  const tools = labels.tools;
  assert.ok(contentOf(tool).startsWith(tools.result.ok), contentOf(tool));
  const noteText = contentOf(note);
  const labelsTask = labels.task;
  assert.ok(noteText.includes(labelsTask.step.held), noteText);
  assert.match(noteText, /#\d+ \[[^\]]*\] Zoë: κι εγώ θέλω/);
  assert.deepEqual(
    run.sends.map((send) => send.text),
    ['τίποτα ακόμα']
  );
});

const DRAW_NOW = Date.UTC(2026, 9, 6, 19, 30, 0);

type Appended = { post: Record<string, unknown>; opts: unknown };

function drawStore() {
  const appended: Array<Appended> = [];
  return {
    appended,
    getPlace: () => ({}),
    getUser: () => null,
    getPrivate: () => null,
    listChannels: () => [],
    listUserProfiles: () => [],
    getLore: () => [],
    liveRules: () => [],
    ...objectMediaCache({}),
    getDiary: () => ({ posts: [], updatedAt: 0 }),
    appendDiaryPost: (post: Record<string, unknown>, opts: unknown) => appended.push({ post, opts }),
    state: { data: {}, markDirty() {} },
  };
}

const images = {
  quota: () => ({ used: 0, cap: 10, userUsed: 0, userCap: 5, spent: false, userSpent: false }),
  generate: () => Promise.resolve({ buffer: Buffer.from('png'), mediaType: 'image/png', seconds: 1, cost: 0 }),
};

/** A model that answers the director with a scene and every request of the persona with `answer`. */
function fakeLlm(answer: unknown) {
  return {
    complete: (messages: unknown, opts: { purpose?: string }) =>
      Promise.resolve(directorAnswer(messages, opts) ?? completionOf(answer)),
  };
}

const hot = {
  config: {
    // The persona's own grant of the picture, so a call aimed elsewhere passes their access and meets the rule on who asked.
    bot: { timezone: 'Europe/Athens', access: { 'draw.create': { users: ['self-id'] } } },
    context: {
      channelMessages: 50,
      caps: { interlocutor: 2500, aboutChat: 2500, people: 4000, neighbors: 3000 },
      vision: { fetchTimeoutMs: 10_000 },
      pull: { sameAudience: true },
    },
    llm: { maxRequestTokens: 50000 },
    typing: { reactionDelayMs: [0, 0], msPerChar: [0, 0], minMs: 0, maxMs: 0, betweenMessagesMs: [0, 0] },
    image: {},
    diary: { placeId: 'd1', world: false },
  },
  prompts: {
    main: 'SYSTEM for {{name}}',
    persona: 'CARD_TEXT',
    format: 'FORMAT_TEXT',
    'diary/task': 'DIARY_TASK for {{name}}',
    'diary/scene': 'SCENE_TASK',
    'diary/seeds/place': 'a pier',
    'diary/seeds/setting': 'fog',
    draw: 'DRAW for {{name}}\n{{when}}\n{{request}}',
    labels,
  },
};

/** The `skills: called` lines of a run, as `skill:status/code`. */
const calledOf = (logs: Array<LogEntry>) =>
  logs
    .filter((entry) => entry.msg === 'skills: called')
    .map((entry) => `${String(entry.skill)}:${String(entry.status)}${entry.code ? `/${String(entry.code)}` : ''}`);

// The cases below run on the fake interface; the cases above it run on the Discord-shaped world.
describe('on the fake interface', () => {
  before(() => {
    useIface('fake');
  });

  after(() => {
    useIface('discord');
  });

  test('a diary draw.create that names another place is staged for the entry and posted nowhere', async () => {
    // Bug: the named place made the call one aimed elsewhere, so a turn nobody asked for refused it.
    const channel = world().channel({ id: 'd1', name: 'journal', placeId: 'g1', permissions: { attach: true } });
    const other = world().channel({ id: 'c2', name: 'elsewhere', placeId: 'g1', permissions: { attach: true } });
    const store = drawStore();
    const llm = fakeLlm(
      toolAnswer('<msg>un quai</msg>', [
        call('draw.create', { people: [], text: 'a pier at night', place: '#elsewhere' }),
      ])
    );
    const runner = worldTurnRunner({
      hot,
      store,
      llm,
      calibrator: { ratio: 1, apply: (n: number) => n, observe: () => {} },
      images,
      lookup: null,
      rng: () => 0.5,
      now: () => DRAW_NOW,
    });
    const { logs } = await withCapturedLogs(() =>
      runner.runTurn({ channel, mode: 'diary', diary: { kind: 'selfPicture', forced: false } })
    );
    assert.deepEqual(calledOf(logs), ['draw.create:ok/staged']);
    const [entry] = store.appended;
    assert.equal(entry?.post.picture, 'a pier at night', 'the entry keeps the picture');
    assert.deepEqual(other.sent, [], 'nothing goes to the named place');
  });
});

const THINK = '<think>STEP 4. So: nothing.</think>';

// The cases below run on the fake interface; the cases above it run on the Discord-shaped world.
describe('on the fake interface', () => {
  before(() => {
    useIface('fake');
  });

  after(() => {
    useIface('discord');
  });

  test('a tool that takes a place is refused in a heartbeat with no chat when the persona names none', async () => {
    // Bug: the call falls back to a chat the turn does not have and reads a room nobody named.
    const run = await serviceTurn({
      wake: serviceWake('heartbeat'),
      answers: [toolAnswer(THINK, [call('conversation.read', {})]), '<skip/>'],
      chat: null,
    });
    const [action = ''] = run.actions;
    const [skill, status, code] = action.split(':');
    assert.equal(skill, 'conversation.read');
    assert.notEqual(status, 'executed', action);
    assert.ok(code !== undefined && code !== '' && code !== 'ok', action);
  });

  test('a <msg> in a heartbeat carries heartbeat-only', async () => {
    // Bug: a message with no destination goes to a stand-in or to the room the wake rode on.
    // Changed: the expectation was destination-required. The heartbeat's own limit answers before a tag's refusal, so a
    // <msg> of a heartbeat is refused as any post of a heartbeat is, and its refusal wakes no feedback turn that could
    // post it. The bug above stays caught: nothing is sent.
    const run = await serviceTurn({
      wake: serviceWake('heartbeat'),
      answers: [`${THINK}<msg>γεια σας</msg>`, '<skip/>'],
      chat: null,
    });
    const post = run.actions.find((action) => action.startsWith('message.create:')) ?? '';
    assert.equal(post.split(':')[2], 'heartbeat-only', post);
    const { port } = run;
    assert.equal(port.calls.filter((one: { op: string }) => one.op === 'send').length, 0);
  });
});

// A voice message the persona sends through `voice.say` leaves a said line whose voice item keeps what they voiced
// (src/turn/skill-calls.ts, src/turn/journal-notes.ts#recordSaid), so memory can answer what they said in it. Fake model, fake
// operation; the line as `record.append` receives it.

const VOICED = '[sighs] "собор на закате"';

type SaidLine = {
  kind?: unknown;
  messageId?: unknown;
  text?: unknown;
  media?: unknown;
  voiced?: unknown;
  marks?: unknown;
};

async function voiceTurn(outcome: unknown) {
  const appended: Array<SaidLine> = [];
  await coreTurn({
    answers: [toolAnswer('', [call('voice.say', { text: 'ignored' })]), toolAnswer('')],
    allowed: ['voice.say'],
    runner: {
      runOwnOp: () => Promise.resolve(outcome),
      record: {
        append: (_place: string, lines: Array<SaidLine>) => {
          appended.push(...lines);
          return Promise.resolve({ written: lines.length, duplicates: 0 });
        },
      },
    },
  });
  return appended.filter((line) => line.kind === 'said');
}

// A destructive call holds the cooldown of its skill in its chat (`destructiveRuns` of src/turn/skill-calls.ts, checked
// by src/tools/gateway.ts#cooldownRefusal) only when its operation answered `ok`. Every other result, a timeout and a
// thrown error leave the cooldown as it was. The persona's turns over one runner on an injected clock, each one step of
// `message.delete` calls on their own line, then a skip; fake operations answer.

const COOLDOWN_MINUTES = 10;

const MINUTE_MS = 60_000;

const PERSONA_LINE = rawMessage({
  id: 's1',
  authorId: 'self-id',
  authorName: 'Bot',
  ts: NOW - 9000,
  content: 'a typo here',
});

const DELETED = { status: 'ok', code: 'ok', summary: 'message deleted' };

const NOT_FOUND = { status: 'failed', code: 'http-404', summary: 'no such message' };

const HALF_DONE = { status: 'partial', code: 'partial', summary: 'one of two removed' };

/** What the fake operation does for one `message.delete`: answers this, never answers, or throws. */
type DeleteAnswer = object | 'never' | 'throw';

/** One turn of the persona's: the clock while it runs and how many deletions its first step asks for. */
type DeleteTurn = { at: number; calls?: number };

const deletions = (count: number) =>
  toolAnswer(
    '',
    Array.from({ length: count }, () => call('message.delete', { message: 's1' }))
  );

/** The codes of the refusals of `message.delete` among `logs`, in order. */
const refusalCodes = (logs: Array<LogEntry>): Array<string> =>
  logs
    .filter((entry) => entry.msg === 'skill: refused' && entry.skill === 'message.delete')
    .map((entry) => String(entry.code));

/** Runs `turns` over one runner; `answers` answer the operations in order. How many ran, the refusals of each turn. */
async function deleteTurns(
  turns: Array<DeleteTurn>,
  answers: Array<DeleteAnswer>,
  { callTimeoutMs = 120_000 }: { callTimeoutMs?: number } = {}
) {
  let ran = 0;
  const clock = { t: turns[0].at };
  const runOwnOp = (op: string): Promise<unknown> => {
    if (op !== 'message.delete') return Promise.resolve(DELETED);
    const answer = answers[ran];
    ran += 1;
    if (answer === 'never') return new Promise(() => {});
    if (answer === 'throw') return Promise.reject(new Error('socket closed'));
    return Promise.resolve(answer);
  };
  const run = await coreTurn({
    answers: turns.flatMap((turn) => [deletions(turn.calls ?? 1), '<skip/>']),
    allowed: ['message.delete'],
    earlier: [PERSONA_LINE],
    withHot(hot) {
      const { tools } = hot.config;
      tools.destructiveCooldownMinutes = COOLDOWN_MINUTES;
      tools.callTimeoutMs = callTimeoutMs;
    },
    runner: { now: () => clock.t, runOwnOp },
  });
  const refusals = [refusalCodes(run.logs)];
  for (const turn of turns.slice(1)) {
    clock.t = turn.at;
    const { logs } = await withCapturedLogs(() => run.again());
    refusals.push(refusalCodes(logs));
  }
  return { ran: () => ran, refusals, llm: run.llm };
}

/** Whether the first tool result of request `i` begins as the label of `status` does. */
function firstResultIs(llm: FakeLlm, i: number, status: 'ok' | 'failed' | 'unknown'): boolean {
  const words = labels.tools.result;
  const [prefix] = words[status].split('{reason}');
  const line = toolResults(llm, i)[0] ?? '';
  return line.slice(line.indexOf(': ') + 2).startsWith(prefix);
}

const LONG_EXTRACT = 'Η παράδοση του κήπου λέει πως οι λεμονιές φυτεύτηκαν πριν από έναν αιώνα. '.repeat(30).trim();

/** A reply turn whose one `lore.list` call reads `LONG_EXTRACT`, with `summarize` wired; the extract its closing line keeps. */
async function keptExtract(summarize: (text: string, options: { maxChars: number; kind: 'text' }) => Promise<string>) {
  const { journal, lines } = journalOverMemory();
  await coreTurn({
    answers: [toolAnswer('<think>x</think>', [call('lore.list')]), '<skip/>'],
    journal,
    runner: { summarize },
    wrapCommand: () => () => Promise.resolve({ status: 'ok', code: 'ok', summary: LONG_EXTRACT }),
  });
  return lines.map(({ record }) => extractOf(record)).find((extract) => extract !== undefined);
}

/** The extract of the lookup a closing line keeps, or undefined for any other line. */
function extractOf(record: unknown): string | undefined {
  if (!record || typeof record !== 'object' || !('result' in record)) return undefined;
  const { result } = record;
  if (!result || typeof result !== 'object' || !('lookup' in result)) return undefined;
  const { lookup } = result;
  if (!lookup || typeof lookup !== 'object' || !('extract' in lookup)) return undefined;
  return typeof lookup.extract === 'string' ? lookup.extract : undefined;
}

// The cases below run on the fake interface; the cases above it run on the Discord-shaped world.
describe('on the fake interface', () => {
  before(() => {
    useIface('fake');
  });

  after(() => {
    useIface('discord');
  });

  test('a message.create the interface kept for a closed chat is ok, and its result says it is shown when the chat opens', async () => {
    // Bug: the persona reads a plain success and believes the user saw the message, though no chat was open to show it.
    const run = await coreTurn({
      answers: [toolAnswer('<think>x</think>', [call('message.create', { text: 'good night' })]), '<skip/>'],
      allowed: ['message.create'],
      setup(port) {
        const send = port.send.bind(port);
        port.send = async (...args: Parameters<typeof send>) => ({ ...(await send(...args)), deferred: true });
      },
    });
    const [first] = run.sends;
    assert.equal(first?.text, 'good night');
    const result = contentText(appended(run.llm, 1).find((message) => message.role === 'tool')?.content);
    const { result: words } = labels.tools;
    assert.ok(result.startsWith(words.ok), 'the call is ok');
    assert.ok(result.includes(words.storedUntilOpen), 'the result says the post waits for the chat');
  });

  test('a sent voice message is one said line, its words empty and its voiced text kept', async () => {
    const said = await voiceTurn({
      status: 'ok',
      code: 'ok',
      summary: 'voice message posted',
      data: {
        text: 'voice message posted',
        ref: { chatId: 'c1', messageId: 'voice-1' },
        voice: { text: VOICED, durationSecs: 2.5 },
      },
    });
    assert.equal(said.length, 1);
    assert.equal(said[0].messageId, 'voice-1');
    assert.equal(said[0].text, '');
    assert.deepEqual(said[0].media, ['voice']);
    assert.equal(said[0].voiced, VOICED);
  });

  test('a sent voice message is marked as made by the persona, with their own person in it', async () => {
    // Bug: the clip the persona spoke reaches memory with no mark and reads later as anybody's voice clip.
    const said = await voiceTurn({
      status: 'ok',
      code: 'ok',
      summary: 'voice message posted',
      data: {
        text: 'voice message posted',
        ref: { chatId: 'c1', messageId: 'voice-1' },
        voice: { text: VOICED, durationSecs: 2.5 },
      },
    });
    assert.deepEqual(said[0]?.marks, { self: true, accounts: [] });
  });

  test('a voice message that failed leaves no said line', async () => {
    const said = await voiceTurn({ status: 'failed', code: 'speech-not-configured', summary: 'no' });
    assert.deepEqual(said, []);
  });

  test('a destructive call that failed holds no cooldown: the corrected call four seconds later runs', async () => {
    // Bug: a message.delete that came back failed (http-404) refused the corrected call with cooldown, and nothing was deleted.
    const { ran, refusals, llm } = await deleteTurns([{ at: NOW }, { at: NOW + 4000 }], [NOT_FOUND, DELETED]);
    assert.equal(firstResultIs(llm, 1, 'failed'), true, 'the first call failed');
    assert.deepEqual(refusals, [[], []]);
    assert.equal(ran(), 2);
  });

  test('a destructive call that answered ok refuses the next one of its skill from its chat with cooldown', async () => {
    // Bug: a call that did delete took no cooldown, so a second deletion followed at once.
    const { ran, refusals } = await deleteTurns([{ at: NOW }, { at: NOW + 4000 }], [DELETED, DELETED]);
    assert.deepEqual(refusals, [[], ['cooldown']]);
    assert.equal(ran(), 1);
  });

  test('a destructive call that timed out holds no cooldown: the next call runs', async () => {
    // Bug: a call that timed out (unknown) took the cooldown, though the cooldown counts a full success only.
    const { ran, refusals, llm } = await deleteTurns([{ at: NOW }, { at: NOW + 4000 }], ['never', DELETED], {
      callTimeoutMs: 20,
    });
    assert.equal(firstResultIs(llm, 1, 'unknown'), true, 'the first call timed out');
    assert.deepEqual(refusals, [[], []]);
    assert.equal(ran(), 2);
  });

  test('a destructive call whose operation threw holds no cooldown: the next call runs', async () => {
    // Bug: a failed result that holds a thrown error took the cooldown, though nothing reported a success.
    const { ran, refusals, llm } = await deleteTurns([{ at: NOW }, { at: NOW + 4000 }], ['throw', DELETED]);
    assert.equal(firstResultIs(llm, 1, 'failed'), true, 'the first call failed');
    assert.deepEqual(refusals, [[], []]);
    assert.equal(ran(), 2);
  });

  test('a destructive call that answered partial holds no cooldown: the next call runs', async () => {
    // Bug: a partial result counted as a success and refused the call that finishes the job.
    const { ran, refusals } = await deleteTurns([{ at: NOW }, { at: NOW + 4000 }], [HALF_DONE, DELETED]);
    assert.deepEqual(refusals, [[], []]);
    assert.equal(ran(), 2);
  });

  test('a call the cooldown refused moves nothing: the next one runs once the cooldown of the first call is over', async () => {
    // Bug: the call the cooldown refused wrote its own time and stretched the cooldown past the first call's.
    const { ran, refusals } = await deleteTurns(
      [{ at: NOW }, { at: NOW + MINUTE_MS }, { at: NOW + COOLDOWN_MINUTES * MINUTE_MS }],
      [DELETED, DELETED]
    );
    assert.deepEqual(refusals, [[], ['cooldown'], []]);
    assert.equal(ran(), 2);
  });

  test('a failed call after an earlier cooldown ran out leaves that cooldown over, so the next call runs at once', async () => {
    // Bug: the failed call kept its own time as the last run and refused the corrected call made right after it.
    const later = NOW + COOLDOWN_MINUTES * MINUTE_MS;
    const { ran, refusals } = await deleteTurns(
      [{ at: NOW }, { at: later }, { at: later }],
      [DELETED, NOT_FOUND, DELETED]
    );
    assert.deepEqual(refusals, [[], [], []]);
    assert.equal(ran(), 3);
  });

  test('two deletions in one step, the first ok: the second is refused with cooldown', async () => {
    // Bug: the time of a successful call was written too late for the next call of the same step to see it.
    const { ran, refusals } = await deleteTurns([{ at: NOW, calls: 2 }], [DELETED, DELETED]);
    assert.deepEqual(refusals, [['cooldown']]);
    assert.equal(ran(), 1);
  });

  test('two deletions in one step, the first failed: the second runs', async () => {
    // Bug: a failed call took the cooldown at dispatch and refused the corrected call of the same step.
    const { ran, refusals, llm } = await deleteTurns([{ at: NOW, calls: 2 }], [NOT_FOUND, DELETED]);
    assert.equal(firstResultIs(llm, 1, 'failed'), true, 'the first call failed');
    assert.deepEqual(refusals, [[]]);
    assert.equal(ran(), 2);
  });

  // No text the persona reads is cut silently.
  test('a lookup whose extract runs past extractChars goes to summarize once and keeps its answer', async () => {
    const calls: Array<{ maxChars: number; kind: 'text' }> = [];
    const extract = await keptExtract((_text, options) => {
      calls.push(options);
      return Promise.resolve('Οι λεμονιές του κήπου είναι εκατό χρονών.');
    });
    assert.deepEqual(calls, [{ maxChars: 1200, kind: 'text' }]);
    assert.equal(extract, 'Οι λεμονιές του κήπου είναι εκατό χρονών.');
  });

  // No text the persona reads is cut silently.
  test('a lookup whose extract is summarized still over extractChars keeps that summary whole', async () => {
    const still = `${LONG_EXTRACT} Και κάτι ακόμη.`;
    const extract = await keptExtract(() => Promise.resolve(still));
    assert.equal(extract, still);
  });
});

const BODY = 'Search first, then read the best hit and say where it came from.';

/** A rig with one active skill, `look-it-up`, which needs `web.search`. */
function withSkill(t: { after: (fn: () => void) => void }): SkillsRig {
  const rig = skillsRig(t);
  rig.writeLocal('look-it-up', skillText('look-it-up', 'I check the web first', ['web.search'], BODY));
  rig.port.activate('look-it-up', 'agent:hand');
  return rig;
}

/** The text of the last tool message of a request, '' with none. */
function lastToolResult(request: SkillTurn['requests'][number] | undefined): string {
  const message = [...(request ?? [])].reverse().find((one) => one.role === 'tool');
  return typeof message?.content === 'string' ? message.content : '';
}

test('a call of a skill answers its text, and a second call in the same turn answers the same without a read', async (t) => {
  // Bug: every call reads the skill anew, so a version activated mid-turn changes the procedure the persona is following.
  const rig = withSkill(t);
  const run = await skillTurn({
    kind: 'discord-reply',
    answers: [toolAnswer('', [call('look-it-up')]), toolAnswer('', [call('look-it-up')]), 'done'],
    skills: rig.port,
  });
  assert.ok(lastToolResult(run.requests[1]).includes(BODY), 'the first call answers the text');
  assert.ok(lastToolResult(run.requests[2]).includes(BODY), 'the second call answers the same text');
  assert.deepEqual(run.readsAt.slice(1, 3), [1, 1]);
});
