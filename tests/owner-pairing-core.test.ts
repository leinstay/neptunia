// Pairing the owner's account in the running core: `/interfaces pair open <name>` opens pairing on an interface, a
// direct message there is answered with a one-time code and starts no turn, and `/interfaces pair <code>` in the
// command line binds that account to the owner's meta-person. The code reaches no model request and no log. The real
// core, the real `neptunia` command and the fake interface as a unit over fresh folders; synthetic ids only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { withIface } from '../src/memory/db/current-iface.ts';
import { isOwnerId } from '../src/tools/operations/grants.ts';
import { channelInfo, lineEvent } from './fixtures/core-over-fake.ts';
import { query, runCli, settle, spawnCli, startUnitsCore, startedUnit, until, withRig } from './fixtures/core-units.ts';
import type { Dirs, Rig, Unit } from './fixtures/core-units.ts';
import type { MessageEvent } from '../src/protocol/adapter.ts';

const CODE = /[A-HJ-NP-Z2-9]{8}/;

const configOf = (dirs: Dirs): { bot: { ownerPerson?: string } } =>
  JSON.parse(readFileSync(path.join(dirs.privateDir, 'config', 'config.json'), 'utf8')) as {
    bot: { ownerPerson?: string };
  };

const personOf = (dirs: Dirs, native: string): unknown =>
  query(dirs, "SELECT person_id FROM accounts WHERE iface = 'fake' AND native_key = ?", native)[0]?.person_id;

async function firstLine({ dirs, clis }: Pick<Rig, 'dirs' | 'clis'>): Promise<void> {
  const chat = spawnCli(dirs, []);
  clis.push(chat);
  chat.type('the first line of a new install');
  await until(() => typeof configOf(dirs).bot.ownerPerson === 'string', 'bot.ownerPerson written');
}

/** A direct message of `author` to her on the fake interface, in the chat `dm-<author>`. */
async function direct(unit: Unit, author: string, id: string): Promise<void> {
  const chat = `dm-${author}`;
  await unit.ask({ op: 'seed-chat', info: channelInfo(chat, { kind: 'dm', rootId: null, partnerId: author }) }, 'done');
  const line = lineEvent({ chatId: chat, id, text: 'hello, it is me', at: Date.now(), authorId: author });
  const event: MessageEvent = {
    ...line,
    chat: { id: chat, kind: 'dm', rootId: null, partnerId: author, name: author },
  };
  await unit.emit(event);
}

test('a code approved in the command line binds the account that wrote to her, with no turn and no logged code', async () => {
  await withRig({ config: { dm: { enabled: true } } }, async ({ dirs, llm, units, clis, cores, logs }) => {
    cores.push(await startUnitsCore(dirs, llm));
    const unit = await startedUnit(dirs);
    units.push(unit);
    await firstLine({ dirs, clis });
    const opened = await runCli(dirs, ['-p', '/interfaces pair open fake']);
    assert.equal(opened.code, 0, opened.stdout + opened.stderr.slice(-2000));

    await direct(unit, 'u9', 'm1');
    let posted: Array<string> = [];
    // The posted texts are read over the unit's channel, so they are polled here rather than through `until`.
    for (let tries = 0; tries < 80 && posted.length === 0; tries += 1) {
      posted = await unit.posted('dm-u9');
      await settle(50);
    }
    const code = CODE.exec(posted.join('\n'))?.[0] ?? '';
    assert.notEqual(code, '', `no code in ${JSON.stringify(posted)}`);
    await until(() => personOf(dirs, 'u9') !== undefined, 'her sight of u9');

    const approved = await runCli(dirs, ['-p', `/interfaces pair ${code}`]);
    assert.equal(approved.code, 0, approved.stdout + approved.stderr.slice(-2000));
    const config = configOf(dirs);
    assert.equal(personOf(dirs, 'u9'), config.bot.ownerPerson);
    assert.equal(
      withIface('fake', () => isOwnerId(config, 'u9')),
      true
    );
    // The pairing line started no turn, and the code reached no request.
    assert.equal(
      llm.requests.some((request) => JSON.stringify(request).includes('hello, it is me')),
      false
    );
    assert.equal(
      llm.requests.some((request) => JSON.stringify(request).includes(code)),
      false
    );
    assert.equal(
      logs.some((entry) => JSON.stringify(entry).includes(code)),
      false
    );
  });
});
