// Tests for the step engine of a turn (src/behavior/turn.js#runSteps): her tool calls planned in her order and made
// in segments, her speech out after them only when every call worked and none gave her something to read, held
// otherwise; one more request when something is left to read, append-only, one result for every call; bounds with
// the final request reserved. Over a real admin and the fake interface adapter; the model is scripted with native
// tool calls (tests/fixtures/tool-answers.js); no network, no data/.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fill } from '../src/format.js';
import { labels } from './fixtures/labels.js';
import { call, badCall, toolAnswer, textAnswer } from './fixtures/tool-answers.js';
import { NOW, rawMessage, appended, contentText, coreTurn, errandService, journalOverMemory, noteText, toolResults, AGENTS, WEB_CONFIG, hotWith, requestText } from './fixtures/turn-harness.js';

const texts = (run) => run.sends.map((send) => send.text);
const called = (run) => run.logs.filter((entry) => entry.msg === 'skills: called').map((entry) => `${entry.skill}:${entry.status}${entry.code ? `/${entry.code}` : ''}`);

test('a speech-only answer is one request with no tools sent as calls: it posts, no step follows', async () => {
  const run = await coreTurn({ answers: ['<think>t</think><msg>γεια</msg>'] });
  assert.equal(run.llm.calls.length, 1);
  assert.deepEqual(texts(run), ['γεια']);
  assert.equal(run.result.outcome, 'spoke');
});

test('unknown keys and a wrong enum are invalid-args results naming what the tool takes; coerced values are told in the result', async () => {
  const run = await coreTurn({
    answers: [
      toolAnswer('<think>x</think>', [call('lore.list', { bogus: 1 }, { id: 'k1' }), call('memory.journal.read', { n: '5', kind: 'nonsense' }, { id: 'k2' }), call('memory.journal.read', { n: '5' }, { id: 'k3' })]),
      '<skip/>',
    ],
    allowed: ['lore.list', 'memory.journal.read'],
  });
  const results = appended(run.llm, 1).filter((message) => message.role === 'tool').map((message) => contentText(message.content));
  assert.equal(results[0], fill(labels.skills.result.refused, { reason: fill(labels.skills.refusals.unknownArg, { arg: 'bogus', args: 'query' }) }), 'the tool\'s own arguments are named');
  assert.ok(results[1].length > 0);
  assert.ok(results[2].startsWith(fill(labels.skills.result.coerced, { arg: 'n', value: '5' })), results[2]);
  const refused = run.logs.filter((entry) => entry.msg === 'skill: refused').map((entry) => `${entry.skill}:${entry.code}:${entry.reason}`);
  assert.ok(refused.includes('lore.list:invalid-args:args.bogus:unknown'), refused.join(' | '));
  assert.ok(refused.some((line) => line.startsWith('memory.journal.read:invalid-args:args.kind')), refused.join(' | '));
});

test('duplicate call ids: the second keeps a made-up unique id, and both get their own tool message', async () => {
  const run = await coreTurn({ answers: [toolAnswer('', [call('lore.list', {}, { id: 'same' }), call('memory.server.read', {}, { id: 'same' })]), '<skip/>'] });
  const ids = appended(run.llm, 1).filter((message) => message.role === 'tool').map((message) => message.tool_call_id);
  assert.deepEqual(ids, ['same', 'same~2']);
  assert.deepEqual(appended(run.llm, 1)[0].tool_calls.map((item) => item.id), ['same', 'same~2']);
});

test('draw failure with held speech: nothing is posted in step 1, step 2 sees the result and the held notice, its speech goes out', async () => {
  const { ImageGenError } = await import('../src/llm/images.js');
  const { drawTurn, fakeImages } = await import('./fixtures/turn-draws.js');
  const run = await drawTurn({
    answers: [toolAnswer('<think>x</think><msg>ορίστε</msg>', [call('draw.create', { text: 'ένας φάρος' }, { id: 'd1' })]), '<think>y</think><msg>δεν βγήκε</msg>'],
    images: fakeImages([new ImageGenError('moderation')]),
  });
  assert.equal(run.llm.calls.length, 2);
  assert.deepEqual(texts(run), ['δεν βγήκε'], 'the first answer\'s "here it is" never went out');
  const result = contentText(appended(run.llm, 1).find((message) => message.role === 'tool').content);
  assert.ok(result.startsWith(fill(labels.skills.result.failed, { reason: labels.skills.result.reasons.other })), result);
  assert.deepEqual(called(run), ['draw.create:failed/image-moderation']);
  assert.ok(noteText(run.llm, 1).includes(labels.task.step.held));
  assert.deepEqual(run.sends.filter((send) => send.attachments?.length).length, 0, 'no picture posted');
});

test('all-quiet completion: draw.create ok with no speech is one request, the picture is posted and the turn ends', async () => {
  const { drawTurn, fakeImages } = await import('./fixtures/turn-draws.js');
  const images = fakeImages();
  const run = await drawTurn({ answers: [toolAnswer('<think>x</think>', [call('draw.create', { text: 'ένας φάρος' })]), '<msg>ποτέ</msg>'], images });
  assert.equal(run.llm.calls.length, 1, 'no request follows');
  assert.equal(images.calls.length, 1);
  assert.equal(run.sends.filter((send) => send.attachments?.length === 1).length, 1);
  assert.equal(run.result.delivered, true);
});

test('a picture and its announcement in one answer: the picture result covers the speech, the speech goes out after the picture', async () => {
  const { drawTurn } = await import('./fixtures/turn-draws.js');
  const run = await drawTurn({ answers: [toolAnswer('<think>x</think><msg>ορίστε</msg>', [call('draw.create', { text: 'ένας φάρος' })])] });
  assert.equal(run.llm.calls.length, 1);
  const order = run.sends.map((send) => (send.attachments?.length ? 'picture' : send.text));
  assert.deepEqual(order, ['picture', 'ορίστε'], 'calls run before her speech');
});

test('dependent diary announcement: a failed picture and a post to the diary channel in one batch both run in order, the post goes through, the speech is held and step 2 sees both', async () => {
  const { ImageGenError } = await import('../src/llm/images.js');
  const { drawTurn, fakeImages } = await import('./fixtures/turn-draws.js');
  const jardin = { id: 'c2', name: 'jardin', guild: { id: 'g1', members: { me: { displayName: 'Bot' } } }, isTextBased: () => true, isDMBased: () => false, viewable: true, permissionsFor: () => ({ has: () => true }) };
  const run = await drawTurn({
    answers: [
      toolAnswer('<think>x</think><msg>έγινε</msg>', [call('draw.create', { text: 'ένας φάρος' }, { id: 'p1' }), call('message.create', { channel: '#jardin', text: 'νέα ζωγραφιά!' }, { id: 'p2' })]),
      '<msg>δεν βγήκε, το είπα νωρίς</msg>',
    ],
    images: fakeImages([new ImageGenError('error')]),
    allowed: ['draw.create', 'message.create'],
    neighbours: [jardin],
  });
  assert.deepEqual(called(run), ['draw.create:failed/image-error', 'message.create:ok'], 'in her order, the second one is not stopped by the first');
  assert.deepEqual(run.sends.filter((send) => send.to === 'c2').map((send) => send.text), ['νέα ζωγραφιά!']);
  assert.deepEqual(run.sends.filter((send) => send.to === 'c1').map((send) => send.text), ['δεν βγήκε, το είπα νωρίς'], 'the held "έγινε" never went out; only step 2\'s speech in this channel');
  assert.deepEqual(toolResults(run.llm, 1).map((line) => line.split(':')[0]), ['p1', 'p2']);
  assert.ok(noteText(run.llm, 1).includes(labels.task.step.held));
});

test('an accepted background job covers the speech: task.run ok, the speech goes out after it, no extra request', async () => {
  const hot = hotWith({ config: { ...WEB_CONFIG, ...AGENTS } });
  const { service, runs } = errandService(hot);
  const run = await coreTurn({
    answers: [toolAnswer('<think>x</think><msg>το στέλνω να ψάξει</msg>', [call('task.run', { agent: 'web', goal: 'βρες κάτι' })]), '<msg>ποτέ</msg>'],
    allowed: ['task.run'],
    config: { ...WEB_CONFIG, ...AGENTS },
    runner: { errands: service },
    adminExtra: { errands: service },
  });
  assert.equal(run.llm.calls.length, 1, 'accepted is the end of it here');
  assert.deepEqual(texts(run), ['το στέλνω να ψάξει']);
  assert.equal(runs.length, 1);
  assert.equal(run.result.delivered, true);
});

test('think discipline: a missing think is counted and the calls still run; an unclosed think silences the speech but native calls run; an unclosed think alone is a skip', async () => {
  const { journal, lines } = journalOverMemory();
  const missing = await coreTurn({ answers: [toolAnswer('<msg>χωρίς σκέψη</msg>', [call('lore.list')]), '<think>t</think><msg>ναι</msg>'], journal });
  assert.ok(missing.logs.some((entry) => entry.msg === 'turn: think missing'));
  assert.deepEqual(called(missing), ['lore.list:ok']);
  assert.deepEqual(texts(missing), ['ναι']);
  const record = lines.map(({ record: item }) => item).find((item) => item.kind === 'turn');
  assert.equal(record.format.thinkMissing, 1);
  assert.equal(record.steps, 1);
  const open = await coreTurn({ answers: [toolAnswer('<think>δεν κλείνει <msg>χαμένο</msg>', [call('lore.list')]), '<think>t</think><msg>ναι</msg>'] });
  assert.deepEqual(called(open), ['lore.list:ok'], 'the call ran');
  assert.deepEqual(texts(open), ['ναι'], 'the speech inside the open think is silent');
  const alone = await coreTurn({ answers: ['<think>δεν κλείνει <msg>χαμένο</msg>'] });
  assert.equal(alone.result.outcome, 'skip');
  assert.equal(alone.sends.length, 0);
});

test('ordered reads and writes: read, write, read run in her order -- the two reads are not run together across the write', async () => {
  const events = [];
  const wrapCommand = (runOp) => async (key, args, context) => {
    events.push(`start:${key}`);
    await new Promise((resolve) => setImmediate(resolve));
    const result = await runOp(key, args, context);
    events.push(`end:${key}`);
    return result;
  };
  await coreTurn({
    answers: [toolAnswer('<think>x</think>', [call('lore.list'), call('lore.add', { title: 't', keys: 'k', text: 'x' }), call('memory.server.read')]), '<skip/>'],
    allowed: ['lore.list', 'lore.add', 'memory.server.read'],
    wrapCommand,
  });
  assert.deepEqual(events, ['start:lore.list', 'end:lore.list', 'start:lore.add', 'end:lore.add', 'start:memory.server.read', 'end:memory.server.read']);
  const together = [];
  await coreTurn({
    answers: [toolAnswer('<think>x</think>', [call('lore.list'), call('memory.server.read')]), '<skip/>'],
    wrapCommand: (runOp) => async (key, args, context) => {
      together.push(`start:${key}`);
      await new Promise((resolve) => setImmediate(resolve));
      together.push(`end:${key}`);
      return runOp(key, args, context);
    },
  });
  assert.deepEqual(together, ['start:lore.list', 'start:memory.server.read', 'end:lore.list', 'end:memory.server.read'], 'consecutive reads run alongside each other');
});

test('revocation mid-turn: a grant removed after her calls were planned, while an earlier one ran, refuses the later one at its run', async () => {
  let live = null;
  const run = await coreTurn({
    answers: [toolAnswer('<think>x</think>', [call('lore.list'), call('lore.add', { title: 't', keys: 'k', text: 'x' })]), '<skip/>'],
    allowed: ['lore.list', 'lore.add'],
    withHot: (hot) => {
      live = hot;
    },
    wrapCommand: (runOp) => async (key, args, context) => {
      if (key === 'lore.list') delete live.config.bot.access['lore.add'];
      return runOp(key, args, context);
    },
  });
  assert.deepEqual(called(run), ['lore.list:ok', 'lore.add:denied/not-allowed'], 'planned while granted, refused when its turn to run came');
  assert.equal(toolResults(run.llm, 1).length, 2);
});

test('steps spent: the last of the maxSteps requests is announced and final; its calls are loop-cap, journaled only, its speech held and a loopCut fact kept', async () => {
  const { journal, lines } = journalOverMemory();
  const run = await coreTurn({
    answers: [
      toolAnswer('<think>1</think>', [call('lore.list', {}, { id: 'a' })]),
      toolAnswer('<think>2</think>', [call('memory.server.read', {}, { id: 'b' })]),
      toolAnswer('<think>3</think><msg>ποτέ</msg>', [call('lore.list', {}, { id: 'c' })]),
    ],
    loop: { maxSteps: 2 },
    journal,
  });
  assert.equal(run.llm.calls.length, 3, 'the reply and two requests; none after the final answer');
  assert.ok(noteText(run.llm, 2).includes(labels.task.step.last), noteText(run.llm, 2));
  assert.ok(!noteText(run.llm, 1).includes(labels.task.step.last), 'not announced before it is the last');
  assert.deepEqual(texts(run), [], 'the final answer had a call: its speech is held');
  assert.deepEqual(called(run), ['lore.list:ok', 'memory.server.read:ok', 'lore.list:invalid/loop-cap']);
  const cap = run.logs.find((entry) => entry.msg === 'skills: loop cap');
  assert.deepEqual([cap.reason, cap.dropped], ['steps', 1]);
  const turn = lines.map(({ record }) => record).find((record) => record.kind === 'turn');
  assert.ok(turn.limits.some((limit) => limit.kind === 'loop-cap' && limit.detail === 'steps'), JSON.stringify(turn.limits));
  assert.equal(turn.steps, 2);
  assert.equal(turn.format.capped, 1);
  // The loopCut fact reaches her next turn here.
  await run.again();
  assert.ok(requestText(run.llm, 3).includes('<wake>'), 'a fact is told');
});

test('the final request without calls posts its speech as any answer does', async () => {
  const run = await coreTurn({
    answers: [toolAnswer('<think>1</think>', [call('lore.list')]), '<think>2</think><msg>τέλος</msg>'],
    loop: { maxSteps: 1 },
  });
  assert.ok(noteText(run.llm, 1).includes(labels.task.step.last));
  assert.deepEqual(texts(run), ['τέλος']);
});

test('time spent: the calls of the last answer before the budget ran out still run, the next request is final', async () => {
  let ms = 0;
  const run = await coreTurn({
    answers: [toolAnswer('<think>1</think>', [call('lore.list')]), toolAnswer('<think>2</think>', [call('memory.server.read')]), '<msg>ποτέ</msg>'],
    loop: { timeBudgetMs: 50, maxSteps: 5 },
    runner: { now: () => (ms += 30) },
  });
  assert.ok(noteText(run.llm, 1).includes(labels.task.step.last), 'the budget is spent after the first step: the next request is final');
  assert.deepEqual(called(run).filter((line) => line.endsWith('loop-cap')), ['memory.server.read:invalid/loop-cap']);
});

test('append-only: every request is the previous one plus what was appended; the cached parts and the system message never change', async () => {
  const run = await coreTurn({
    answers: [toolAnswer('<think>1</think>', [call('lore.list')]), toolAnswer('<think>2</think>', [call('memory.server.read')]), '<think>3</think><msg>τέλος</msg>'],
    loop: { maxSteps: 4 },
  });
  assert.equal(run.llm.calls.length, 3);
  for (let i = 1; i < 3; i += 1) {
    const before = run.llm.calls[i - 1];
    const now = run.llm.calls[i];
    assert.ok(now.length > before.length);
    before.forEach((message, at) => assert.equal(now[at], message, `message ${at} of request ${i} is the previous request's`));
  }
  assert.deepEqual(run.llm.calls[2][1], run.llm.calls[0][1]);
});

test('retired tags: a leftover <call> or <draw> in her speech is cut out, never run or posted, and told in the next note', async () => {
  const run = await coreTurn({
    answers: [toolAnswer('<think>x</think><msg>ναι</msg><draw>a boat</draw><call skill="lore.list"/>', [call('lore.list')]), '<msg>τέλος</msg>'],
  });
  assert.deepEqual(called(run), ['lore.list:ok'], 'only her real call ran');
  assert.deepEqual(texts(run), ['τέλος']);
  const note = noteText(run.llm, 1);
  const line = (tag) => `- ${fill(labels.skills.diagnostics.retiredTag, { tag })}`;
  assert.ok(note.includes(`${labels.task.diagnostics}\n${line('call')}\n${line('draw')}`) || (note.includes(line('call')) && note.includes(line('draw'))), note);
  // Told once.
  const long = await coreTurn({
    answers: [toolAnswer('<think>x</think><draw>a boat</draw>', [call('lore.list')]), toolAnswer('<think>y</think>', [call('memory.server.read')]), '<msg>τέλος</msg>'],
    loop: { maxSteps: 4 },
  });
  assert.ok(noteText(long.llm, 1).includes(line('draw')));
  assert.ok(!noteText(long.llm, 2).includes(labels.task.diagnostics), noteText(long.llm, 2));
});

test('journal dumps: the reply request is dumped as the base dump, each later request with its step and everything after the first two messages as `later`; the tools by hash', async () => {
  const { journal } = journalOverMemory();
  const dumps = [];
  journal.dumpRequest = async (guildId, dump) => {
    dumps.push(dump);
  };
  const run = await coreTurn({
    answers: [toolAnswer('<think>1</think>', [call('lore.list', {}, { id: 'a' })]), toolAnswer('<think>2</think>', [call('memory.server.read', {}, { id: 'b' })]), '<think>3</think><msg>τέλος</msg>'],
    journal,
    loop: { maxSteps: 4 },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(run.llm.calls.length, 3);
  assert.deepEqual(dumps.map((dump) => dump.step ?? null), [null, 1, 2]);
  assert.equal(dumps[0].later, undefined);
  assert.equal(dumps[1].later.length, 2, 'her answer and its tool message; there is nothing to note');
  assert.equal(dumps[2].later.length, 4);
  dumps.forEach((dump, i) => {
    assert.deepEqual(dump.request.messages, run.llm.calls[i].slice(0, 2), `request ${i}: the first two messages`);
    assert.equal(dump.tools.length > 0, true, 'the tools the request carried');
    assert.equal(dump.toolChoice, 'auto');
  });
  assert.deepEqual(dumps[2].toolCalls, undefined, 'the last answer called nothing');
  assert.equal(dumps[0].toolCalls.length, 1);
});

test('carried over: draw.create in the current conversation runs on a spontaneous turn with nobody asking, as the old tag did; in another channel it is refused no-requester', async () => {
  const { drawTurn, fakeImages } = await import('./fixtures/turn-draws.js');
  const here = await drawTurn({ spontaneous: 'initiate', allowed: [], answers: [toolAnswer('<think>x</think>', [call('draw.create', { text: 'ένας φάρος' })])] });
  assert.deepEqual(called(here), ['draw.create:ok']);
  assert.equal(here.sends.filter((send) => send.attachments?.length === 1).length, 1);

  const jardin = { id: 'c2', name: 'jardin', guild: { id: 'g1', members: { me: { displayName: 'Bot' } } }, isTextBased: () => true, isDMBased: () => false, viewable: true, permissionsFor: () => ({ has: () => true }) };
  const images = fakeImages();
  const away = await drawTurn({ spontaneous: 'initiate', images, neighbours: [jardin], answers: [toolAnswer('<think>x</think>', [call('draw.create', { text: 'ένας φάρος', channel: '#jardin' })]), '<think>y</think><msg>τίποτα</msg>'] });
  assert.deepEqual(called(away), ['draw.create:denied/no-requester']);
  assert.equal(images.calls.length, 0);
});

test('carried over: message.create in the current conversation also runs on a spontaneous turn with nobody asking', async () => {
  const run = await coreTurn({ spontaneous: 'initiate', allowed: [], answers: [toolAnswer('<think>x</think>', [call('message.create', { text: 'καλησπέρα' })])] });
  assert.deepEqual(called(run), ['message.create:ok']);
  assert.deepEqual(texts(run), ['καλησπέρα']);
});

// The core cases over both transports: the same scripted answers, written as native tool calls or as <tool_call> blocks.
const TRANSPORTS = ['native', 'text'];
const answerFor = (transport) => (transport === 'text' ? textAnswer : toolAnswer);
const onTransport = (transport) => (hot) => {
  hot.config.skills.transport = transport;
};
/** The results request `i` carries, as `{ id, status, text }`: tool messages (native) or the <tool_result> parts of the user message (text). */
const resultsOf = (llm, i, transport) => {
  if (transport === 'native') return appended(llm, i).filter((message) => message.role === 'tool').map((message) => ({ id: message.tool_call_id, status: null, text: contentText(message.content) }));
  return appended(llm, i)
    .filter((message) => message.role === 'user')
    .flatMap((message) => message.content)
    .map((part) => /^<tool_result id="([^"]*)" name="([^"]*)" status="([^"]*)">\n([\s\S]*)\n<\/tool_result>$/.exec(part.text))
    .filter(Boolean)
    .map((match) => ({ id: match[1], name: match[2], status: match[3], text: match[4] }));
};

for (const transport of TRANSPORTS) {
  const answer = answerFor(transport);
  const run = (options) => coreTurn({ ...options, withHot: onTransport(transport) });

  test(`[${transport}] a read: its speech is held until she has read the result; the next request is the previous one plus her answer, the result and a note`, async () => {
    const turn = await run({ answers: [answer('<think>look</think><msg>κοιτάζω</msg>', [call('lore.list', {}, { id: 'a1' })]), '<think>done</think><msg>τέλος</msg>'] });
    assert.equal(turn.llm.calls.length, 2);
    assert.deepEqual(texts(turn), ['τέλος'], 'the first answer\'s speech was held, never posted later');
    const [first, second] = turn.llm.calls;
    assert.equal(second[0], first[0], 'the system message is the same object');
    assert.equal(second[1], first[1], 'the first user message is never rebuilt');
    const added = appended(turn.llm, 1);
    const [result] = resultsOf(turn.llm, 1, transport);
    assert.ok(result.text.startsWith(labels.skills.result.ok), result.text);
    if (transport === 'native') {
      assert.deepEqual(added.map((message) => message.role), ['assistant', 'tool', 'user']);
      assert.equal(added[0].content, '<think>look</think><msg>κοιτάζω</msg>', 'her whole raw text');
      assert.deepEqual(added[0].tool_calls.map((item) => [item.id, item.function.name]), [['a1', 'lore_list']]);
      assert.equal(result.id, 'a1');
    } else {
      assert.deepEqual(added.map((message) => message.role), ['assistant', 'user'], 'the results and the note are one user message');
      assert.equal(added[0].content, answer('<think>look</think><msg>κοιτάζω</msg>', [call('lore.list')]).text, 'her whole raw text, the block included');
      assert.deepEqual([result.id, result.name, result.status], ['s1c1', 'lore.list', 'ok']);
    }
    const note = noteText(turn.llm, 1);
    assert.ok(note.includes(labels.task.step.held), note);
    assert.ok(!note.includes('κοιτάζω'), 'the held notice does not repeat her text');
    assert.equal(turn.logs.find((entry) => entry.msg === 'skills: loop').steps, 1);
    assert.ok(turn.logs.some((entry) => entry.msg === 'turn: speech held'));
  });

  test(`[${transport}] mixed batch: the valid call runs, an unknown name and unreadable arguments get results, the speech is held and every call is answered`, async () => {
    const turn = await run({
      answers: [answer('<think>x</think><msg>πρώτο</msg>', [call('lore.list', {}, { id: 'c1' }), call('no.such', {}, { id: 'c2' }), badCall('memory.server.read', '{"x": ', { id: 'c3' })]), '<msg>δεύτερο</msg>'],
    });
    assert.deepEqual(called(turn).filter((line) => line.startsWith('lore.list')), ['lore.list:ok']);
    assert.deepEqual(texts(turn), ['δεύτερο']);
    const results = resultsOf(turn.llm, 1, transport);
    assert.equal(results.length, 3, 'one result per call, refused ones included');
    if (transport === 'text') assert.deepEqual(results.map((item) => item.id), ['s1c1', 's1c2', 's1c3']);
    else assert.deepEqual(results.map((item) => item.id), ['c1', 'c2', 'c3']);
    assert.ok(results[0].text.startsWith(labels.skills.result.ok), results[0].text);
    assert.ok(!results[1].text.startsWith(labels.skills.result.ok), results[1].text);
    assert.ok(results[2].text.includes(labels.skills.result.reasons['malformed-call']), results[2].text);
    assert.ok(noteText(turn.llm, 1).includes(labels.task.step.held));
  });

  test(`[${transport}] an unknown name: refused with its own result, never run, the rest of the batch runs`, async () => {
    const turn = await run({ answers: [answer('<think>x</think>', [call('no.such', {}, { id: 'u1' }), call('lore.list', {}, { id: 'u2' })]), '<msg>ok</msg>'] });
    assert.deepEqual(called(turn).filter((line) => !line.startsWith('no.such')), ['lore.list:ok']);
    const results = resultsOf(turn.llm, 1, transport);
    assert.equal(results.length, 2);
    if (transport === 'text') assert.equal(results[0].status, 'invalid');
    assert.ok(results[1].text.startsWith(labels.skills.result.ok));
  });

  test(`[${transport}] truncated call: an answer that ran out of room has a truncated-call result and the speech is held`, async () => {
    const cut = transport === 'text'
      ? toolAnswer('<think>x</think><msg>μισό</msg><tool_call>{"name": "lore.list", "arguments": {"te', [], { finishReason: 'length' })
      : toolAnswer('<think>x</think><msg>μισό</msg>', [badCall('lore.list', '{"te', { id: 't1', error: 'cut' })], { finishReason: 'length' });
    const turn = await run({ answers: [cut, '<msg>ξανά</msg>'] });
    const [result] = resultsOf(turn.llm, 1, transport);
    assert.ok(result.text.includes(labels.skills.result.reasons['truncated-call']), result.text);
    assert.deepEqual(texts(turn), ['ξανά']);
    assert.equal(turn.result.outcome, 'spoke');
    assert.ok(!called(turn).some((line) => line.endsWith(':ok')), 'never run');
  });

  test(`[${transport}] cap exhaustion: past maxCallsPerStep a call is a loop-cap result and the rest ran; her speech is held`, async () => {
    const turn = await run({
      answers: [answer('<think>x</think><msg>a</msg>', [1, 2, 3, 4, 5].map((n) => call('lore.list', {}, { id: `r${n}` }))), '<msg>b</msg>'],
      loop: { maxCallsPerStep: 4 },
    });
    assert.equal(called(turn).filter((line) => line.startsWith('lore.list:ok')).length, 4);
    const results = resultsOf(turn.llm, 1, transport);
    assert.equal(results.length, 5, 'a result for the fifth too');
    assert.ok(results[4].text.startsWith(fill(labels.skills.result.refused, { reason: labels.skills.result.reasons['loop-cap'] })), results[4].text);
    assert.ok(called(turn).includes('lore.list:invalid/loop-cap'));
  });

  test(`[${transport}] delta numbering: lines that came in meanwhile are numbered past the request's own, and a later call's #N resolves to them`, async () => {
    let added = false;
    const turn = await run({
      answers: [
        answer('<think>1</think>', [call('lore.list')]),
        (messages) => {
          const note = noteText({ calls: [messages] }, 0);
          const match = /#(\d+) \[[^\]]*\] Zoë: ωραία νέα/.exec(note);
          return answer('<think>2</think>', [call('message.react.add', { message: `#${match?.[1] ?? 0}`, emoji: '👍' })]);
        },
        '<skip/>',
      ],
      allowed: ['lore.list', 'message.react.add'],
      onAnswer: (n, history, port) => {
        if (n !== 0 || added) return;
        added = true;
        history.push({ id: 'm9', channelId: 'c1', author: { id: 'u2', bot: false, globalName: 'Zoë', username: 'Zoë' }, member: { displayName: 'Zoë' }, cleanContent: 'ωραία νέα', createdTimestamp: 1_000 + Date.parse('2026-10-17T12:00:00Z'), reference: null, attachments: new Map(), stickers: new Map() });
        port.seed('c1', { authorId: 'u2', messageId: 'm9', text: 'ωραία νέα' });
      },
    });
    const note = noteText(turn.llm, 1);
    assert.ok(note.includes(labels.task.step.delta), note);
    assert.match(note, /#3 \[[^\]]*\] Zoë: ωραία νέα/, note);
    assert.equal(called(turn).at(-1), 'message.react.add:ok');
    assert.ok(turn.port.calls.some((item) => item.op === 'react' && item.args[0].messageId === 'm9'));
  });
}

test('[text] no tools field is sent, the tools are described in the <tools> block of the first message with dotted names, and the call ids are s<step>c<n>', async () => {
  const turn = await coreTurn({ answers: [textAnswer('<think>x</think>', [call('lore.list'), call('memory.server.read')]), '<msg>ok</msg>'], withHot: onTransport('text') });
  assert.ok(turn.llm.options.every((options) => options.tools === undefined && options.toolChoice === undefined), 'no tools field in any request');
  const first = requestText(turn.llm, 0);
  assert.ok(first.includes('<tools>'), 'the <tools> block');
  assert.ok(first.includes(labels.skills.toolsText.lead) && first.includes(labels.skills.toolsText.protocol));
  assert.ok(first.includes('"name":"lore.list"') && first.includes('"name":"memory.server.read"'), 'dotted names');
  assert.ok(!first.includes('"name":"lore_list"'));
  assert.deepEqual(resultsOf(turn.llm, 1, 'text').map((item) => item.id), ['s1c1', 's1c2']);
  assert.equal(turn.llm.calls[1][1], turn.llm.calls[0][1], 'the first user message is not rebuilt');
});

test('[native] the tools travel as the request field and no <tools> block is written', async () => {
  const turn = await coreTurn({ answers: [toolAnswer('<think>x</think>', [call('lore.list')]), '<msg>ok</msg>'], withHot: onTransport('native') });
  assert.ok(turn.llm.options.every((options) => Array.isArray(options.tools) && options.tools.length > 0));
  assert.ok(!requestText(turn.llm, 0).includes('<tools>'));
});

test('[text] a call nested in a <msg> is cut out of the message, never run, and answered as malformed-call; the message is not posted with it', async () => {
  const nested = '<think>x</think><msg>hello <tool_call>{"name": "lore.list", "arguments": {}}</tool_call> there</msg>';
  const turn = await coreTurn({ answers: [{ text: nested, usage: {}, estimated: 10, finishReason: 'stop' }, '<msg>ξανά</msg>'], withHot: onTransport('text') });
  assert.ok(!called(turn).some((line) => line.endsWith(':ok')), 'never run');
  const [result] = resultsOf(turn.llm, 1, 'text');
  assert.ok(result.text.includes(labels.skills.result.reasons['malformed-call']), result.text);
  assert.ok(texts(turn).every((text) => !text.includes('tool_call') && !text.includes('lore.list')), JSON.stringify(texts(turn)));
});

test('[text] the transport is read once per turn: a config change during the turn has no effect on it, the next turn follows the change', async () => {
  let live;
  const turn = await coreTurn({
    answers: [
      () => {
        live.config.skills.transport = 'native';
        return textAnswer('<think>x</think>', [call('lore.list')]);
      },
      '<msg>ok</msg>',
    ],
    withHot: (hot) => {
      live = hot;
      hot.config.skills.transport = 'text';
    },
  });
  assert.equal(turn.llm.calls.length, 2);
  assert.ok(turn.llm.options.every((options) => options.tools === undefined), 'still no tools field after the change');
  assert.deepEqual(resultsOf(turn.llm, 1, 'text').map((item) => item.id), ['s1c1']);
  await turn.again();
  assert.ok(Array.isArray(turn.llm.options.at(-1).tools), 'the next turn is native');
});

// A request 0 filled to the rail by history still leaves the room for one continuation step: the sections share the
// cap less the step reserve (skills.loop.stepReserveTokens), on both transports.
for (const transport of TRANSPORTS) {
  test(`[${transport}] a full context still gets one continuation step with a 3000-character data result`, async () => {
    const earlier = Array.from({ length: 60 }, (_, i) => rawMessage({ id: `e${i}`, ts: NOW - 600000 + i, authorId: 'u2', authorName: 'Zoë', content: `${'λόγια '.repeat(120)}${i}` }));
    const big = 'δεδομένα '.repeat(340);
    const turn = await coreTurn({
      answers: [answerFor(transport)('<think>x</think><msg>κοιτάζω</msg>', [call('lore.list', {}, { id: 'a1' })]), '<think>y</think><msg>τέλος</msg>'],
      earlier,
      loop: { stepReserveTokens: 3000 },
      config: { llm: { maxRequestTokens: 12000, maxOutputTokens: 500, safetyMargin: 0.9 } },
      withHot: (hot) => {
        onTransport(transport)(hot);
        hot.config.skills.resultMaxChars = 4000;
      },
      wrapCommand: (runOp) => async (key, args, context) => {
        const result = await runOp(key, args, context);
        return { ...result, summary: big, data: { text: big } };
      },
    });
    assert.equal(turn.llm.calls.length, 2, 'the step was made');
    assert.deepEqual(texts(turn), ['τέλος']);
    const [result] = resultsOf(turn.llm, 1, transport);
    assert.ok(result.text.length >= 3000, `the result was not cut: ${result.text.length}`);
    assert.ok(!turn.logs.some((entry) => entry.msg === 'skills: loop cap'), 'no token cap');
    assert.ok(!noteText(turn.llm, 1).includes(labels.task.step.last), 'not announced as the last request');
    // The first request really was full: without the reserve the same history fills the rail.
    const bare = await coreTurn({ answers: ['<skip/>'], earlier, config: { llm: { maxRequestTokens: 12000, maxOutputTokens: 500, safetyMargin: 0.9 } }, withHot: onTransport(transport) });
    assert.ok(requestText(bare.llm, 0).length > requestText(turn.llm, 0).length, 'the reserve shrinks the sections');
  });
}
