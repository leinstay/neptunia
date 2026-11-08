// An agent files a skill and has no activation command: `skill.pending <name>` checks a complete package under
// `data/skills/<name>/`, and the link lets no agent's `skill.activate` through. Her done task activates what it bound
// (tests/skills-task-activation.test.ts), and the owner's activation of a filed package runs its scripts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { skillCommand } from '../src/skills/agent-commands.ts';
import { snapshotDir, scriptManifest } from '../src/skills/package.ts';
import { runSkillScript } from '../src/skills/run.ts';
import { createEventDoor } from '../src/interface/door.ts';
import { openAdapterLink } from '../src/interface/link.ts';
import { createLoopback, envelope } from '../src/protocol/index.ts';
import { CLI_CLIENT, runCli, spawnCli, startUnitsCore, until, withRig } from './fixtures/core-units.ts';
import type { Dirs } from './fixtures/core-units.ts';
import { skillText, skillsRig } from './fixtures/skills-rig.ts';
import { tempDir } from './fixtures/tmp.ts';

const HAND = { name: 'hand' };
const SILENT = { info() {}, warn() {}, error() {}, debug() {} };
const SCRIPT = "process.stdout.write(JSON.stringify({ ok: true, text: 'filed-script-ran' }));\n";
const SETUP = { scripts: { 'say.mjs': { args: {}, credentials: [] } } };

function writePackage(
  dir: string,
  name: string,
  options: { setup?: string | null; script?: string | null; text?: string } = {}
): void {
  const { setup = JSON.stringify(SETUP), script = SCRIPT, text = skillText(name, 'd', ['skill.run']) } = options;
  const root = path.join(dir, name);
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(root, 'SKILL.md'), text);
  if (setup !== null) fs.writeFileSync(path.join(root, 'setup.json'), setup);
  if (script !== null) fs.writeFileSync(path.join(root, 'scripts', 'say.mjs'), script, { mode: 0o755 });
}

test("the owner's activation of a filed package runs its script, and filing alone activates nothing", async (t) => {
  // Bug: filing activates by itself, or the filed bytes never reach the snapshot `skill.run` executes.
  const rig = skillsRig(t);
  writePackage(rig.folders.localDir, 'say-it');
  const filed = skillCommand(rig.port, HAND, 'skill.pending', { name: 'say-it' });
  assert.equal(filed.status, 'ok', filed.text);
  assert.equal(rig.port.active().length, 0);

  const done = rig.port.activate('say-it', 'owner');
  assert.ok(done.ok);
  assert.equal(rig.port.active().length, 1);
  const hash = rig.port.list()[0]?.active?.contentHash ?? '';
  const packageDir = snapshotDir(path.join(rig.folders.localDir, 'say-it'), hash);
  assert.ok(scriptManifest(packageDir, 'say.mjs'));
  const run = await runSkillScript({
    name: 'say-it',
    script: 'say.mjs',
    packageDir,
    dataDir: tempDir('nep-filing-data-'),
    args: {},
    credentials: {},
    timeoutMs: 20000,
    maxOutputBytes: 100000,
    runId: 'run-1',
  });
  assert.equal(run.text, 'filed-script-ran');
});

for (const [label, options, code] of [
  ['a setup.json that does not parse', { setup: '{ nope' }, 'bad-setup'],
  ['a declared script with no file', { script: null }, 'missing-script'],
  ['a script setup.json does not declare', { setup: null }, 'undeclared-script'],
  ['a SKILL.md that does not parse', { text: 'no front matter' }, 'no-front-matter'],
] as const) {
  test(`${label} is refused at filing and never waits for an activation`, (t) => {
    // Bug: a package that cannot run reaches the owner as a pending version, and activating it fails only later.
    const rig = skillsRig(t);
    writePackage(rig.folders.localDir, 'half-done', options);
    const filed = skillCommand(rig.port, HAND, 'skill.pending', { name: 'half-done' });
    assert.equal(filed.status, 'invalid');
    assert.ok(filed.text.includes(code), filed.text);
    assert.equal(rig.port.pending().length, 0);
  });
}

test('filing a name with no package fails, and a name that is no skill name reads no folder', (t) => {
  // Bug: a missing folder answers ok, so the agent reports a skill that does not exist.
  const rig = skillsRig(t);
  assert.equal(skillCommand(rig.port, HAND, 'skill.pending', { name: 'ghost' }).status, 'failed');
  assert.equal(skillCommand(rig.port, HAND, 'skill.pending', { name: '../ghost' }).status, 'invalid');
});

test("the link refuses an agent's skill.activate by name and lets its filing past that check", async () => {
  // Bug: a prefix check on `skill.` opens activation to the agents along with filing.
  const door = createEventDoor({ handlers: {}, log: SILENT });
  const ends = createLoopback();
  const principal = { name: 'hand', kind: 'agent' as const, iface: 'agent', permissions: [] };
  const link = openAdapterLink({
    transport: ends.core,
    door,
    principalOf: (token: string) => (token === 'hand-token' ? principal : null),
    log: SILENT,
  });
  const acks = new Map<string, { status?: string; reason?: string }>();
  ends.client.onEnvelope((value) => {
    if (value.type === 'ack' && value.replyTo !== null) acks.set(value.replyTo, value.body);
  });
  ends.client.send(
    envelope(
      'hello',
      { iface: 'agent', self: { id: 'hand', name: 'hand' }, root: null, kind: 'agent', token: 'hand-token' },
      { id: 'hello:hand' }
    )
  );
  await link.hello;
  const command = (id: string, name: string) =>
    ends.client.send(
      envelope(
        'event',
        {
          kind: 'command.requested',
          iface: 'agent',
          at: 1,
          id,
          chat: { id: 'c1', kind: 'channel' },
          name,
          args: { name: 'say-it' },
          replyRef: 'r1',
          requester: { id: 'hand', name: 'hand', roles: [], owner: false },
        },
        { id }
      )
    );
  command('activate', 'skill.activate');
  command('file', 'skill.pending');
  await until(() => acks.has('activate') && acks.has('file'), 'both answers');
  assert.equal(acks.get('activate')?.reason, 'body.name:not-allowed');
  assert.notEqual(acks.get('file')?.reason, 'body.name:not-allowed');
  link.close();
});

async function task(dirs: Dirs, args: ReadonlyArray<string>) {
  const token = fs.readFileSync(path.join(dirs.privateDir, 'clients', 'hand.token'), 'utf8').trim();
  const cli = spawnCli(dirs, ['tasks', ...args], { NEPTUNIA_TASK_TOKEN: token });
  cli.end();
  const exit = await cli.exited;
  return { code: exit.code, out: cli.stdout() + cli.stderr() };
}

test('over the socket an agent files a package and cannot activate it, and the owner can', async () => {
  // Bug: the link refuses the agent's filing as it refuses every non-task command, or lets its activation through.
  const clients = [CLI_CLIENT, { name: 'hand', kind: 'agent' as const, roles: ['worker'] }];
  await withRig({ clients }, async ({ dirs, llm, cores }) => {
    cores.push(await startUnitsCore(dirs, llm));
    writePackage(path.join(dirs.privateDir, 'skills'), 'say-it');
    const filed = await task(dirs, ['skill-pending', 'say-it']);
    assert.equal(filed.code, 0, filed.out);
    const raw = await task(dirs, ['skill-activate', 'say-it']);
    assert.equal(raw.code, 2, 'the command line has no such command');
    const owner = await runCli(dirs, ['-p', '/skills activate say-it']);
    assert.equal(owner.code, 0, owner.stdout + owner.stderr.slice(-1000));
    const listed = await runCli(dirs, ['-p', '/skills list']);
    assert.ok(listed.stdout.includes('say-it'), listed.stdout);
    assert.equal(listed.stdout.includes('agent:hand'), false, listed.stdout);
  });
});
