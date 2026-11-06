// The owner's command `/memory selfreflection remove <id>` (brief 2026-11-06, "the owner removes a diary entry"): parsed
// by the command table, run by the owner's console over the memory service's `removeSelfreflectionEntry` with the
// interface's delete the console holds as `port`, and reached from the owner's chat alone. It answers counts and no
// content, and a refusal answers its code. The removal itself is tests/memory-db-selfreflection-remove.test.ts; the
// scene and the contract are tests/fixtures/selfreflection-removal.ts. Invented ids and synthetic text only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRequest } from '../bin/neptunia-request.ts';
import { createConsole } from '../src/interface/commands/console.ts';
import type { Answer, ConsoleDeps } from '../src/interface/commands/console.ts';
import { commandLineWords, parseCommandLine } from '../src/interface/commands/table.ts';
import { createCommandDesk } from '../src/interface/neptunia-cli.ts';
import type { CommandDeps } from '../src/interface/neptunia-cli.ts';
import { listOps } from '../src/tools/impl/index.ts';
import { removalScene, rowsWhere } from './fixtures/selfreflection-removal.ts';
import type { DeletePort, RemovalScene } from './fixtures/selfreflection-removal.ts';

const LINE = '/memory selfreflection remove entry-north-pier';

/** What the console deletes through: the scene's port, or none for a core wired without one. */
type PortOf = ((iface: string) => DeletePort | null) | null;

/** The owner's console over the scene's memory, deleting through `port`. */
function consoleOf(rig: RemovalScene, port: PortOf) {
  const { memory } = rig.scene;
  const deps: ConsoleDeps = {
    runOp: () => Promise.resolve({ status: 'failed', code: 'no-op', summary: '', data: null }),
    ownerReads: { lessons: () => '', aliases: () => '' },
    places: () => ['g1'],
    selfId: () => 'self',
    hot: { config: { bot: { owners: [] } } },
    privateDir: memory.dataDir,
    dataDir: memory.dataDir,
    memoryDb: memory.memoryDb,
    usage: null,
    metrics: null,
    conversationLines: () => [],
    now: rig.scene.now,
    ...(port === null ? {} : { port }),
  };
  return createConsole(deps);
}

/** One line of the owner's chat through the table's parse and the console. */
async function say(rig: RemovalScene, line: string, port: PortOf = rig.port): Promise<Answer> {
  const parsed = parseCommandLine(line);
  assert.ok(parsed.ok, parsed.ok ? '' : parsed.reason);
  return consoleOf(rig, port).run(parsed.name, parsed.args, { id: 'owner' });
}

const entryRows = (rig: RemovalScene, id: string): number => rowsWhere(rig.db, 'selfreflection', 'id', id).length;

test('/memory selfreflection remove parses the same from the chat and from argv', () => {
  // Bug: the leaf is missing from the table, or argv and the chat give the id under different names.
  const fromChat = parseCommandLine(LINE);
  assert.ok(fromChat.ok, fromChat.ok ? '' : fromChat.reason);
  assert.equal(fromChat.name, 'memory.selfreflection.remove');
  assert.deepEqual(fromChat.args, { id: 'entry-north-pier' });
  assert.deepEqual(parseRequest(commandLineWords(LINE)).parsed, fromChat);
});

test('/memory selfreflection remove without an id is refused by the parse', () => {
  // Bug: a bare line reaches the removal with an empty id.
  assert.equal(parseCommandLine('/memory selfreflection remove').ok, false);
});

test("the owner's command removes a published entry and deletes its messages through the console's port", async () => {
  // Bug: the console answers ok without reaching the removal, or reaches it with no way to delete on the platform.
  const rig = await removalScene();
  const seeded = await rig.published({ id: 'entry-north-pier' });
  const answer = await say(rig, LINE);
  assert.equal(answer.status, 'ok', answer.text);
  assert.equal(entryRows(rig, seeded.entryId), 0);
  assert.deepEqual(rig.deletes.map((ref) => ref.messageId).sort(), [...seeded.messageIds].sort());
});

test("the command's answer carries no text of the entry", async () => {
  // Bug: the answer echoes what was removed, and the owner's terminal keeps the words the owner asked to be rid of.
  const rig = await removalScene();
  await rig.published({ id: 'entry-north-pier', text: 'a lantern over the north pier' });
  const answer = await say(rig, LINE);
  assert.equal(answer.status, 'ok', answer.text);
  assert.equal(answer.text.includes('lantern'), false);
});

test('an id that names no entry is refused with the code unknown-entry', async () => {
  // Bug: a mistyped id answers ok and the owner believes the entry is gone.
  const rig = await removalScene();
  const answer = await say(rig, '/memory selfreflection remove entry-nowhere');
  assert.notEqual(answer.status, 'ok');
  assert.equal(answer.code, 'unknown-entry');
});

test('a console with no port refuses a published entry as interface-down and keeps it', async () => {
  // Bug: a core wired without the port removes memory and leaves every post on the platform.
  const rig = await removalScene();
  const seeded = await rig.published({ id: 'entry-north-pier' });
  const answer = await say(rig, LINE, null);
  assert.notEqual(answer.status, 'ok');
  assert.equal(answer.code, 'interface-down');
  assert.equal(entryRows(rig, seeded.entryId), 1);
});

test('a delete the platform refuses is answered with delete-failed and the platform code named', async () => {
  // Bug: the owner is told it failed with no word of why, and cannot tell a rate limit from a missing right.
  const rig = await removalScene();
  const seeded = await rig.published({ id: 'entry-north-pier' });
  rig.script(() => ({ status: 'failed', error: { code: 'rate-limited', retryable: true, retryAfterMs: 1000 } }));
  const answer = await say(rig, LINE);
  assert.equal(answer.code, 'delete-failed');
  assert.ok(answer.text.includes('rate-limited'), answer.text);
  assert.equal(entryRows(rig, seeded.entryId), 1);
});

test("the removal is reached from the owner's chat and from no agent or interface", async () => {
  // Bug: a worker on the board or a chat platform names the command and removes her diary.
  const rig = await removalScene();
  const seeded = await rig.published({ id: 'entry-north-pier' });
  const deps: CommandDeps = {
    console: consoleOf(rig, rig.port),
    interfaces: { list: () => [], enable: () => {}, disable: () => Promise.resolve({ drained: 0, unknown: 0 }) },
    facts: () => {
      throw new Error('the removal reads no status');
    },
    tasks: { command: () => Promise.resolve({ text: 'no such board command', status: 'invalid', data: null }) },
  };
  const commands = createCommandDesk(deps);
  const event = {
    name: 'memory.selfreflection.remove',
    args: { id: seeded.entryId },
    conversation: { id: 'cli:dm:owner' },
    requester: { id: 'owner', roles: [] },
  };
  const agent = await commands.run(event, { kind: 'agent', name: 'dev' });
  const platform = await commands.run(event, { kind: 'interface', name: 'discord' });
  assert.notEqual(agent.status, 'ok');
  assert.equal(platform.status, 'denied');
  assert.equal(entryRows(rig, seeded.entryId), 1);
  assert.deepEqual(rig.deletes, []);
  const owner = await commands.run(event, { kind: 'cli', name: 'cli' });
  assert.equal(owner.status, 'ok', owner.text);
  assert.equal(entryRows(rig, seeded.entryId), 0);
});

test('no operation of the persona removes a selfreflection entry', () => {
  // Bug: the removal registered as an operation becomes a tool she can be granted, or a member's /nep command.
  const ops = JSON.stringify(listOps());
  assert.equal(ops.includes('selfreflection.remove'), false);
  assert.equal(ops.includes('removeSelfreflectionEntry'), false);
});
