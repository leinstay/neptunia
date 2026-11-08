// The skills wiring of the core (src/skills/wiring.ts): her active skills for the tools array, the use rows and
// the sources of the selfimprovement wake. A real in-memory memory database behind the writer's `applySkillsWrite`,
// real temporary skill folders, her grants as the config states them and a fake board.
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../src/tools/operations/index.ts';
import { openMemoryDb } from '../src/memory/db/open.ts';
import { applySkillsWrite } from '../src/memory/db/skills.ts';
import type { SkillsUpdate } from '../src/memory/db/skills.ts';
import { wireSkills } from '../src/skills/wiring.ts';
import type { SkillsWiringDeps } from '../src/skills/wiring.ts';
import { skillText, SKILLS_T0 } from './fixtures/skills-rig.ts';
import { tempDir } from './fixtures/tmp.ts';

const SELF = 'bot-1';
const LABELS = { skills: { index: 'Skills you can read:', line: '- {name}: {description}' } };
const LOOK = skillText('look-it-up', 'I check the web before I answer a fact', ['web.read', 'web.search']);

type Call = { principal: string; op: string; args: Readonly<Record<string, unknown>> | undefined };

function rig(
  t: { after: (fn: () => void) => void },
  options: { grants?: ReadonlyArray<string>; labels?: unknown } = {}
) {
  const rootDir = tempDir('nep-wire-root-');
  const privateDir = tempDir('nep-wire-private-');
  const handle = openMemoryDb(':memory:');
  t.after(() => handle.close());
  const state = {
    open: true,
    clock: SKILLS_T0,
    config: accessFor(options.grants ?? ['skill.read', 'web.read', 'web.search']),
    prompts: { labels: options.labels ?? LABELS } as unknown,
  };
  const calls: Array<Call> = [];
  const warnings: Array<string> = [];
  const hot = {
    get config() {
      return state.config;
    },
    get prompts() {
      return state.prompts;
    },
  };
  const deps: SkillsWiringDeps = {
    hot,
    memoryDb: {
      memoryWrite: (update: SkillsUpdate) =>
        state.open
          ? Promise.resolve(applySkillsWrite(handle, update))
          : Promise.reject(new Error('memory database is not open')),
      database: () => (state.open ? handle.db : null),
    },
    board: {
      call: (principal: string, op: string, args?: Readonly<Record<string, unknown>>) => {
        calls.push({ principal, op, args });
        return Promise.resolve((op === 'task.list' || op === 'outbox.pull' ? [] : {}) as never);
      },
    },
    selfId: () => SELF,
    rootDir,
    privateDir,
    now: () => state.clock,
    log: { warn: (message) => warnings.push(message) },
  };
  const write = (name: string, text: string): void => {
    fs.mkdirSync(path.join(privateDir, 'skills', name), { recursive: true });
    fs.writeFileSync(path.join(privateDir, 'skills', name, 'SKILL.md'), text);
  };
  return { wiring: wireSkills(deps), state, calls, warnings, write, rootDir, handle };
}

function accessFor(names: ReadonlyArray<string>) {
  return { bot: { access: Object.fromEntries(names.map((name) => [name, { users: [SELF] }])) } };
}

// Slice 8 of the turn frame: the index of her skills (`index`, the body of `<skills>`) became `active`, the list the tools
// array is built from. The grant of `skill.read` that gated the index is checked where the array is built
// (src/turn/phases/request/build.ts), so the two tests of that grant left this file with the labels case.
test('active gives an active skill with its tools and the version that was activated', async (t) => {
  const r = rig(t);
  r.write('look-it-up', LOOK);
  await r.wiring.access.activate('look-it-up', 'agent:hand');
  const active = await r.wiring.active();
  assert.deepEqual(
    active.map(({ name, tools, missing }) => ({ name, tools, missing })),
    [{ name: 'look-it-up', tools: ['web.read', 'web.search'], missing: [] }]
  );
  assert.match(active[0]?.versionId ?? '', /\S/);
});

test('a pending file is not active until somebody activates it', async (t) => {
  // Catches a list built from the files on disk instead of the active versions.
  const r = rig(t);
  r.write('look-it-up', LOOK);
  assert.deepEqual(await r.wiring.active(), []);
  assert.equal((await r.wiring.access.pending()).length, 1);
});

test('a skill with a tool she was not granted names the tool as missing, so it gets no entry', async (t) => {
  const r = rig(t, { grants: ['skill.read', 'web.read'] });
  r.write('look-it-up', LOOK);
  r.write('read-only', skillText('read-only', 'I only read pages', ['web.read']));
  await r.wiring.access.activate('look-it-up', 'agent:hand');
  await r.wiring.access.activate('read-only', 'agent:hand');
  const active = await r.wiring.active();
  assert.deepEqual(
    active.map((one) => [one.name, one.missing.map((missing) => missing.tool)]),
    [
      ['look-it-up', ['web.search']],
      ['read-only', []],
    ]
  );
});

test('no active skill gives an empty list', async (t) => {
  const none = rig(t);
  assert.deepEqual(await none.wiring.active(), []);
});

test('a list that fails to read answers none and logs a warning instead of throwing into the turn', async (t) => {
  const r = rig(t);
  r.write('look-it-up', LOOK);
  await r.wiring.access.activate('look-it-up', 'agent:hand');
  r.state.config = {
    get bot(): never {
      throw new Error('config unreadable');
    },
  };
  assert.deepEqual(await r.wiring.active(), []);
  assert.equal(r.warnings.length, 1);
});

test('record writes the rows of a turn and gives 0 once the database is closed', async (t) => {
  const r = rig(t);
  r.write('look-it-up', LOOK);
  await r.wiring.access.activate('look-it-up', 'agent:hand');
  const versionId = (await r.wiring.access.active())[0]?.versionId ?? '';
  const uses = [{ skill: 'look-it-up', versionId, turnId: 'turn-1', kind: 'read' as const, at: SKILLS_T0 }];
  assert.equal(await r.wiring.record(uses), 1);
  r.state.open = false;
  assert.equal(await r.wiring.record(uses), 0);
});

test('the wake sources give her granted tools sorted and the uses of the window per skill', async (t) => {
  const r = rig(t);
  r.write('look-it-up', LOOK);
  r.write('idle', skillText('idle', 'I am never used', ['web.read']));
  await r.wiring.access.activate('look-it-up', 'agent:hand');
  const versionId = (await r.wiring.access.active())[0]?.versionId ?? '';
  const day = 86_400_000;
  await r.wiring.record([
    { skill: 'look-it-up', versionId, turnId: 'old', kind: 'read', at: SKILLS_T0 - 10 * day },
    { skill: 'look-it-up', versionId, turnId: 'new', kind: 'read', at: SKILLS_T0 },
    { skill: 'look-it-up', versionId, turnId: 'new', kind: 'tried', at: SKILLS_T0 },
  ]);
  const { granted, skills } = r.wiring.selfimprovement;
  assert.deepEqual(granted?.(), ['skill.read', 'web.read', 'web.search']);
  const rows = skills?.(SKILLS_T0 - day) ?? [];
  const look = rows.find((row) => row.name === 'look-it-up');
  assert.equal(look?.active, true);
  assert.equal(look?.counts.read, 1, 'the use before the window is not counted');
  assert.equal(look?.counts.tried, 1);
  const idle = rows.find((row) => row.name === 'idle');
  assert.equal(idle?.active, false, 'a skill nobody activated is listed as not active');
  assert.deepEqual(Object.values(idle?.counts ?? {}), [0, 0, 0, 0, 0, 0]);
});

test('a disabled skill is listed not active in the wake sources', async (t) => {
  const r = rig(t);
  r.write('look-it-up', LOOK);
  await r.wiring.access.activate('look-it-up', 'agent:hand');
  await r.wiring.access.disable('look-it-up', 'persona');
  const rows = r.wiring.selfimprovement.skills?.(0) ?? [];
  assert.equal(rows.find((row) => row.name === 'look-it-up')?.active, false);
});

test('with the database closed the wake sources list no skills', (t) => {
  const r = rig(t);
  r.state.open = false;
  assert.deepEqual(r.wiring.selfimprovement.skills?.(0), []);
});

// The mark names the rows shown: a cursor at the newest also marked a row between them she never saw.
test('the board sources call as persona: proposals list her own tasks and ackOutbox marks exactly the rows shown', async (t) => {
  const r = rig(t);
  const found = await r.wiring.selfimprovement.proposals?.();
  assert.deepEqual(found, { entries: [], outbox: [] });
  assert.deepEqual(r.calls[0], { principal: 'persona', op: 'task.list', args: { requester: 'persona:self' } });
  await r.wiring.selfimprovement.ackOutbox?.([3, 7, 5]);
  const ack = r.calls.at(-1);
  assert.equal(ack?.principal, 'persona');
  assert.equal(ack?.op, 'outbox.pull');
  assert.deepEqual(ack?.args?.ack_seqs, [3, 7, 5]);
  const before = r.calls.length;
  await r.wiring.selfimprovement.ackOutbox?.([]);
  assert.equal(r.calls.length, before, 'no rows shown, no call');
});
