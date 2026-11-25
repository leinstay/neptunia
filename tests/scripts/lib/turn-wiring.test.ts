// Who the persona is in a replayed turn (scripts/lib/turn-wiring.ts `identityIn`, `homeIdentity`): their account on
// the home interface, the one the core takes their id and name from (src/core.ts `greet`), whatever interface the turn
// is on.

import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { homeIdentity, identityIn, trackedReads } from '../../../scripts/lib/turn-wiring.ts';
import { freshMemoryDb } from '../../fixtures/memory-db-copy.ts';
import { tempDir } from '../../fixtures/tmp.ts';

type Db = InstanceType<typeof DatabaseSync>;

function seed(db: Db): void {
  const account = db.prepare(
    `INSERT INTO accounts (id, iface, native_id, person_id, names, kind) VALUES (?, ?, ?, ?, ?, ?)`
  );
  account.run('fake:9001', 'fake', '9001', 'person:self', '["Αθηνά"]', 'self');
  account.run('fake:9002', 'fake', '9002', 'person:other', '["Νίκος"]', 'user');
}

/** The persona's account on the command line as well, stored before the one on `fake`. */
function seedBoth(db: Db): void {
  db.prepare(`INSERT INTO accounts (id, iface, native_id, person_id, names, kind) VALUES (?, ?, ?, ?, ?, ?)`).run(
    'cli:self',
    'cli',
    'self',
    'person:self',
    '["Ελένη"]',
    'self'
  );
  seed(db);
}

/** A data folder whose clients.json names the command line first and the interface `fake` after it. */
function dataDirWithClients(): string {
  const dir = tempDir('nep-replay-identity-');
  const clients = {
    cli: { kind: 'cli', iface: 'cli', tokenFile: 'clients/cli.token', permissions: [] },
    fake: { kind: 'interface', iface: 'fake', tokenFile: 'clients/fake.token', permissions: [] },
  };
  fs.writeFileSync(path.join(dir, 'clients.json'), JSON.stringify(clients));
  return dir;
}

test("takes the persona's account on the interface of the turn", () => {
  const handle = freshMemoryDb();
  seed(handle.db as Db);
  assert.deepEqual(identityIn(handle.db as Db, 'fake'), { selfId: '9001', selfName: 'Αθηνά' });
  handle.close();
});

// Catches: a command line turn that reads the persona as `self` named `bot`, so their grants, keyed by their account,
// give them no tool and the system text names them wrongly.
test("takes the persona's account on another interface for a turn of an interface where they have none", () => {
  const handle = freshMemoryDb();
  seed(handle.db as Db);
  assert.deepEqual(identityIn(handle.db as Db, 'cli'), { selfId: '9001', selfName: 'Αθηνά' });
  handle.close();
});

// Catches: with the persona's own account on the command line, a command line turn that takes that account's id, while
// their grants name their id on the home interface, so the replay offers 3 tools of the 47 the live turn has.
test("takes the persona's account on the first interface of clients.json for a command line turn", () => {
  const handle = freshMemoryDb();
  seedBoth(handle.db as Db);
  const self = homeIdentity(handle.db as Db, dataDirWithClients());
  assert.deepEqual(
    { iface: self.iface, selfId: self.selfId, selfName: self.selfName, from: self.from },
    { iface: 'fake', selfId: '9001', selfName: 'Αθηνά', from: 'clients.json' }
  );
  handle.close();
});

test("takes the persona's first account off the command line when the copy has no clients.json", () => {
  const handle = freshMemoryDb();
  seedBoth(handle.db as Db);
  const self = homeIdentity(handle.db as Db, tempDir('nep-replay-identity-'));
  assert.deepEqual(
    { iface: self.iface, selfId: self.selfId, from: self.from },
    { iface: 'fake', selfId: '9001', from: 'accounts' }
  );
  handle.close();
});

test('waits for a read started when an earlier read ends before it calls the reads idle', async () => {
  // Catches: a replay that starts the turn while the runner's background seeding still reads the journal.
  const done: Array<string> = [];
  const later = (day: string) => new Promise<Array<string>>((resolve) => setTimeout(() => resolve([day]), 10));
  const tracked = trackedReads(later);
  void (async () => {
    await tracked.read('yesterday');
    await tracked.read('today');
    done.push('seeded');
  })();
  await tracked.idle();
  assert.deepEqual(done, ['seeded']);
});
