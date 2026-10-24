// Tests for the drawing agent, the tool kind of agent (stage 3b): src/errands/tools.js (the
// drawing tool over an injected image client, the failure codes and their mapping back to the
// errors the call sites handle), src/errands/service.js#runInline (a tool run as a task record,
// the daily caps, the deadline, a store that cannot take the record), and what the task store
// leaves out for a tool agent's tasks (born seen, not in the lists, outside agents.maxOpen,
// no journal line, its own keep list, never mirrored into the ledger). Over a real task store in
// a temp directory, a fake image client and a fake ledger mirror; no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { createTaskStore, createTaskStores, isToolTask, KEEP_FINISHED_TOOL } from '../src/errands/store.js';
import { createErrandService } from '../src/errands/service.js';
import {
  DRAWING_AGENT,
  DRAW_CODES,
  DrawToolError,
  createDrawingTool,
  drawErrorOf,
  drawPicture,
  drawPromptOf,
  errorOfCode,
} from '../src/errands/tools.js';
import { ImageCapError, ImageGenError, UnsupportedImageModelError } from '../src/llm/images.js';
import { toolProfileOf, profileOf, TOOL_PROFILES } from '../src/agent-runner/profiles.js';
import { withCapturedLogs } from './fixtures/capture-logs.js';
import { tempDir } from './fixtures/tmp.js';

const NOW = Date.UTC(2026, 9, 6, 19, 30, 0);
const AVATAR = 'data:image/png;base64,QVZBVEFS';
const SCENE = 'a lighthouse at dusk; keep every word,  even the odd   spacing';

function hotOf(extra = {}) {
  return {
    config: {
      bot: { timezone: 'Europe/Athens' },
      image: { maxPromptChars: 1000, reference: 'avatar', referenceMaxBytes: 4_000_000 },
      features: { journal: true },
      agents: { maxOpen: 1, ...extra.agents },
    },
    prompts: {
      draw: 'DRAW by {{name}}.\n\n{{appearance}}\n\n{{when}}\n\nScene: {{request}}',
      appearance: '{{name}} has a green scarf.',
      labels: { draw: { when: 'At {when}.' } },
    },
  };
}

/** A fake image client: records each call, answers `answers` in turn (an Error is thrown). */
function fakeImages(answers = []) {
  const calls = [];
  return {
    calls,
    async generate(args) {
      calls.push(structuredClone(args));
      const next = answers.length > 0 ? answers.shift() : null;
      if (next instanceof Error) throw next;
      return next ?? { buffer: Buffer.from('png'), mediaType: 'image/png', seconds: 2, cost: 0.03, usage: { cost: 0.03, input_tokens: 40, output_tokens: 1000 }, model: 'm/img' };
    },
  };
}

const fetcherOf = () => ({ fetchAsDataUrl: async () => ({ dataUrl: AVATAR }) });
const clientOf = () => ({ user: { displayAvatarURL: () => 'https://cdn.example/a.png' } });

function toolOf({ images, hot = hotOf(), imageFetcher = fetcherOf() } = {}) {
  return createDrawingTool({ images, hot, client: clientOf(), imageFetcher, now: () => NOW });
}

function makeService({ hot = hotOf(), journal = null, ledger = null, getGuildId = () => 'g1' } = {}) {
  const dataDir = tempDir('nep-drawing-');
  const stores = createTaskStores({ dataDir, config: () => hot.config, journal, now: () => NOW });
  const mirrored = [];
  const mirror = ledger ?? new Proxy({}, { get: (_t, name) => (...args) => { mirrored.push([name, ...args]); } });
  const errands = createErrandService({ client: { configured: () => true, run: async () => ({ status: 'done' }) }, stores, hot, getGuildId, ledger: mirror, defer: (fn) => fn(), now: () => NOW });
  return { errands, stores, dataDir, mirrored, hot };
}

const requester = { userId: 'u1', kind: 'member' };

test('drawing profile: a tool agent the runner never takes, with its own caps', () => {
  const profile = toolProfileOf('drawing');
  assert.equal(profile.kind, 'tool');
  assert.equal(profile.tool, 'draw');
  assert.equal(profile.modelRole, 'drawing');
  assert.deepEqual({ ...profile.defaultLimits }, { seconds: 300 });
  assert.deepEqual({ ...profile.defaultDaily }, { tasks: 100 });
  assert.equal(profileOf('drawing'), null, 'no runner profile: it cannot be submitted as an errand');
  assert.deepEqual(Object.keys(TOOL_PROFILES), ['drawing']);
  assert.equal(isToolTask('drawing'), true);
  assert.equal(isToolTask({ agent: 'scout' }), false);
});

test('draw tool: her scene goes into the draw prompt verbatim, with the appearance and the time, and the avatar as reference', async () => {
  const images = fakeImages();
  const { output, usage, result } = await toolOf({ images }).run({ scene: SCENE, selfName: 'Bot', self: true, withTime: true, userId: 'u1' });
  assert.deepEqual(images.calls, [{
    prompt: `DRAW by Bot.\n\nBot has a green scarf.\n\nAt Tuesday, October 6, 2026, 22:30 (Europe/Athens).\n\nScene: ${SCENE}`,
    reference: AVATAR,
    userId: 'u1',
  }]);
  assert.equal(output.picture.model, 'm/img');
  assert.equal(output.referenceMissing, false);
  assert.deepEqual(usage, { input: 40, output: 1000, usd: 0.03, steps: 1, seconds: 2 });
  assert.deepEqual(result, { text: '' });
});

test('draw tool: no time for the owner\'s command, no appearance and no reference for a picture she is not in, a long scene cut at a boundary', async () => {
  const images = fakeImages();
  const hot = hotOf();
  hot.config.image.maxPromptChars = 20;
  await toolOf({ images, hot }).run({ scene: 'boats in the harbour, a very long scene', selfName: 'Bot', self: false, withTime: false });
  assert.deepEqual(images.calls[0].reference, null);
  assert.ok(!images.calls[0].prompt.includes('green scarf'));
  assert.ok(!images.calls[0].prompt.includes('At '));
  assert.ok(images.calls[0].prompt.endsWith('Scene: boats in the'), images.calls[0].prompt);
  assert.ok(!images.calls[0].prompt.includes('harbour'), 'cut to image.maxPromptChars, not rewritten');
  assert.equal(drawPromptOf({ hot, selfName: 'Bot', scene: 'x', self: false, withTime: false }), 'DRAW by Bot.\n\nScene: x');
});

test('draw tool: the avatar is fetched once into a shared holder; a missing avatar is reported once and the picture still goes', async () => {
  const images = fakeImages();
  let fetched = 0;
  const imageFetcher = { fetchAsDataUrl: async () => { fetched += 1; throw new Error('down'); } };
  const tool = toolOf({ images, imageFetcher });
  const avatar = {};
  const first = await tool.run({ scene: 'a', selfName: 'Bot', self: true, avatar });
  const second = await tool.run({ scene: 'b', selfName: 'Bot', self: true, avatar });
  assert.equal(fetched, 1);
  assert.equal(first.output.referenceMissing, true);
  assert.equal(second.output.referenceMissing, false, 'told once per set');
  assert.deepEqual(images.calls.map((call) => call.reference), [null, null]);
  const off = hotOf();
  off.config.image.reference = 'none';
  const plain = fakeImages();
  await toolOf({ images: plain, hot: off }).run({ scene: 'c', selfName: 'Bot', self: true });
  assert.equal(plain.calls[0].reference, null);
});

test('draw tool: a cost the provider did not report is counted unknown, not zero dollars silently', async () => {
  const images = fakeImages([{ buffer: Buffer.from('x'), mediaType: 'image/png', seconds: 1, cost: null, usage: null, model: 'm/img' }]);
  const { usage } = await toolOf({ images }).run({ scene: 'a', selfName: 'Bot' });
  assert.equal(usage.usd, 0);
  assert.equal(usage.costUnknown, 1);
});

test('draw tool: failures carry their code, and the code maps back to the error the call sites handle', async () => {
  const capped = Object.assign(new ImageCapError('daily', 'cap'), { key: 'image.maxPerDay', used: 50, cap: 50 });
  const userCapped = Object.assign(new ImageCapError('userDaily', 'cap'), { key: 'image.maxPerUserPerDay', used: 5, cap: 5 });
  const cases = [
    [capped, DRAW_CODES.capDaily],
    [userCapped, DRAW_CODES.capUserDaily],
    [new ImageGenError('moderation', 'refused', { statusCode: 400 }), 'image-moderation'],
    [new ImageGenError('timeout'), 'image-timeout'],
    [new ImageGenError('error', 'x', { statusCode: 502 }), 'image-error'],
    [new ImageGenError('empty'), 'image-empty'],
    [new UnsupportedImageModelError('x/y'), DRAW_CODES.unsupported],
    [new TypeError('boom'), DRAW_CODES.failed],
  ];
  for (const [error, code] of cases) {
    const tool = toolOf({ images: fakeImages([error]) });
    await assert.rejects(() => tool.run({ scene: 'a', selfName: 'Bot' }), (err) => {
      assert.ok(err instanceof DrawToolError);
      assert.equal(err.code, code);
      assert.equal(err.cause, error);
      // The original error comes back as it was: key, used, cap, reason and status intact.
      assert.equal(drawErrorOf({ code, error: err }), error);
      return true;
    });
  }
  // Without the original (only the code and the details): the same classes and fields.
  const cap = errorOfCode(DRAW_CODES.capDaily, { key: 'image.maxPerDay', used: 50, cap: 50 });
  assert.ok(cap instanceof ImageCapError);
  assert.deepEqual([cap.reason, cap.key, cap.used, cap.cap], ['daily', 'image.maxPerDay', 50, 50]);
  assert.equal(errorOfCode(DRAW_CODES.capUserDaily, {}).reason, 'userDaily');
  const gen = errorOfCode('image-moderation', { statusCode: 403 });
  assert.ok(gen instanceof ImageGenError);
  assert.deepEqual([gen.reason, gen.statusCode], ['moderation', 403]);
  for (const reason of ['timeout', 'error', 'empty']) assert.equal(errorOfCode(`image-${reason}`).reason, reason);
  assert.ok(errorOfCode(DRAW_CODES.unsupported, { model: 'x/y' }) instanceof UnsupportedImageModelError);
  assert.equal(errorOfCode('whatever').code, 'whatever');
});

test('drawPicture without the errand service: the tool alone, errors unwrapped to the image client\'s own', async () => {
  const images = fakeImages();
  const tool = toolOf({ images });
  const { picture } = await drawPicture({ tool, input: { scene: 'a', selfName: 'Bot' } });
  assert.equal(picture.mediaType, 'image/png');
  const capped = Object.assign(new ImageCapError('daily'), { key: 'image.maxPerDay', used: 1, cap: 1 });
  await assert.rejects(() => drawPicture({ tool: toolOf({ images: fakeImages([capped]) }), input: { scene: 'a', selfName: 'Bot' } }), (err) => err === capped);
  const odd = new RangeError('odd');
  await assert.rejects(() => drawPicture({ tool: toolOf({ images: fakeImages([odd]) }), input: { scene: 'a', selfName: 'Bot' } }), (err) => err === odd);
});

test('runInline: a picture is a task record (queued, running, done) with the usage from the provider, born seen and out of the lists', async () => {
  const { errands, stores, dataDir, mirrored } = makeService();
  const images = fakeImages();
  const { picture, referenceMissing } = await drawPicture({
    tool: toolOf({ images }),
    errands,
    guildId: 'g1',
    input: { scene: SCENE, selfName: 'Bot', self: true, withTime: true, userId: 'u1' },
    requester,
    origin: { channelId: 'c1', messageId: 'm1' },
  });
  assert.equal(picture.model, 'm/img');
  assert.equal(referenceMissing, false);
  const store = stores.get('g1');
  const [task] = [...JSON.parse(fs.readFileSync(path.join(dataDir, 'guilds', 'g1', 'tasks.json'), 'utf8')).tasks];
  assert.equal(task.agent, DRAWING_AGENT);
  assert.equal(task.state, 'done');
  assert.equal(task.goal, SCENE);
  assert.equal(task.seen, true);
  assert.deepEqual(task.requester, requester);
  assert.equal(task.usage.usd, 0.03);
  assert.equal(task.usage.input, 40);
  assert.equal(task.usage.output, 1000);
  assert.equal(task.error, null);
  // The transitions are in tasks.jsonl, the spend in the store's costs.
  const lines = fs.readFileSync(path.join(dataDir, 'guilds', 'g1', 'tasks.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(lines.map((line) => line.state), ['queued', 'running', 'done']);
  assert.deepEqual(store.costs(['drawing']).drawing.today, { runs: 1, input: 40, output: 1000, usd: 0.03 });
  // Out of the persona's views, the lists and the ledger; nothing was told.
  assert.deepEqual(store.open(), []);
  assert.deepEqual(store.unseen(), []);
  assert.deepEqual(store.recent(), []);
  assert.deepEqual(errands.view({ guildId: 'g1' }), []);
  assert.deepEqual(mirrored, [], 'never mirrored into the ledger');
});

test('runInline: a failure closes the record failed with the code, and reaches the caller as the original image error', async () => {
  const { errands, stores, dataDir } = makeService();
  const moderated = new ImageGenError('moderation', 'refused', { statusCode: 400 });
  await withCapturedLogs(async () => {
    await assert.rejects(() => drawPicture({ tool: toolOf({ images: fakeImages([moderated]) }), errands, guildId: 'g1', input: { scene: 'a', selfName: 'Bot' }, requester }), (err) => err === moderated);
    const capped = Object.assign(new ImageCapError('userDaily', 'cap'), { key: 'image.maxPerUserPerDay', used: 5, cap: 5 });
    await assert.rejects(() => drawPicture({ tool: toolOf({ images: fakeImages([capped]) }), errands, guildId: 'g1', input: { scene: 'b', selfName: 'Bot' }, requester }), (err) => err instanceof ImageCapError && err.key === 'image.maxPerUserPerDay' && err.used === 5 && err.cap === 5);
  });
  const tasks = JSON.parse(fs.readFileSync(path.join(dataDir, 'guilds', 'g1', 'tasks.json'), 'utf8')).tasks;
  assert.deepEqual(tasks.map((task) => [task.state, task.error, task.seen]), [['failed', 'image-moderation', true], ['failed', 'image-cap-user-daily', true]]);
  assert.equal(stores.get('g1').costs(['drawing']).drawing.today.runs, 2, 'a failed picture is a run too');
  assert.deepEqual(stores.get('g1').unseen(), [], 'a failure is no news for her');
});

test('runInline: a tool outside agents.maxOpen, errands keep their cap; a tool task never counts as open', async () => {
  const { errands, stores } = makeService({ hot: hotOf({ agents: { maxOpen: 1 } }) });
  const store = stores.get('g1');
  const gate = {};
  const slow = new Promise((resolve) => { gate.release = resolve; });
  const running = errands.runInline({ guildId: 'g1', agent: 'drawing', goal: 'g', requester, run: async () => { await slow; return { output: 1 }; } });
  // A picture is under way: it is not an open errand, and an errand still gets its slot.
  assert.deepEqual(store.open(), []);
  assert.equal(store.budget('scout').spent, false);
  assert.equal(store.add({ agent: 'scout', goal: 'look', requester, origin: {}, scope: 'group' }).ok, true);
  assert.equal(store.add({ agent: 'scout', goal: 'again', requester, origin: {}, scope: 'group' }).code, 'cap-open');
  // And a full errand list does not refuse a picture.
  gate.release();
  assert.equal((await running).ok, true);
  const more = await errands.runInline({ guildId: 'g1', agent: 'drawing', goal: 'g2', requester, run: async () => ({ output: 2 }) });
  assert.equal(more.ok, true);
  assert.equal(more.output, 2);
});

test('runInline: the agent\'s daily caps refuse a picture before it starts, with the setting, the use and the cap; the same notice an image cap gives', async () => {
  let ran = 0;
  const run = async () => { ran += 1; return { output: 'p', usage: { usd: 0.6 } }; };
  const hot = hotOf({ agents: { drawing: { daily: { tasks: 2 } } } });
  const { errands } = makeService({ hot });
  assert.equal((await errands.runInline({ guildId: 'g1', agent: 'drawing', goal: 'a', requester, run })).ok, true);
  assert.equal((await errands.runInline({ guildId: 'g1', agent: 'drawing', goal: 'b', requester, run })).ok, true);
  const tasksCap = await errands.runInline({ guildId: 'g1', agent: 'drawing', goal: 'c', requester, run });
  assert.deepEqual([tasksCap.ok, tasksCap.code, tasksCap.key, tasksCap.used, tasksCap.cap], [false, 'cap-tasks', 'agents.drawing.daily.tasks', 2, 2]);
  assert.equal(ran, 2, 'nothing ran past the cap');
  const err = drawErrorOf(tasksCap);
  assert.ok(err instanceof ImageCapError);
  assert.deepEqual([err.reason, err.key, err.used, err.cap], ['daily', 'agents.drawing.daily.tasks', 2, 2]);

  // What the pictures cost never refuses one: only the count does.
  const costly = makeService({ hot: hotOf({ agents: { drawing: { daily: { tasks: 50 } } } }) });
  for (const goal of ['a', 'b', 'c']) assert.equal((await costly.errands.runInline({ guildId: 'g1', agent: 'drawing', goal, requester, run })).ok, true);
});

test('runInline: a run past agents.drawing.limits.seconds is cut off as a timed-out generation', async () => {
  const hot = hotOf({ agents: { drawing: { limits: { seconds: 0.02 } } } });
  const { errands, stores } = makeService({ hot });
  const never = () => new Promise(() => {});
  const outcome = await errands.runInline({ guildId: 'g1', agent: 'drawing', goal: 'slow', requester, run: never });
  assert.deepEqual([outcome.ok, outcome.code], [false, 'timeout']);
  const err = drawErrorOf(outcome);
  assert.ok(err instanceof ImageGenError);
  assert.equal(err.reason, 'timeout');
  assert.equal(stores.get('g1').costs(['drawing']).drawing.today.runs, 1);
});

test('runInline: a store that cannot take the record never costs the picture', async () => {
  // No guild at all: the tool runs, unrecorded.
  const noGuild = makeService({ getGuildId: () => null });
  const unrecorded = await withCapturedLogs(() => noGuild.errands.runInline({ guildId: null, agent: 'drawing', goal: 'a', requester, run: async () => ({ output: 'p' }) }));
  assert.deepEqual([unrecorded.result.ok, unrecorded.result.output, unrecorded.result.task], [true, 'p', null]);
  // A store whose writes throw.
  const hot = hotOf();
  const broken = {
    get: () => ({ add: () => { throw new Error('disk'); }, guildId: 'g1' }),
  };
  const errands = createErrandService({ client: {}, stores: broken, hot, getGuildId: () => 'g1', ledger: {}, now: () => NOW });
  const survived = await withCapturedLogs(() => errands.runInline({ guildId: 'g1', agent: 'drawing', goal: 'a', requester, run: async () => ({ output: 'p' }) }));
  assert.equal(survived.result.ok, true);
  assert.equal(survived.result.output, 'p');
  assert.ok(survived.logs.some((l) => l.msg === 'errands: tool run unrecorded'));
  // Only a tool agent runs inline.
  assert.deepEqual(await errands.runInline({ guildId: 'g1', agent: 'scout', goal: 'a', requester, run: async () => ({}) }), { ok: false, code: 'unknown-agent' });
});

test('the drawing agent is not an errand: submit refuses it and a task of it cannot be cancelled', async () => {
  const { errands, stores, dataDir } = makeService();
  assert.deepEqual(errands.submit({ guildId: 'g1', agent: 'drawing', goal: 'a', requester, origin: {}, scope: 'group' }), { ok: false, code: 'unknown-agent' });
  await errands.runInline({ guildId: 'g1', agent: 'drawing', goal: 'a', requester, run: async () => ({ output: 1 }) });
  const [done] = stores.get('g1').costs(['drawing']).drawing.today.runs === 1 ? JSON.parse(fs.readFileSync(path.join(dataDir, 'guilds', 'g1', 'tasks.json'), 'utf8')).tasks : [];
  assert.deepEqual(errands.cancel({ guildId: 'g1', id: done.id }), { ok: false, code: 'not-found' }, 'nothing to cancel in a finished picture');
});

test('task store: a tool agent\'s tasks are born seen, stay seen, write no journal line and have a keep list of their own', async () => {
  const dataDir = tempDir('nep-drawing-store-');
  const clock = { t: NOW };
  const journalLines = [];
  const journal = { action: async (_guild, line) => { journalLines.push(line); } };
  const config = { features: { journal: true }, agents: { maxOpen: 3, scout: { daily: { tasks: 500 } }, drawing: { daily: { tasks: 500 } } } };
  const store = createTaskStore({ dataDir, guildId: 'g1', now: () => clock.t, config: () => config, journal });
  const draw = () => {
    clock.t += 1000;
    const { task } = store.add({ agent: 'drawing', goal: 'scene', requester, origin: {}, scope: 'group' });
    assert.equal(task.seen, true, 'born seen');
    store.start(task.id);
    return store.finish(task.id, { status: 'done', result: { text: '' }, usage: { usd: 0.02 } });
  };
  for (let i = 0; i < KEEP_FINISHED_TOOL + 5; i += 1) assert.equal(draw().seen, true);
  // One errand finished and unseen, among the pictures.
  const { task: errand } = store.add({ agent: 'scout', goal: 'look', requester, origin: {}, scope: 'group' });
  store.start(errand.id);
  store.finish(errand.id, { status: 'done', result: { text: 'found' } });
  draw();
  assert.deepEqual(store.unseen().map((task) => task.id), [errand.id], 'only the errand is news');
  assert.deepEqual(store.recent(100).map((task) => task.agent), ['scout']);
  const kept = JSON.parse(fs.readFileSync(path.join(dataDir, 'guilds', 'g1', 'tasks.json'), 'utf8')).tasks;
  assert.equal(kept.filter((task) => task.agent === 'drawing').length, KEEP_FINISHED_TOOL);
  assert.equal(kept.filter((task) => task.agent === 'scout').length, 1);
  // Every picture is still in the spend, kept whole by tasks.jsonl.
  const reloaded = createTaskStore({ dataDir, guildId: 'g1', now: () => clock.t, config: () => config });
  assert.equal(reloaded.costs(['drawing']).drawing.today.runs, KEEP_FINISHED_TOOL + 6);
  assert.ok(Math.abs(reloaded.costs(['drawing']).drawing.today.usd - 0.02 * (KEEP_FINISHED_TOOL + 6)) < 1e-9);
  assert.ok(journalLines.length > 0, 'the errand is journaled');
  assert.ok(journalLines.every((line) => !kept.some((task) => task.agent === 'drawing' && task.opId === line.opId)), 'no journal line for a picture');
  // A restart fails an open picture without telling her.
  const { task: open } = store.add({ agent: 'drawing', goal: 'cut by a restart', requester, origin: {}, scope: 'group' });
  assert.equal(store.failOpen('restarted'), 1);
  assert.equal(store.get(open.id).error, 'restarted');
  assert.deepEqual(store.unseen().map((task) => task.id), [errand.id]);
});

test('task store: a forget of the member drops their pictures with their other tasks', async () => {
  const { errands, stores } = makeService();
  await errands.runInline({ guildId: 'g1', agent: 'drawing', goal: 'mine', requester: { userId: 'u9', kind: 'member' }, run: async () => ({ output: 1, usage: { usd: 0.1 } }) });
  await errands.runInline({ guildId: 'g1', agent: 'drawing', goal: 'hers', requester: { userId: null, kind: 'persona' }, run: async () => ({ output: 1, usage: { usd: 0.1 } }) });
  assert.equal(stores.get('g1').costs(['drawing']).drawing.today.runs, 2);
  assert.deepEqual(errands.forgetUser('g1', 'u9'), { removed: 1, lines: 3 });
  assert.equal(stores.get('g1').costs(['drawing']).drawing.today.runs, 1);
});
