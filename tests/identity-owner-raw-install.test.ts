// On a raw install the first line of the owner's command line writes `bot.ownerPerson`, and the command line's account
// is the owner's first account. The retired `bot.owners` binds nobody and gives nobody the owner rights: another
// account becomes the owner's only by `/memory bind`. A stranger's direct message is a line like any other, never
// answered with a pairing phrase. The real core and the real `neptunia` command over fresh folders; synthetic ids only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { withIface } from '../src/memory/db/current-iface.ts';
import { isOwnerId } from '../src/tools/operations/grants.ts';
import type { MessageEvent } from '../src/protocol/adapter.ts';
import { ANSWER, channelInfo, lineEvent } from './fixtures/core-over-fake.ts';
import {
  mention,
  query,
  runCli,
  settle,
  spawnCli,
  startUnitsCore,
  startedUnit,
  until,
  withRig,
} from './fixtures/core-units.ts';
import type { Dirs, Rig, Unit } from './fixtures/core-units.ts';

const configOf = (dirs: Dirs): { bot: { ownerPerson?: string } } =>
  JSON.parse(readFileSync(path.join(dirs.privateDir, 'config', 'config.json'), 'utf8')) as {
    bot: { ownerPerson?: string };
  };

const personOf = (dirs: Dirs, iface: string, native: string): unknown =>
  query(dirs, 'SELECT person_id FROM accounts WHERE iface = ? AND native_key = ?', iface, native)[0]?.person_id;

const ownerOn = (iface: string, native: string, config: object): boolean =>
  withIface(iface, () => isOwnerId(config, native));

async function firstLine({ dirs, clis }: Pick<Rig, 'dirs' | 'clis'>): Promise<void> {
  const chat = spawnCli(dirs, []);
  clis.push(chat);
  chat.type('the first line of a new install');
  await until(
    () => query(dirs, "SELECT 1 FROM sources WHERE iface = 'cli' AND kind = 'seen'").length > 0,
    () => chat.stderr()
  );
  await until(() => typeof configOf(dirs).bot.ownerPerson === 'string', 'bot.ownerPerson written');
}

test('an account listed in bot.owners stays a stranger once the first line names the owner person', async () => {
  // Bug: the retired list of native ids still binds its accounts to the owner and hands them his rights.
  // The expectation changed with plan 2026-11-08-meta-person slice 8: the owner's other accounts come by `/memory bind`,
  // never from `bot.owners`. Owner pairing, the other way it named, was removed by the owner on 2026-11-11.
  await withRig({ config: { bot: { owners: ['u1'] } } }, async ({ dirs, llm, units, clis, cores }) => {
    cores.push(await startUnitsCore(dirs, llm));
    const unit = await startedUnit(dirs);
    units.push(unit);
    await unit.emit(mention('m1', 'hello'));
    await until(() => personOf(dirs, 'fake', 'u1') !== undefined, 'her first sight of u1');
    await firstLine({ dirs, clis });
    const owner = configOf(dirs).bot.ownerPerson;
    assert.equal(personOf(dirs, 'cli', 'owner'), owner);
    assert.notEqual(personOf(dirs, 'fake', 'u1'), owner);
    assert.equal(ownerOn('fake', 'u1', configOf(dirs)), false);
    assert.equal(ownerOn('cli', 'owner', configOf(dirs)), true);
  });
});

/** A direct message of `author` to her on the fake interface, in the chat `dm-<author>`. */
async function direct(unit: Unit, author: string, id: string, text: string): Promise<void> {
  const chat = `dm-${author}`;
  await unit.ask({ op: 'seed-chat', info: channelInfo(chat, { kind: 'dm', rootId: null, partnerId: author }) }, 'done');
  const line = lineEvent({ chatId: chat, id, text, at: Date.now(), authorId: author });
  const event: MessageEvent = {
    ...line,
    chat: { id: chat, kind: 'dm', rootId: null, partnerId: author, name: author },
  };
  await unit.emit(event);
}

test("a stranger's direct message is never answered with a pairing phrase, and no command opens pairing", async () => {
  // The owner removed owner pairing on 2026-11-11. Catches: a direct message still screened for pairing and answered
  // with a phrase, or a pairing command still taken by the command line. Whether she answers a stranger at all is the
  // private gate's and her turn's matter (src/pipeline/private-gate.ts), so only her own reply may reach that chat.
  await withRig({ config: { dm: { enabled: true } } }, async ({ dirs, llm, units, clis, cores }) => {
    cores.push(await startUnitsCore(dirs, llm));
    const unit = await startedUnit(dirs);
    units.push(unit);
    await firstLine({ dirs, clis });
    for (const args of [
      ['-p', '/interfaces fake pair'],
      ['interfaces', 'fake', 'pair'],
      ['-p', '/interfaces pair open fake'],
    ])
      assert.equal((await runCli(dirs, args)).code, 2, args.join(' '));
    const member = {
      id: 'u9',
      name: 'Stranger',
      bot: false,
      groupIds: [],
      avatar: { hash: null, url: null, largeUrl: null },
    };
    await unit.ask({ op: 'seed-member', rootId: 'g1', member }, 'done');
    await direct(unit, 'u9', 'm1', 'hello, it is me');
    await settle(1000);
    const posted = await unit.posted('dm-u9');
    for (const text of posted) assert.equal(text, ANSWER, 'nothing but her reply reaches the chat');
  });
});
