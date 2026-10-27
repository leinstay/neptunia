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
import { GUILD, sceneLlm, sceneMemory, sceneRunner, sceneWorld } from './fixtures/diary-requests.ts';
import type { SceneMemory } from './fixtures/diary-requests.ts';

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
