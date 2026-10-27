// The diary writes as it does when it is the selfreflection wake (stage 3 design, section 4): the plan request and the
// writer request of a diary turn with no conversation are byte for byte the ones the same scene built with the turn
// running in the diary channel (tests/fixtures/diary-requests.json, recorded from the code before the change). What the
// channel gave, memory gives instead: the history is her two earlier entries, and `<recent>`, the current conversation
// of `<server>` and the diary's name in `<senses>` come from the place of the diary's one enabled mirror. The diary
// channel is still known to the interface, empty, so the history can only come from memory. With no enabled mirror the
// same inputs come from the place the last entry was published to, whose record holds her two posts.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { GUILD, NOW, sceneLlm, sceneMemory, sceneRunner, sceneWorld } from './fixtures/diary-requests.ts';
import type { SceneMemory } from './fixtures/diary-requests.ts';
import { chatBlock, historyMemory, historyRunner, historyWorld } from './fixtures/diary-history.ts';
import type { Changes, HistoryMemory } from './fixtures/diary-history.ts';
import { createFakeAdapter } from '../src/interface/fake.js';

const RECORDED_FILE = new URL('./fixtures/diary-requests.json', import.meta.url);

/** The scenes a test opened, closed when the file is done. */
const OPEN: Array<SceneMemory> = [];
after(async () => {
  for (const scene of OPEN.splice(0)) await scene.memory.close();
});

/** The two recorded requests: what the test compares with. */
function recorded(): { plan: unknown; writer: unknown } {
  const parsed: unknown = JSON.parse(fs.readFileSync(RECORDED_FILE, 'utf8'));
  // This test's own fixture, written by the recording of the scene: an object with both requests.
  return parsed as { plan: unknown; writer: unknown };
}

/** The plan request and the writer request of the scene's diary turn, run as the selfreflection wake: no conversation. */
async function wakeRequests(
  memory: { mirror: boolean; published?: boolean } = { mirror: true }
): Promise<{ plan: unknown; writer: unknown }> {
  const scene = await sceneMemory(memory);
  OPEN.push(scene);
  sceneWorld({ history: false });
  const llm = sceneLlm();
  const result = await sceneRunner(llm, scene.store).runTurn({
    mode: 'diary',
    diary: { kind: null, forced: false },
    guildId: GUILD,
  });
  assert.equal((result as { outcome?: unknown }).outcome, 'spoke', 'the scene records an entry');
  assert.equal(llm.calls.length, 2, 'one plan request and one writer request');
  return { plan: llm.calls[0], writer: llm.calls[1] };
}

test('the plan request of a selfreflection wake is byte for byte the one the diary channel gave', async () => {
  const { plan } = await wakeRequests();
  assert.deepEqual(plan, recorded().plan);
});

test('the writer request of a selfreflection wake is byte for byte the one the diary channel gave', async () => {
  const { writer } = await wakeRequests();
  assert.deepEqual(writer, recorded().writer);
});

test('with no enabled mirror the wake rebuilds the requests from the place the last entry was published to', async () => {
  const { plan, writer } = await wakeRequests({ mirror: false, published: true });
  assert.deepEqual({ plan, writer }, recorded());
});

// ---- her history is her diary --------------------------------------------------------------------------------------

const HISTORY_FILE = new URL('./fixtures/diary-history.json', import.meta.url);

/** The scenes of the history tests, closed when the file is done. */
const HISTORIES: Array<HistoryMemory> = [];
after(async () => {
  for (const scene of HISTORIES.splice(0)) await scene.memory.close();
});

/** The writer's `<chat>` recorded on the code before the change, over her seven messages without Alice's line. */
function recordedChat(key: 'chat' | 'edited' | 'deleted' = 'chat'): string {
  const parsed: unknown = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
  // This test's own fixture, written by the recording of the history scene: one block per kind of history.
  return (parsed as Record<typeof key, string>)[key];
}

/** The writer's `<chat>` of the history scene's wake; `port` replaces the world's interface. */
async function wakeChat(
  port: ReturnType<typeof createFakeAdapter> | null = null,
  changes: Changes = {}
): Promise<string> {
  const scene = await historyMemory(changes);
  HISTORIES.push(scene);
  // The interface knows the diary channel with Alice's line in it: it is there, and it is not hers.
  historyWorld({ history: true, alice: true, ...changes });
  const llm = sceneLlm();
  const result = await historyRunner(llm, scene.store, port).runTurn({
    mode: 'diary',
    diary: { kind: null, forced: false },
    guildId: GUILD,
  });
  assert.equal((result as { outcome?: unknown }).outcome, 'spoke', 'the scene records an entry');
  return chatBlock(llm);
}

test("the wake's <chat> is her entries alone, the newest channelMessages of them, the picture described", async () => {
  assert.equal(await wakeChat(), recordedChat());
});

test("with no interface connected the wake's <chat> is the same, because it comes from memory", async () => {
  // An interface that answers no read and takes no action: what a turn has when nothing is connected.
  const silent = createFakeAdapter({ iface: 'fake', selfId: 'self-id', now: () => NOW, reads: [], operations: [] });
  assert.equal(await wakeChat(silent), recordedChat());
});

test("an edited message of hers shows its newest text with the edit mark in the wake's <chat>", async () => {
  assert.equal(await wakeChat(null, { edited: true }), recordedChat('edited'));
});

test("a deleted message of an entry is left out of the wake's <chat>, as the channel leaves it out", async () => {
  assert.equal(await wakeChat(null, { deleted: true }), recordedChat('deleted'));
});
