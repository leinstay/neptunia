// The owner's pairing commands in the console (src/interface/commands/console.ts): `/interfaces setup <name>` ends,
// once every required value is stored, by opening pairing on that interface and asking for the code she answers there
// (`labels.pairing.ask`), and `/interfaces pair <code>` approves a code later. A temporary data folder and a recording
// pairing; the pairing itself is tested in tests/owner-pairing.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createConsole } from '../src/interface/commands/console.ts';
import type { Answer, ConsoleDeps } from '../src/interface/commands/console.ts';
import { parseCommandLine } from '../src/interface/commands/table.ts';
import type { Dialog } from '../src/keys/commands.ts';
import { tempDir } from './fixtures/tmp.ts';

type Rig = {
  opened: Array<string>;
  approved: Array<string>;
  asked: Array<string>;
  say: (line: string, answers: ReadonlyArray<string> | null) => Promise<Answer>;
};

function withConsole(body: (rig: Rig) => Promise<void>): Promise<void> {
  const dir = tempDir('nep-commands-pair-');
  const opened: Array<string> = [];
  const approved: Array<string> = [];
  const asked: Array<string> = [];
  const deps: ConsoleDeps = {
    runOp: () => Promise.resolve({ status: 'failed', code: 'NOT_HERE', summary: '', data: null }),
    ownerReads: { lessons: () => '' },
    places: () => [],
    selfId: () => null,
    hot: { config: {}, prompts: { labels: { pairing: { ask: 'write to her on {iface}, then the code' } } } },
    privateDir: dir,
    dataDir: dir,
    memoryDb: null,
    usage: null,
    metrics: { samples: () => [] },
    chatLines: () => [],
    now: () => Date.parse('2026-11-08T12:00:00Z'),
    pairing: {
      open: (iface: string) => {
        opened.push(iface);
        return `pairing is open on ${iface}`;
      },
      approve: (code: string) => {
        approved.push(code);
        return Promise.resolve({ text: 'paired', status: 'ok' });
      },
    },
  };
  const desk = createConsole(deps);
  const say = (line: string, answers: ReadonlyArray<string> | null): Promise<Answer> => {
    const parsed = parseCommandLine(line);
    assert.ok(parsed.ok, parsed.ok ? '' : parsed.reason);
    const queue = [...(answers ?? [])];
    const dialog: Dialog | null =
      answers === null
        ? null
        : {
            ask: (question) => {
              asked.push(question);
              return Promise.resolve(queue.shift() ?? '');
            },
          };
    return desk.run(parsed.name, parsed.args, { id: 'owner' }, dialog);
  };
  return body({ opened, approved, asked, say });
}

test('a finished interface setup opens pairing there and approves the code the owner types', async () => {
  // Bug: the setup ends at the token, and the owner's account on the new interface stays a stranger.
  await withConsole(async ({ opened, approved, asked, say }) => {
    const answer = await say('/interfaces setup discord', ['token-value', '', 'abcd2345']);
    assert.deepEqual(opened, ['discord']);
    assert.equal(asked.at(-1), 'write to her on discord, then the code');
    assert.deepEqual(approved, ['abcd2345']);
    assert.match(answer.text, /paired/);
  });
});

test('an empty answer at the pairing question approves nothing and leaves pairing open', async () => {
  await withConsole(async ({ opened, approved, say }) => {
    await say('/interfaces setup discord', ['token-value', '', '']);
    assert.deepEqual(opened, ['discord']);
    assert.deepEqual(approved, []);
  });
});

test('a setup that leaves a required value unset opens no pairing', async () => {
  // Bug: pairing opens on an interface that cannot connect, and a code is promised that never comes.
  await withConsole(async ({ opened, say }) => {
    await say('/interfaces setup discord', ['', '', '']);
    assert.deepEqual(opened, []);
  });
});

test('/interfaces pair <code> approves the code and /interfaces pair open <name> opens pairing', async () => {
  await withConsole(async ({ opened, approved, say }) => {
    assert.equal((await say('/interfaces pair open discord', null)).text, 'pairing is open on discord');
    assert.equal((await say('/interfaces pair ABCD2345', null)).text, 'paired');
    assert.deepEqual(opened, ['discord']);
    assert.deepEqual(approved, ['ABCD2345']);
  });
});
