// src/setup/mechanics.ts: the mechanics step of `neptunia setup`. It asks on or off for `heartbeat` and `diary`
// and stores the answers in the local config. The terminal is a fake; the private folder is a temp dir and the tracked
// layer is this checkout's. Each test names the bug it catches.
// Changed: the selfimprovement switch, its schedule and its gh and repository checks left the step with the mechanic.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mechanicsStep } from '../src/setup/mechanics.ts';
import type { MechanicsStepDeps } from '../src/setup/mechanics.ts';
import { tempDir } from './fixtures/tmp.ts';

const ROOT = path.join(import.meta.dirname, '..');

type Section = Record<string, unknown>;
type Rig = {
  options: { rootDir: string; privateDir: string };
  deps: MechanicsStepDeps;
  answers: Array<string>;
  asked: Array<{ question: string; offered: string | null }>;
};

const configFile = (privateDir: string): string => path.join(privateDir, 'config', 'config.json');
const local = (privateDir: string): Record<string, Section> =>
  JSON.parse(fs.readFileSync(configFile(privateDir), 'utf8')) as Record<string, Section>;

/** A private folder with `config` as its local config. */
function rig(config: Record<string, unknown> = {}): Rig {
  const privateDir = path.join(tempDir('nep-setup-mechanics-'), 'private');
  fs.mkdirSync(path.join(privateDir, 'config'), { recursive: true });
  fs.writeFileSync(configFile(privateDir), JSON.stringify({ bot: { name: 'kept' }, ...config }));
  const r: Rig = {
    options: { rootDir: ROOT, privateDir },
    answers: [],
    asked: [],
    deps: {
      ask: (question, offered) => {
        r.asked.push({ question, offered });
        return Promise.resolve(r.answers.shift() ?? '');
      },
    },
  };
  return r;
}

test('both on stores each switch', async () => {
  // Catches: the step asks but writes nothing.
  const r = rig({ heartbeat: { enabled: false }, diary: { enabled: false } });
  r.answers = ['on', 'on'];
  const outcome = await mechanicsStep(r.options, r.deps);
  const config = local(r.options.privateDir);
  assert.equal(outcome.state, 'done');
  assert.equal(config.heartbeat?.enabled, true);
  assert.equal(config.diary?.enabled, true);
});

test("storing the switches keeps the owner's other settings", async () => {
  // Catches: the step writes a fresh config.json and wipes what the steps before it stored.
  const r = rig();
  r.answers = ['off', 'off'];
  await mechanicsStep(r.options, r.deps);
  assert.deepEqual(local(r.options.privateDir).bot, { name: 'kept' });
});

test('off answers store false, so a tracked default of on does not win', async () => {
  // Catches: an off answer is left out of the local config, and the tracked `enabled: true` keeps the mechanic ticking.
  const r = rig();
  r.answers = ['off', 'off'];
  await mechanicsStep(r.options, r.deps);
  const config = local(r.options.privateDir);
  assert.deepEqual([config.heartbeat?.enabled, config.diary?.enabled], [false, false]);
});

test('each question offers the value in force, so an empty answer keeps it', async () => {
  // Catches: every question offers "on", and pressing Enter through setup switches on a mechanic the owner had off.
  const r = rig({ heartbeat: { enabled: false } });
  r.answers = ['', 'off'];
  await mechanicsStep(r.options, r.deps);
  assert.equal(r.asked[0]?.offered, 'off');
  assert.equal(local(r.options.privateDir).heartbeat?.enabled, false);
});

test('a rerun that changes nothing is already done and leaves the file as it was', async () => {
  // Catches: every rerun rewrites config.json, so the step never reports already and the live-config drift check fires.
  const r = rig({ heartbeat: { enabled: true }, diary: { enabled: false } });
  const before = fs.readFileSync(configFile(r.options.privateDir), 'utf8');
  r.answers = ['', ''];
  const outcome = await mechanicsStep(r.options, r.deps);
  assert.equal(outcome.state, 'already');
  assert.equal(fs.readFileSync(configFile(r.options.privateDir), 'utf8'), before);
});
