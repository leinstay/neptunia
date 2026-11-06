// B6 and B10 of the master plan, seen from the model's side. The selfreflection wake is the old diary wake under its
// engine name: the turn mode `selfreflection` (with its `selfreflection` parameter object), the prompts
// `selfreflection`, `selfreflection-planner` and `selfreflection-seeds`, and the planner's purpose
// `selfreflection-planner`. The requests are the ones the diary wake sent (tests/fixtures/selfreflection-requests.json, recorded
// before the rename): the writer's byte for byte, the planner's but for one block. The planner's
// `<server>` becomes `<places>`, the places the persona follows, and a place whose audience is narrower than the one the
// post may reach is not named in it, as the lines of `<recent>` from such a place are not shown. The block tags the
// persona reads (`<diary>`, `<plan>`) keep her word, because they are text of the prompt.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { SERVER, sceneLlm, sceneMemory, sceneRunner, sceneWorld } from './fixtures/selfreflection-scene.ts';
import type { SceneMemory } from './fixtures/selfreflection-scene.ts';

const RECORDED_FILE = new URL('./fixtures/selfreflection-requests.json', import.meta.url);

type Message = { role: string; content: unknown };

/** The scenes a test opened, closed when the file is done. */
const OPEN: Array<SceneMemory> = [];
after(async () => {
  for (const scene of OPEN.splice(0)) await scene.memory.close();
});

/** The two requests recorded before the rename. */
function recorded(): { plan: Array<Message>; writer: Array<Message> } {
  const parsed: unknown = JSON.parse(fs.readFileSync(RECORDED_FILE, 'utf8'));
  // This test's own fixture, written by the recording of the scene: an object with both requests.
  return parsed as { plan: Array<Message>; writer: Array<Message> };
}

/** The plan request and the writer request of the scene's wake. */
async function wakeRequests(restricted = false): Promise<{ plan: Array<Message>; writer: Array<Message> }> {
  const scene = await sceneMemory({ restricted });
  OPEN.push(scene);
  sceneWorld({ restricted });
  const llm = sceneLlm();
  // The lead: the code draws the diary's kind (owner, 2026-11-06). The kind given is the planner's recorded
  // `status`, and the recorded plan request's <kinds> holds that kind alone.
  const result = await sceneRunner(llm, scene.store).runTurn({
    mode: 'selfreflection',
    selfreflection: { kind: 'status', forced: false },
    placeId: SERVER,
  });
  assert.equal((result as { outcome?: unknown }).outcome, 'spoke', 'the scene records an entry');
  assert.equal(llm.calls.length, 2, 'one plan request and one writer request, the plan under its purpose');
  return { plan: llm.calls[0] as Array<Message>, writer: llm.calls[1] as Array<Message> };
}

test('the writer request of a selfreflection wake is byte for byte the one the diary wake sent', async () => {
  // Bug: the rename changes what the model reads, through a block, a label or a prompt that moved with it.
  const { writer } = await wakeRequests();
  assert.deepEqual(writer, recorded().writer);
});

test('the plan request is the recorded one, with its places under <places> where <server> stood', async () => {
  // Bug: the planner keeps the server block, or the rename drops a line of the places she follows.
  const { plan } = await wakeRequests();
  const before = recorded().plan;
  assert.deepEqual(plan[0], before[0]);
  const user = String(plan[1]?.content);
  const old = String(before[1]?.content);
  assert.equal(user.includes('<server>'), false);
  assert.equal(user, old.replace('<server>', '<places>').replace('</server>', '</places>'));
});

test('a place only some of the readers may read is not named in the planner places', async () => {
  // Bug: the planner learns of a staff room from the place list and the post, which everyone reads, retells it.
  const { plan } = await wakeRequests(true);
  const user = String(plan[1]?.content);
  assert.match(user, /general/);
  assert.equal(user.includes('staff-room'), false);
  assert.equal(user.includes('private planning'), false);
});
