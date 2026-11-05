// What the watcher knows of the install it runs from (src/watcher/install.ts), for `Project` and `Modules and structure`. It
// reads the running install only: a public install has no development checkout, so the prompt and the brief name none, and a
// missing `.git` is an unavailable check. Synthetic folders and a fake git; no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { buildBrief } from '../src/watcher/brief.ts';
import { openMemoryDb } from '../src/memory/db/open.ts';
import { installFacts } from '../src/watcher/install.ts';
import { answerOf, inspectionDeps, inspectionRig, said } from './fixtures/watcher-inspection-rig.ts';
import { tempDir } from './fixtures/tmp.ts';
import { watcherDirs } from './fixtures/watcher-rig.ts';

const CHECKOUT = /checkout/i;
const NO_GIT = (): string => assert.fail('git is not asked with no .git');

function install(withGit: boolean): { rootDir: string; dataDir: string } {
  const rootDir = tempDir('nep-install-');
  fs.mkdirSync(path.join(rootDir, 'src', 'watcher'), { recursive: true });
  fs.mkdirSync(path.join(rootDir, 'interfaces', 'chat'), { recursive: true });
  fs.writeFileSync(path.join(rootDir, 'package.json'), JSON.stringify({ dependencies: { typescript: '6.0.0' } }));
  fs.writeFileSync(
    path.join(rootDir, 'interfaces', 'chat', 'package.json'),
    JSON.stringify({ dependencies: { 'chat-sdk': '1.2.3' } })
  );
  if (withGit) fs.mkdirSync(path.join(rootDir, '.git'));
  return { rootDir, dataDir: tempDir('nep-install-data-') };
}

test('the prompt names no development checkout', () => {
  // Bug: the prompt sends the agent to a folder a public install does not have, and every report fails or invents.
  const prompt = fs.readFileSync(new URL('../agents/watcher/prompt.md', import.meta.url), 'utf8');
  assert.doesNotMatch(prompt, CHECKOUT);
});

test('the brief of a run names no development checkout, whatever the install holds', () => {
  // Bug: a setting's path reaches the brief, and the watcher reports on code that is not running.
  const { reportsDir } = watcherDirs();
  const brief = buildBrief({
    prompt: 'P',
    day: '2026-11-04',
    reportsDir,
    install: installFacts({ ...install(false), git: NO_GIT }),
  });
  assert.doesNotMatch(brief, CHECKOUT);
});

test('a missing .git gives an unavailable check, in the brief too, and never asks git', async () => {
  // Bug: an install from a package reads as "no divergence", or git is run in a parent repository.
  const { runInspection } = await import('../src/watcher/inspection.ts');
  const facts = installFacts({ ...install(false), git: NO_GIT });
  assert.equal(facts.revision, null);
  assert.equal(facts.divergence, null);
  assert.ok(facts.unavailable.includes('no-git'));
  const rig = inspectionRig();
  const briefs: Array<string> = [];
  await runInspection(
    inspectionDeps(rig, {
      install: () => facts,
      runAgent: (brief) => {
        briefs.push(brief);
        return Promise.resolve(said(answerOf()));
      },
    })
  );
  assert.ok(briefs[0]?.includes('no-git'));
});

test('a repository git cannot read is unavailable, and a repository with no origin/main keeps its revision', () => {
  // Bug: a dubious-ownership refusal throws through the worker, or a missing remote hides the revision it knows.
  const unreadable = installFacts({
    ...install(true),
    git: () => {
      throw new Error('fatal');
    },
  });
  assert.equal(unreadable.revision, null);
  assert.ok(unreadable.unavailable.includes('git-unreadable'));
  const noRemote = installFacts({
    ...install(true),
    git: (_root, args) => {
      if (args[0] === 'rev-parse') return 'abc1234';
      throw new Error('no origin/main');
    },
  });
  assert.equal(noRemote.revision, 'abc1234');
  assert.equal(noRemote.divergence, null);
  assert.ok(noRemote.unavailable.includes('no-remote'));
});

test('a repository with origin/main answers its revision and both counts, reading no remote', () => {
  // Bug: the counts swap, and a deployment behind main reads as ahead, or the read fetches over the network.
  const asked: Array<ReadonlyArray<string>> = [];
  const facts = installFacts({
    ...install(true),
    git: (_root, args) => {
      asked.push(args);
      return args[0] === 'rev-parse' ? 'abc1234' : '2\t5';
    },
  });
  assert.equal(facts.revision, 'abc1234');
  assert.deepEqual(facts.divergence, { ahead: 2, behind: 5 });
  assert.deepEqual(
    facts.unavailable.filter((one) => one !== 'skills-unreadable'),
    []
  );
  assert.equal(asked.flat().includes('fetch'), false);
});

test('the modules and dependencies come from the install, each interface under its name', () => {
  // Bug: only the core's package is read, so a dependency added to an interface never shows in a report.
  const facts = installFacts({ ...install(false), git: NO_GIT });
  assert.deepEqual(facts.modules, ['src/watcher', 'interfaces/chat']);
  assert.deepEqual(facts.dependencies, { typescript: '6.0.0', 'chat:chat-sdk': '1.2.3' });
});

test('skills read as unavailable with no memory database, and as an empty list with one that holds none', () => {
  // Bug: an unreadable registry reads as "no active skills", which clears a check nobody made.
  const missing = install(false);
  const none = installFacts({ ...missing, git: NO_GIT });
  assert.equal(none.activeSkills, null);
  assert.ok(none.unavailable.includes('skills-unreadable'));
  openMemoryDb(path.join(missing.dataDir, 'memory.db')).close();
  const empty = installFacts({ ...missing, git: NO_GIT });
  assert.deepEqual(empty.activeSkills, []);
  assert.equal(empty.unavailable.includes('skills-unreadable'), false);
});
