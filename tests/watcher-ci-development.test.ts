// Where the CI summary goes: into the facts of development mode (`developmentFacts`), onto the lines of the section
// `Development` (`stampDevelopment`), and nowhere else. The evidence page of the agent no longer asks `gh` for CI, so an
// install without development reads none, and the agent child never holds the login. `gh` is a fake.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readConfig } from '../src/config.ts';
import { localConfigPath } from '../src/config/files.ts';
import { openMemoryDb } from '../src/memory/db/open.ts';
import { serviceFamily } from '../src/service/commands.ts';
import { developmentFacts, stampDevelopment } from '../src/watcher/development.ts';
import type { DevelopmentFacts, DevelopmentMode } from '../src/watcher/development.ts';
import * as reports from '../src/watcher/report.ts';
import { FACTS, devAnswer, sectionText, subsectionText } from './fixtures/watcher-development-rig.ts';
import { tempDir } from './fixtures/tmp.ts';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const NOW = Date.parse('2026-11-06T00:00:00Z');
const DAY = 86_400_000;
const iso = (at: number): string => new Date(at).toISOString();
const MODE: Extract<DevelopmentMode, { on: true }> = {
  on: true,
  checkout: tempDir('nep-ci-checkout-'),
  repository: 'example/engine',
  base: 'trunk',
};

type Call = { command: string; args: ReadonlyArray<string> };

/** A `gh` that lists two runs of `main` and gives each a 260 s shard, and answers nothing else. */
function ghRun(calls: Array<Call>, working = true) {
  return (command: string, args: ReadonlyArray<string>): Promise<{ code: number; stdout: string }> => {
    calls.push({ command, args });
    if (command !== 'gh' || !working) return Promise.resolve({ code: 1, stdout: '' });
    if (args[0] === 'pr') return Promise.resolve({ code: 0, stdout: '[]' });
    if (args[0] === 'run' && args[1] === 'list') {
      const runs = [1, 2].map((id) => ({
        databaseId: id,
        headBranch: 'main',
        status: 'completed',
        conclusion: 'success',
        createdAt: iso(NOW - id * DAY),
      }));
      return Promise.resolve({ code: 0, stdout: JSON.stringify(runs) });
    }
    if (args[0] === 'run' && args[1] === 'view' && !args.includes('--log')) {
      const job = {
        databaseId: 9,
        name: 'tests (1)',
        status: 'completed',
        conclusion: 'success',
        startedAt: iso(NOW - DAY),
        completedAt: iso(NOW - DAY + 260_000),
      };
      return Promise.resolve({ code: 0, stdout: JSON.stringify({ jobs: [job] }) });
    }
    return Promise.resolve({ code: 1, stdout: '' });
  };
}

const factsOver = (run: ReturnType<typeof ghRun>) =>
  developmentFacts({ mode: MODE, run, readMemory: () => null, now: () => NOW });

test('the facts of the mode carry the CI summary, asked of the configured repository', async () => {
  // Bug: the CI is read from the repository of whatever folder the worker stands in, not the one development files against.
  const calls: Array<Call> = [];
  const facts = await factsOver(ghRun(calls));
  // R.2: the week gets a name, so the assertions read three segments deep.
  const thisWeek = facts.ci?.thisWeek;
  assert.equal(thisWeek?.runs, 2);
  assert.equal(thisWeek?.nearLimit, 2);
  const ci = calls.filter((one) => one.args[0] === 'run');
  assert.ok(ci.length >= 3, 'a list and a view per run');
  for (const call of ci) assert.equal(call.args[call.args.indexOf('--repo') + 1], 'example/engine');
});

test('`gh` failing gives a null summary and null pull requests, and the facts still come', async () => {
  // Bug: a logged-out `gh` throws out of the facts and the whole section turns into `development facts unavailable`.
  const facts = await factsOver(ghRun([], false));
  assert.equal(facts.ci, null);
  assert.equal(facts.pullRequests, null);
});

const stamped = (facts: DevelopmentFacts): string => stampDevelopment(devAnswer(), { on: true, facts });
const inspected = (text: string): string =>
  subsectionText(sectionText(text, 'Development'), 'Inspected without a finding');
const unavailable = (text: string): string => subsectionText(sectionText(text, 'Development'), 'Unavailable checks');

test('the section holds the CI lines of the summary, and the report still passes', async () => {
  // Bug: the summary is read and falls out of the section, or its lines break the template.
  const facts = await factsOver(ghRun([]));
  const text = stamped(facts);
  assert.match(inspected(text), /last 7 days.*2 runs.*2 shards.*2 near the 5-minute limit/);
  assert.ok(reports.checkTemplate(text, { development: true }).ok);
  assert.deepEqual(reports.findingLines(text), []);
});

test('a null summary puts `CI runs unavailable` under the unavailable checks and no count in the section', () => {
  // Bug: B12.5's rule for pull requests, held for CI: a dead `gh` is never a count.
  const text = stamped({ ...FACTS, ci: null });
  assert.match(unavailable(text), /CI runs unavailable/);
  assert.doesNotMatch(inspected(text), /last 7 days/);
});

test('facts with no CI field at all add no CI line anywhere', () => {
  // Bug: the older facts of a caller that never asked for CI are reported as unavailable CI.
  const text = stamped(FACTS);
  assert.doesNotMatch(inspected(text), /last 7 days/);
  assert.doesNotMatch(unavailable(text), /CI runs/);
});

// ---------- the agent's evidence reads no CI ----------

async function evidenceCalls(
  config: Record<string, unknown>
): Promise<{ calls: Array<Call>; page: Record<string, unknown> }> {
  const data = tempDir('nep-ci-evidence-');
  fs.mkdirSync(path.dirname(localConfigPath(data)), { recursive: true });
  fs.writeFileSync(localConfigPath(data), JSON.stringify(config));
  fs.mkdirSync(path.join(data, 'agents', 'watcher', 'reports'), { recursive: true });
  openMemoryDb(path.join(data, 'memory.db')).close();
  const calls: Array<Call> = [];
  const answer = await serviceFamily(
    {
      rootDir: REPO,
      privateDir: data,
      dataDir: data,
      config: () => readConfig(REPO, { privateDir: data }),
      now: () => NOW,
      env: { NEPTUNIA_UNIT_SCOPE: 'user', XDG_CONFIG_HOME: data },
      coreUp: false,
      run: ghRun(calls),
    },
    'service.watcher.evidence',
    {}
  );
  assert.equal(answer.status, 'ok', answer.text.slice(0, 200));
  return { calls, page: JSON.parse(answer.text) as Record<string, unknown> };
}

for (const [name, config] of [
  ['without development', {}],
  ['with development configured', { selfimprovement: { checkout: '/srv/dev-checkout', repository: 'example/engine' } }],
] as const) {
  test(`the evidence page ${name} makes no gh call and holds no ci field`, async () => {
    // Bug: the CI the owner wants only in development mode is read by the agent's own command in every install, with
    // whatever login that child finds.
    const { calls, page } = await evidenceCalls(config);
    assert.deepEqual(
      calls.filter((one) => one.command === 'gh'),
      []
    );
    assert.equal('ci' in page, false);
  });
}
