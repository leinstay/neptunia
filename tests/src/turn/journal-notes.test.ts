// src/turn/journal-notes.ts: the thinks a new turn carries from the earlier turns of its chat (`earlierThinkFor`). A
// think of a turn that ran in a direct chat and posted into a group is carried into that group's next turn only with
// `context.memory.openPrivate` on. A real think store, no journal, no record.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createThinkStore, placeKey } from '../../../src/behavior/previous-think.ts';
import { createJournalNotes } from '../../../src/turn/journal-notes.ts';
import { rmSync } from 'node:fs';
import { createDiscordInterface } from '../../../interfaces/discord/index.ts';
import { createFakeAdapter } from '../../../scripts/lib/fake.ts';
import { createAdmin } from '../../../src/admin.ts';
import { userText as textOf } from '../../../src/behavior/prompt.ts';
import { fill } from '../../../src/format.ts';
import type { JournalLinesWrite } from '../../../src/memory/db/journal-lines.ts';
import { callMarksOf, createJournal } from '../../../src/memory/journal.ts';
import '../../../src/tools/operations/index.ts';
import { skillRegistry } from '../../../src/tools/registry.ts';
import type { Untyped } from '../../../src/tools/types.ts';
import { withCapturedLogs } from '../../fixtures/capture-logs.ts';
import { labels } from '../../fixtures/labels.ts';
import { journalLineLabel, openTestMemorySync } from '../../fixtures/memory-db/service.ts';
import { ownedBy, OWNER_PERSON } from '../../fixtures/owner-accounts.ts';
import { asRecord } from '../../fixtures/records.ts';
import { replyRun, type ReplyStep, serviceWorld, TURN_NOW } from '../../fixtures/service-turn.ts';
import { shippedLabels } from '../../fixtures/shipped-labels.ts';
import { call, toolAnswer } from '../../fixtures/tool-answers.ts';
import {
  fakeClient,
  fakeHot,
  fakeStore,
  fakeTurnChannel,
  identityCalibrator,
  normalizedTrigger,
  rawMessage,
  NOW as TURN_TURN_NOW,
} from '../../fixtures/turn-kit.ts';
import { createTurnRunner } from '../../fixtures/turn-runner.ts';
import { useIface, world } from '../../fixtures/turn-world.ts';

const NOW = Date.UTC(2026, 10, 18, 12, 0, 0);
const GROUP = { id: 'c1', rootId: 'g1' };

/** The journal notes over `thinks` and `record`, with the setting `open`. */
function notesOf(open: boolean, thinks = createThinkStore(), record: unknown = null) {
  return createJournalNotes({
    hot: { config: { context: { previousThinks: 1, memory: { openPrivate: open } } } },
    clock: () => NOW,
    journal: null,
    record: record as never,
    iface: 'fake',
    facts: () => {
      throw new Error('no facts are read here');
    },
    triggerLinks: new Map(),
    callMarks: [],
    postedFromLinks: new Map(),
    thinks,
    readOffPeriods: () => Promise.resolve([]),
    liveChannelName: () => () => null,
    newId: () => 'line-1',
  });
}

/** The think the group's next turn carries, with the setting `open`. */
function carriedInGroup(open: boolean): string | null {
  const thinks = createThinkStore();
  thinks.record({
    turnId: 't1',
    at: NOW - 60_000,
    think: 'ΣΚΕΨΗ-ΑΠΟ-ΙΔΙΩΤΙΚΗ',
    isDm: true,
    ran: placeKey({ chatId: 'd1' }),
    delivered: [placeKey({ chatId: GROUP.id })],
  });
  const notes = notesOf(open, thinks);
  return notes.earlierThinkFor({ channel: GROUP, isDm: false, draft: {}, mode: 'reply' })?.text ?? null;
}

test('a think of a direct chat posted into a group is carried there only with context.memory.openPrivate on', () => {
  // Bug: the switch that opens the persona's memory leaves their own thoughts from a direct chat behind in every group.
  assert.equal(carriedInGroup(false), null);
  assert.equal(carriedInGroup(true), 'ΣΚΕΨΗ-ΑΠΟ-ΙΔΙΩΤΙΚΗ');
});

test("a line the persona says in a group after reading a direct chat is stored as the group's with context.memory.openPrivate on", () => {
  // Bug: the switch that opens the persona's reads reaches the write, and their group line is filed under a direct
  // chat.
  const appended: Array<{ placeId: string; lines: Array<{ scope?: { private?: boolean } }> }> = [];
  const record = { append: (placeId: string, lines: never) => appended.push({ placeId, lines }) };
  notesOf(true, createThinkStore(), record).recordSaid({
    placeId: 'g1',
    channel: GROUP,
    dmChat: false,
    draft: { privateAccountId: null, memoryContext: { kind: 'group', open: true } } as never,
    posted: { id: 'm1', createdTimestamp: NOW },
    text: 'ΓΡΑΜΜΗ',
    accountIds: [],
  });
  assert.deepEqual(
    appended.map(({ placeId, lines: [line] }) => [placeId, line?.scope?.private === true]),
    [['g1', false]]
  );
});

test('a line the persona says takes its id from the runner, so a replay that counts its ids stores the same line twice', () => {
  // Bug: the record line draws a random id of its own, and two replays of one turn keep different lines.
  const appended: Array<{ id?: string }> = [];
  const record = { append: (_placeId: string, lines: Array<{ id?: string }>) => appended.push(...lines) };
  notesOf(false, createThinkStore(), record).recordSaid({
    placeId: 'g1',
    channel: GROUP,
    dmChat: false,
    draft: { privateAccountId: null },
    posted: { id: 'm2', createdTimestamp: NOW },
    text: 'ΓΡΑΜΜΗ',
    accountIds: [],
  });
  assert.deepEqual(
    appended.map((line) => line.id),
    ['line-1']
  );
});

const MIN = 60_000;

const HOUR = 60 * MIN;

const SAY = '<think>STEP 4. So: answer.</think><msg>γεια</msg>';

const iso = (at: number): string => new Date(at).toISOString();

const turn = (id: string, ago: number): ReplyStep => ({
  trigger: { id, text: 'καλημέρα', at: TURN_NOW - ago * MIN },
  answers: [SAY],
});

const bodyOf = (request: string, tag: string): string =>
  new RegExp(`<${tag}>\\n([\\s\\S]*?)\\n</${tag}>`).exec(request)?.[1] ?? '';

/** A label of `labels.journal` by its key, read at the moment of use so a missing one fails its own test. */
function offLead(): string {
  const lead: unknown = shippedLabels.journal?.offLead;
  if (typeof lead !== 'string' || lead === '') throw new Error('labels.journal.offLead is missing');
  return lead;
}

/** The request of one reply turn after a stop at `stopAgo` minutes before the turn that lasted `lastedMs`. */
async function requestAfterStop(stopAgo: number, lastedMs: number, minMinutes: number): Promise<string> {
  const world = serviceWorld();
  try {
    const stopAt = TURN_NOW - stopAgo * MIN;
    const run = await replyRun({
      world,
      context: { away: { minMinutes } },
      steps: [
        {
          ...turn('r2', 1),
          journalBefore: async (journal) => {
            await journal.system({ event: 'stop', by: 'service', occurredAt: iso(stopAt) });
            await journal.system({ event: 'start', by: 'service', occurredAt: iso(stopAt + lastedMs) });
          },
        },
      ],
    });
    const [first = []] = run.requests;
    return first[0] ?? '';
  } finally {
    world.close();
  }
}

describe('the tail lines of a reply turn', () => {
  before(() => useIface('fake'));
  after(() => useIface('discord'));

  test('a restart of 20 seconds leaves no lead line of the time the persona was away in the request', async () => {
    // Bug: every deploy restart of the day lists as `Off, ... (less than a minute)`, so the persona reads a normal day as one
    // of absences.
    const request = await requestAfterStop(40, 20_000, 5);
    assert.ok(request.includes('<spatial_awareness>'), 'the request has the awareness block');
    assert.ok(!request.includes(offLead()), bodyOf(request, 'spatial_awareness'));
  });

  test('a stop of an hour keeps the lead line of the time the persona was away in the request', async () => {
    // Bug: the cut reads the setting in the wrong unit, or drops every period, so a real absence never reaches the persona.
    const request = await requestAfterStop(180, HOUR, 5);
    assert.ok(request.includes(offLead()), bodyOf(request, 'spatial_awareness'));
  });

  test('with the setting at 0 a restart of 20 seconds keeps the lead line', async () => {
    // Bug: the cut is a number in the reader and not the setting read at the moment of use, so 0 cannot turn it off.
    const request = await requestAfterStop(40, 20_000, 0);
    assert.ok(request.includes(offLead()), bodyOf(request, 'spatial_awareness'));
  });
});

/** The test memory databases opened here; closed when the file is done. */
const OPENED_MEMORY: Array<{ close: () => Promise<void> }> = [];

after(async () => {
  for (const mem of OPENED_MEMORY) await mem.close();
});

// The Discord interface's capabilities object, as src/index.ts injects it.
const DISCORD = createDiscordInterface().capabilities;

const DRAW_FOLDERS: Array<string> = [];

after(() => {
  for (const folder of DRAW_FOLDERS.splice(0)) rmSync(folder, { recursive: true, force: true });
});

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

/** A real journal over a test memory database whose writes also keep every line in memory. */
function journalOverMemory() {
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
    now: () => TURN_TURN_NOW,
    uuid: () => `u${(n += 1)}`,
  });
  return { journal, lines };
}

/** `bot.access` granting each of `names` to the persona (the fake client's user, `self-id`). */
function personaGrants(names: Untyped) {
  return Object.fromEntries(names.map((name: Untyped) => [name, { everyone: false, roles: [], users: ['self-id'] }]));
}

// ---------------------------------------------------------------------------
// Call marks (src/format.ts#withCalls): a later turn's transcript shows the skill calls
// the persona made on their lines of the turn that made them, in the channel where they made them.

/**
 * callTurn's scene on one runner kept across turns: #general (c1) with Alice's mention, #💖νέα
 * (c9); the clock settable; `run(channel, raw)` runs one mention turn; `runner()` a fresh runner
 * on the same port, as after a restart.
 */
function callMarkScene({
  answers,
  allowed = ['message.create'],
  features = {},
  journal = null,
}: Record<string, Untyped>) {
  const history = [
    rawMessage({ id: 'm0', ts: TURN_TURN_NOW - 5000, authorId: 'self-id', authorName: 'Bot', content: 'πρώτη' }),
    rawMessage({ id: 'm1', ts: TURN_TURN_NOW - 1000, authorId: 'u1', authorName: 'Alice', content: 'γράψε στο #νέα' }),
  ];
  const channel = fakeTurnChannel({ historyMessages: history });
  const news = fakeTurnChannel({ id: 'c9', name: '💖νέα', historyMessages: [] });
  const port = createFakeAdapter({ iface: 'fake', selfId: 'self-id', now: () => TURN_TURN_NOW });
  const hot = fakeHot(
    { typingSimulation: false, journal: Boolean(journal), ...features },
    { ownerPerson: OWNER_PERSON, access: personaGrants(allowed) },
    { tools: { safeMode: false, resultMaxChars: 2000 } }
  );
  const store = fakeStore();
  const client = fakeClient();
  const admin = createAdmin({
    discord: DISCORD,
    hot,
    store,
    client,
    isServedRoot: (id: unknown) => id === 'g1',
    reads: world().adopt(port),
    port,
  });
  const llm = sequenceLlm(answers);
  const clock = { ms: TURN_TURN_NOW };
  const runner = () =>
    createTurnRunner({
      discord: DISCORD,
      hot,
      store,
      llm,
      calibrator: identityCalibrator(),
      client,
      now: () => clock.ms,
      port,
      skills: skillRegistry(),
      journal,
      runOp: admin.runSkillOp,
      runOwnOp: admin.runOwnSkillOp,
    });
  const turns = runner();
  const run = (where: unknown, raw: Untyped, on = turns) =>
    withCapturedLogs(() =>
      on.runTurn({ channel: where, mode: 'reply', trigger: normalizedTrigger(raw), triggerKind: 'mention' })
    );
  return { history, channel, news, port, llm, clock, turns, runner, run };
}

/** The persona's own line of `c` as the fake port holds it, as a raw message of that channel. */
function ownRaw(port: Untyped, placeId: string, ts: number) {
  const [message] = port
    .messagesIn(placeId)
    .filter((m: Untyped) => m.authorId === 'self-id' && !['m0'].includes(m.ref.messageId));
  return {
    ...rawMessage({ id: message.ref.messageId, ts, authorId: 'self-id', authorName: 'Bot', content: message.text }),
    placeId,
  };
}

/** The `<chat>` block of the LLM's last request. */
function lastChat(llm: Untyped) {
  const text = textOf(llm.calls.at(-1)[1].content);
  return text.slice(text.indexOf('<chat>'), text.indexOf('</chat>'));
}

// The owner of these configs: `bot.ownerPerson` and the accounts bound to it (tests/fixtures/owner-accounts.ts).
ownedBy(['u1']);

describe('a whole turn', () => {
  test('call marks: a later turn shows the call as a line of its own after the line of the persona in the turn that made it; the post there names where it came from', async () => {
    const scene = callMarkScene({
      answers: [
        toolAnswer('<msg reply="#2">εντάξει</msg>\n', [call('message.create', { place: '#🍡νέα', text: 'καλημέρα' })]),
        '<skip/>',
      ],
    });
    const first = await scene.run(scene.channel, scene.history[1]);
    assert.equal(first.result.outcome, 'spoke');
    const sceneCalls = scene.port.calls;
    const [posted] = sceneCalls.filter((call) => call.op === 'send');
    assert.equal(asRecord(posted.args[0]).chatId, 'c9', 'the call of the persona ran first');
    const here = ownRaw(scene.port, 'c1', TURN_TURN_NOW);
    const there = ownRaw(scene.port, 'c9', TURN_TURN_NOW);
    scene.clock.ms = TURN_TURN_NOW + 60_000;
    const m2 = rawMessage({ id: 'm2', ts: TURN_TURN_NOW + 30_000, authorName: 'Alice', content: 'και;' });
    scene.history.push(here, m2);
    await scene.run(scene.channel, m2);
    const chat = lastChat(scene.llm);
    const chatLines = chat.split('\n');
    const mark = chatLines[chatLines.findIndex((text) => text.includes('εντάξει')) + 1];
    // Slice 2 (a), (c): the mark is a line of its own after the persona's line, says where the persona called from, and has no posted link.
    assert.equal(mark, '[12:00] Bot (you): [called message.create from #general: done]', chat);
    assert.equal(chat.match(/\[called /g)?.length, 1, chat);

    // In #💖νέα the persona's post says which channel's turn posted it; the call itself is not shown there.
    const n1 = {
      ...rawMessage({ id: 'n1', ts: TURN_TURN_NOW + 30_000, authorName: 'Alice', content: 'γεια' }),
      placeId: 'c9',
    };
    world().seed('c9', [there, n1]);
    await scene.run(scene.news, n1);
    const newsChat = lastChat(scene.llm);
    assert.ok(
      newsChat.includes('Bot (you) (posted from #general) (turn triggered by an older message): καλημέρα'),
      newsChat
    );
    assert.ok(!newsChat.includes('[called '), newsChat);
  });

  test('call marks: a turn that only called shows the call as a line of the persona at its time, after the last line before it', async () => {
    const scene = callMarkScene({
      answers: [toolAnswer('', [call('message.create', { place: '#🍡νέα', text: 'γεια' })]), '<skip/>'],
    });
    await scene.run(scene.channel, scene.history[1]);
    // Slice 2 (c): the mark carries no posted link, so the persona's post in #νέα is checked here instead of read for its id.
    assert.ok(ownRaw(scene.port, 'c9', TURN_TURN_NOW).id, 'the call of the persona posted in #νέα');
    scene.clock.ms = TURN_TURN_NOW + 60_000;
    const m2 = rawMessage({ id: 'm2', ts: TURN_TURN_NOW + 30_000, authorName: 'Alice', content: 'και;' });
    scene.history.push(m2);
    await scene.run(scene.channel, m2);
    const chat = lastChat(scene.llm);
    // Slice 2 (c): the mark says where the persona called from and carries no target channel and no posted link.
    const standalone = '[12:00] Bot (you): [called message.create from #general: done]';
    const lines = chat.split('\n');
    const at = lines.indexOf(standalone);
    assert.ok(at > 0, chat);
    assert.ok(lines[at - 1].includes('γράψε στο #νέα'), 'right after the last line before the call');
    assert.ok(lines[at + 1].includes('και;'));
  });

  test('call marks: a refused call shows its status and why on its own line after the line its turn posted', async () => {
    const scene = callMarkScene({
      answers: [
        toolAnswer('<msg>μια στιγμή</msg>', [call('message.create', { place: '#🍡νέα', text: 'γεια' })]),
        '<msg>μια στιγμή</msg>',
      ],
      allowed: [],
    });
    await scene.run(scene.channel, scene.history[1]);
    scene.history.push(ownRaw(scene.port, 'c1', TURN_TURN_NOW));
    scene.clock.ms = TURN_TURN_NOW + 60_000;
    const m2 = rawMessage({ id: 'm2', ts: TURN_TURN_NOW + 30_000, authorName: 'Alice', content: 'και;' });
    scene.history.push(m2);
    await scene.run(scene.channel, m2);
    const chatLines = lastChat(scene.llm).split('\n');
    const line = chatLines[chatLines.findIndex((text) => text.includes('μια στιγμή')) + 1];
    const callStatusLabels = labels.transcript.callStatus;
    const resultLabels = labels.tools.result;
    const status = fill(labels.transcript.callStatusReason, {
      status: callStatusLabels.denied,
      reason: resultLabels.reasons['not-allowed'],
    });
    // Slice 2 (a), (c): the mark is a line of its own after the persona's line and says `from #general`, where the persona called from.
    assert.ok(line?.endsWith(`[called message.create from #general: ${status}]`), chatLines.join('\n'));
  });

  test('call marks: seeded from the journal after a restart, a call that did not work keeps why', async () => {
    const { journal, lines } = journalOverMemory();
    const scene = callMarkScene({
      answers: [toolAnswer('<msg>μια στιγμή</msg>', [call('message.delete')]), '<msg>μια στιγμή</msg>'],
      allowed: ['message.delete'],
      features: {},
      journal,
    });
    await scene.run(scene.channel, scene.history[1]);
    scene.history.push(ownRaw(scene.port, 'c1', TURN_TURN_NOW));
    const m2 = rawMessage({ id: 'm2', ts: TURN_TURN_NOW + 30_000, authorName: 'Alice', content: 'και;' });
    scene.history.push(m2);
    scene.clock.ms = TURN_TURN_NOW + 60_000;
    const restarted = scene.runner();
    restarted.seedCallMarks(callMarksOf(lines.map(({ record }) => record)));
    await scene.run(scene.channel, m2, restarted);
    const chatLines = lastChat(scene.llm).split('\n');
    const line = chatLines[chatLines.findIndex((text) => text.includes('μια στιγμή')) + 1];
    const callStatusLabels = labels.transcript.callStatus;
    const callReasonsLabels = labels.transcript.callReasons;
    const status = fill(labels.transcript.callStatusReason, {
      status: callStatusLabels.invalid,
      reason: fill(callReasonsLabels['missing-arg'], { arg: 'message' }),
    });
    // Slice 2 (a), (c): the mark is a line of its own after the persona's line and says `from #general`, where the persona called from.
    assert.ok(line?.endsWith(`[called message.delete from #general: ${status}]`), chatLines.join('\n'));
  });

  test('call marks: seeded from the journal after a restart, the calls show as they did; unseeded, nothing shows', async () => {
    const { journal, lines } = journalOverMemory();
    const scene = callMarkScene({
      answers: [
        toolAnswer('<msg reply="#2">εντάξει</msg>\n', [call('message.create', { place: '#🍡νέα', text: 'καλημέρα' })]),
        '<skip/>',
      ],
      journal,
    });
    await scene.run(scene.channel, scene.history[1]);
    // Slice 2 (c): the mark carries no posted link, so the persona's post in #νέα is checked here instead of read for its id.
    assert.ok(ownRaw(scene.port, 'c9', TURN_TURN_NOW).id, 'the call of the persona posted in #νέα');
    scene.history.push(ownRaw(scene.port, 'c1', TURN_TURN_NOW));
    const m2 = rawMessage({ id: 'm2', ts: TURN_TURN_NOW + 30_000, authorName: 'Alice', content: 'και;' });
    scene.history.push(m2);
    scene.clock.ms = TURN_TURN_NOW + 60_000;

    const restarted = scene.runner();
    restarted.seedCallMarks(callMarksOf((lines as Array<{ record: object }>).map(({ record }) => record)));
    await scene.run(scene.channel, m2, restarted);
    const chatLines = lastChat(scene.llm).split('\n');
    const line = chatLines[chatLines.findIndex((text) => text.includes('εντάξει')) + 1];
    // Slice 2 (a), (c): the mark is a line of its own after the persona's line, says where the persona called from, and has no posted link.
    assert.equal(line, '[12:00] Bot (you): [called message.create from #general: done]', chatLines.join('\n'));

    const unseeded = scene.runner();
    await scene.run(scene.channel, m2, unseeded);
    assert.ok(!lastChat(scene.llm).includes('[called '), 'nothing seeded, nothing shown');
  });
});
