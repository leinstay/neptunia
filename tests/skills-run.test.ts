// src/skills/run.ts: one script of an activated skill as a child process of its own, through real processes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runSkillScript, skillOutputFile } from '../src/skills/run.ts';
import { tempDir } from './fixtures/tmp.ts';

function rig(script: string, name = 'tool.ts') {
  const dataDir = tempDir('nep-skill-run-');
  const dir = path.join(dataDir, 'skills', 'gif-search');
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'scripts', name), script);
  return {
    dataDir,
    dir,
    run: (over: Record<string, unknown> = {}) =>
      runSkillScript({
        dataDir,
        name: 'gif-search',
        packageDir: dir,
        script: name,
        args: { q: 'cat' },
        credentials: {},
        timeoutMs: 5000,
        maxOutputBytes: 100_000,
        runId: 'r1',
        ...over,
      }),
  };
}

const ANSWER = `process.stdin.setEncoding('utf8');let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{`;

test('a script takes its arguments as JSON on stdin and answers JSON on stdout', async () => {
  // Bug: arguments reach the script through a shell line, or its answer is lost.
  const { run } = rig(`${ANSWER}console.log(JSON.stringify({ok:true,text:'found '+JSON.parse(s).q}))})`);
  const result = await run();
  assert.equal(result.status, 'ok');
  assert.equal(result.text, 'found cat');
});

test('a script sees its state folder and its own credentials, and nothing of the engine environment', async () => {
  // Bug: a script reads the core's keys from the environment or learns where the memory database lives.
  process.env.NEPTUNIA_TEST_SECRET = 'leak';
  const { run, dir } = rig(
    `console.log(JSON.stringify({ok:true,data:{env:Object.keys(process.env).sort(),token:process.env.SKILL_TOKEN,cwd:process.cwd()}}))`
  );
  try {
    const result = await run({ credentials: { token: 'abc' } });
    const data = result.data as { env: Array<string>; token: string; cwd: string };
    assert.equal(data.token, 'abc');
    assert.equal(data.env.includes('NEPTUNIA_TEST_SECRET'), false);
    assert.equal(
      data.env.some((name) => name.startsWith('NEPTUNIA')),
      false
    );
    assert.equal(data.cwd, fs.realpathSync(path.join(dir, 'state')));
  } finally {
    delete process.env.NEPTUNIA_TEST_SECRET;
  }
});

test('a script past its deadline dies with its children and the outcome is unknown', async () => {
  // Bug: a hung script keeps a grandchild alive, or a timed-out call is reported as not having happened.
  const { run } = rig(
    `
    const { spawn } = require('node:child_process');
    const child = spawn('sleep', ['30'], { stdio: 'ignore' });
    console.error(child.pid);
    setTimeout(() => {}, 30000);
  `,
    'tool.cjs'
  );
  const started = Date.now();
  const result = await run({ timeoutMs: 300 });
  assert.equal(result.status, 'unknown');
  assert.equal(result.code, 'timeout');
  assert.ok(Date.now() - started < 4000);
  const pid = Number(result.stderr.trim());
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.throws(() => process.kill(pid, 0), /ESRCH/);
});

test('output past the limit stops the script, and bad output and a failed exit are failures', async () => {
  // Bug: a script floods the core's memory, or nonsense counts as success.
  const flood = rig(`setInterval(()=>process.stdout.write('x'.repeat(10000)),1)`);
  assert.equal((await flood.run({ maxOutputBytes: 50_000 })).code, 'output-too-large');
  assert.equal((await rig(`console.log('not json')`).run()).code, 'bad-output');
  assert.equal((await rig(`process.exit(3)`).run()).code, 'exit-3');
});

test('a returned file becomes a handle only inside the run folder', async () => {
  // Bug: a script names `../../keys.json` and the persona posts the key store.
  const { run, dataDir } = rig(
    `const fs=require('node:fs');fs.writeFileSync(process.env.SKILL_OUT_DIR+'/a.txt','hi');console.log(JSON.stringify({ok:true,files:['a.txt','../../../keys.json']}))`,
    'tool.cjs'
  );
  fs.writeFileSync(path.join(dataDir, 'keys.json'), 'secret');
  const result = await run();
  assert.deepEqual(result.files, ['skill:gif-search/r1/a.txt']);
  assert.equal(skillOutputFile(dataDir, 'skill:gif-search/r1/a.txt')?.name, 'a.txt');
  assert.equal(skillOutputFile(dataDir, 'skill:gif-search/r1/../../../keys.json'), null);
  assert.equal(skillOutputFile(dataDir, 'file:task/a.txt'), null);
});

test('a missing script answers a named failure', async () => {
  // Bug: a spawn error crashes the turn instead of telling her what is missing.
  const { run } = rig('');
  const result = await run({ script: 'nope.ts' });
  assert.equal(result.code, 'no-script');
});
