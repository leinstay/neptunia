// The core's `skills.settle` beat (src/core.ts, src/skills/wiring.ts#settle): on the scheduler's clock, every
// `board.reapSeconds`, it activates the skill version a done task of hers bound and marks the task with one
// `skill-activation` comment. The core runs in the test process as the units run it (tests/fixtures/core-units.ts), with
// the board over the socket: she files the task, a worker binds the package folder with `skill.pending { name, task }`
// and submits, the owner accepts. Nothing activates by the worker's or the owner's hand, so the beat is the only way the
// version can become active. No interface and no model is involved.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { coreSocketPath } from '../src/interface/socket.ts';
import type { TaskRecord, TaskView } from '../src/board/board.ts';
import { query, startUnitsCore, withRig } from './fixtures/core-units.ts';
import type { Client } from './fixtures/core-units.ts';
import { connectAgent } from './fixtures/agent-client.ts';
import type { AgentAnswer, AgentClient } from './fixtures/agent-client.ts';
import { skillText } from './fixtures/skills-rig.ts';

const T0 = Date.parse('2026-11-05T12:00:00Z');
const CONFIG = { board: { leaseTtlMinutes: 30, reapSeconds: 1, briefWaitMs: 1800000 } };
const CLIENTS: ReadonlyArray<Client> = [
  { name: 'her', kind: 'agent', roles: ['persona'] },
  { name: 'boss', kind: 'agent', roles: ['owner', 'reviewer'] },
  { name: 'hand', kind: 'agent', roles: ['worker'] },
];
const HANDOFF = {
  result: 'The skill folder is filed.',
  evidence: ['skill.pending named the version'],
  artifacts: ['skills/say-hello'],
  tests: [{ command: 'node --test tests/skills.test.ts', passed: 3, failed: 0 }],
  open_issues: [],
};
const SCRIPT = "process.stdout.write(JSON.stringify({ ok: true, text: 'one' }));\n";
const SETUP = JSON.stringify({ scripts: { 'say.mjs': { args: {}, credentials: [] } } });

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

function ok(answer: AgentAnswer): AgentAnswer {
  assert.equal(answer.status, 'ok', `${answer.status}: ${answer.text}`);
  return answer;
}

function taskOf(answer: AgentAnswer): TaskRecord {
  ok(answer);
  assert.ok(isRecord(answer.data) && typeof answer.data.id === 'string', 'the answer carries a task');
  // The JSON of a task answer is the board's TaskRecord.
  return answer.data as TaskRecord;
}

async function shown(agent: AgentClient, id: string): Promise<TaskView> {
  const answer = ok(await agent.ask('task.show', { id }));
  assert.ok(isRecord(answer.data) && isRecord(answer.data.task), 'the answer carries a view');
  // The JSON of a task.show answer is the board's TaskView.
  return answer.data as TaskView;
}

const tokenOf = (privateDir: string, name: string): string =>
  readFileSync(join(privateDir, 'clients', `${name}.token`), 'utf8').trim();

test('the settle beat activates the version her done skill task bound and marks the task once', async () => {
  await withRig({ config: CONFIG, clients: CLIENTS }, async ({ dirs, llm, cores }) => {
    const root = join(dirs.privateDir, 'skills', 'say-hello');
    mkdirSync(join(root, 'scripts'), { recursive: true });
    writeFileSync(join(root, 'SKILL.md'), skillText('say-hello', 'Says hello.', ['skill.run'], 'Steps.'));
    writeFileSync(join(root, 'setup.json'), SETUP);
    writeFileSync(join(root, 'scripts', 'say.mjs'), SCRIPT, { mode: 0o755 });
    cores.push(await startUnitsCore(dirs, llm, () => T0));
    const agents: Array<AgentClient> = [];
    const connect = async (name: string): Promise<AgentClient> => {
      const agent = await connectAgent(coreSocketPath(dirs.dataDir), name, tokenOf(dirs.privateDir, name));
      agents.push(agent);
      return agent;
    };
    try {
      const her = await connect('her');
      const boss = await connect('boss');
      const hand = await connect('hand');
      const filed = taskOf(
        await her.ask('task.add', {
          title: 'Learn to say hello',
          lane: 'dev',
          project: 'core',
          requester: 'persona:self',
          subscriber: 'persona:self',
          metadata: { kind: 'skill' },
        })
      );
      ok(
        await boss.ask('task.transition', {
          id: filed.id,
          status: 'triaged',
          revision: filed.revision,
          set: { role: 'dev', estimate: 30, budget: 4, risk: 'low' },
        })
      );
      ok(await boss.ask('task.approve', { id: filed.id, scope: 'plan' }));
      const held = taskOf(await hand.ask('task.next', { lane: 'dev', role: 'dev' }));
      assert.equal(held.id, filed.id);
      ok(await hand.ask('skill.pending', { name: 'say-hello', task: held.id }));
      ok(await hand.ask('task.submit', { id: held.id, generation: held.lease_generation, handoff: HANDOFF }));
      const submitted = await shown(boss, held.id);
      ok(await boss.ask('task.update', { id: held.id, revision: submitted.task.revision, metadata: { ci: 'green' } }));
      ok(await boss.ask('task.review', { id: held.id, decision: 'accept' }));
      assert.equal((await shown(boss, held.id)).task.status, 'done');
      const marks = async (): Promise<Array<string>> =>
        (await shown(boss, held.id)).comments
          .map((one) => one.text)
          .filter((text) => text.startsWith('skill-activation'));
      let seen: Array<string> = [];
      for (let tries = 0; tries < 80 && seen.length === 0; tries += 1) {
        seen = await marks();
        if (seen.length === 0) await new Promise((resolve) => setTimeout(resolve, 100));
      }
      assert.equal(seen.length, 1);
      assert.match(seen[0] ?? '', /^skill-activation activated /);
      const active = query(
        dirs,
        'SELECT s.name AS name, v.status AS status FROM skills s JOIN skill_versions v ON v.id = s.active_version'
      );
      assert.deepEqual(active, [{ name: 'say-hello', status: 'active' }]);
      await new Promise((resolve) => setTimeout(resolve, 2500));
      assert.equal((await marks()).length, 1, 'a later beat marks it no second time');
    } finally {
      for (const agent of agents) agent.close();
    }
  });
});
