// On a raw install the first line of the owner's command line writes `bot.ownerPerson`, and from that moment
// `bot.owners` no longer counts. The accounts it lists join the new person in the same step, so the owner keeps his
// rights on his home interface. The real core and the real `neptunia` command over fresh folders; synthetic ids only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { withIface } from '../src/memory/db/current-iface.ts';
import { isOwnerId } from '../src/tools/impl/grants.ts';
import { mention, query, spawnCli, startUnitsCore, startedUnit, until, withRig } from './fixtures/core-units.ts';
import type { Dirs, Rig } from './fixtures/core-units.ts';

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

test('an owner listed in bot.owners keeps his rights on his interface once the first line names the owner person', async () => {
  // Bug: the first line writes `bot.ownerPerson`, the check stops reading `bot.owners`, and the owner's own account,
  // bound to nobody, loses the owner commands and the private chat at once.
  await withRig({ config: { bot: { owners: ['u1'] } } }, async ({ dirs, llm, units, clis, cores }) => {
    cores.push(await startUnitsCore(dirs, llm));
    const unit = await startedUnit(dirs);
    units.push(unit);
    await unit.emit(mention('m1', 'hello'));
    await until(() => personOf(dirs, 'fake', 'u1') !== undefined, 'her first sight of u1');
    await firstLine({ dirs, clis });
    const owner = configOf(dirs).bot.ownerPerson;
    assert.equal(personOf(dirs, 'cli', 'owner'), owner);
    assert.equal(personOf(dirs, 'fake', 'u1'), owner);
    assert.equal(ownerOn('fake', 'u1', configOf(dirs)), true);
    assert.equal(ownerOn('cli', 'owner', configOf(dirs)), true);
  });
});

test('an owner listed in bot.owners whom she never met is bound before his first line', async () => {
  // Bug: only an account she already stored can be linked, so an owner who speaks on his interface after the command
  // line arrives as a stranger.
  await withRig({ config: { bot: { owners: ['u1'] } } }, async ({ dirs, llm, units, clis, cores }) => {
    cores.push(await startUnitsCore(dirs, llm));
    units.push(await startedUnit(dirs));
    await firstLine({ dirs, clis });
    assert.equal(personOf(dirs, 'fake', 'u1'), configOf(dirs).bot.ownerPerson);
    assert.equal(ownerOn('fake', 'u1', configOf(dirs)), true);
  });
});
