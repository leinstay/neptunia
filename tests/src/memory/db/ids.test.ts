// Tests for src/memory/db/ids.ts, the memory ids: the builders take the interface as an argument, so `discord` gives
// the strings the database stores and any other interface its own namespace, and the helpers that read the legacy
// Discord spellings keep naming the legacy namespace.
import { legacyServerPlaceId } from '../../../fixtures/memory-db/legacy-paths.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  accountId,
  channelPlaceId,
  dmPlaceId,
  legacyNativeKind,
  legacySourceIdOf,
  messageSourceId,
  answerSourceId,
  itemOrDerivedId,
  otherSourceId,
  shortHash,
  uniqueIds,
} from '../../../../src/memory/db/ids.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openMemoryDb } from '../../../../src/memory/db/open.ts';
import { seedUnits } from '../../../fixtures/memory-db/seed.ts';
import { CHANNEL, GUILD, MEMBER, buildDataDir } from '../../../fixtures/memory-db/datadir.ts';
import { personId } from '../../../fixtures/memory-db/spelled-ids.ts';

test('names a Discord account and places with the spellings the database stores today', () => {
  assert.equal(accountId('discord', '100000000000000001'), 'discord:100000000000000001');
  assert.equal(legacyServerPlaceId('discord', '300000000000000001'), 'discord:guild:300000000000000001');
  assert.equal(channelPlaceId('discord', '200000000000000001'), 'discord:channel:200000000000000001');
  assert.equal(dmPlaceId('discord', '100000000000000001'), 'discord:dm:100000000000000001');
});

test('names a command-line account and places under the cli namespace', () => {
  assert.equal(accountId('cli', 'owner'), 'cli:owner');
  assert.equal(channelPlaceId('cli', 'main'), 'cli:channel:main');
  assert.equal(dmPlaceId('cli', 'owner'), 'cli:dm:owner');
});

test('names a message source with its interface, message, revision and kind', () => {
  assert.equal(messageSourceId('discord', '400000000000000001', 2, 'seen'), 'src:discord:400000000000000001:2:seen');
  assert.equal(messageSourceId('cli', 'm9', 1, 'said'), 'src:cli:m9:1:said');
});

test('spells an observed Discord tuple the way the importer wrote it', () => {
  assert.equal(
    legacySourceIdOf({
      authority: 'discord/global',
      kind: 'message',
      key: '400000000000000001',
      revision: 1,
      subtype: 'seen',
    }),
    'src:discord:400000000000000001:1:seen'
  );
  assert.equal(legacyNativeKind('discord'), 'message');
});

test('gives an observed tuple of another interface no legacy spelling', () => {
  assert.equal(
    legacySourceIdOf({ authority: 'fake/global', kind: 'message', key: 'm1', revision: 1, subtype: 'seen' }),
    null
  );
  assert.equal(legacyNativeKind('fake'), null);
});

type Row = Record<string, unknown>;
type Handle = ReturnType<typeof openMemoryDb>;
type Db = { prepare(sql: string): { all(): Array<Row>; get(): Row } };

function withSeeded(body: (handle: Handle) => void): void {
  const root = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'ids-'));
  const handle = openMemoryDb(join(root, 'memory.db'));
  try {
    buildDataDir(root);
    assert.equal(seedUnits(handle, root).errors, 0);
    body(handle);
  } finally {
    handle.close();
    rmSync(root, { recursive: true, force: true });
  }
}

const idsOf = (handle: Handle, table: string): Array<unknown> =>
  (handle.db as Db)
    .prepare(`SELECT id FROM ${table} ORDER BY id`)
    .all()
    .map((row) => row.id);

test('keeps the id of the account, the places and the sources of a seeded database', () => {
  withSeeded((handle) => {
    assert.deepEqual(idsOf(handle, 'accounts'), [`discord:${MEMBER}`]);
    // The member's private file spells a DM place no row holds, and no writer makes a
    // place from that spelling, so the seeded database holds the channel and the server only.
    assert.deepEqual(idsOf(handle, 'places'), [`discord:channel:${CHANNEL}`, `discord:guild:${GUILD}`]);
    assert.deepEqual(idsOf(handle, 'sources'), [
      'src:discord:400000000000000001:1:seen',
      'src:discord:400000000000000001:2:seen',
      'src:discord:400000000000000002:1:seen',
      'src:discord:400000000000000005:1:seen',
      'src:turn:turn-1:1',
    ]);
  });
});

const ALICE = personId('discord', '100000000000000001');

test('ids are deterministic text', () => {
  assert.equal(personId('discord', '1'), 'person:discord:1');
  assert.equal(accountId('discord', '1'), 'discord:1');
  assert.equal(legacyServerPlaceId('discord', '2'), 'discord:guild:2');
  assert.equal(channelPlaceId('discord', '3'), 'discord:channel:3');
  assert.equal(dmPlaceId('discord', '4'), 'discord:dm:4');
  assert.equal(messageSourceId('discord', '5', 2, 'seen'), 'src:discord:5:2:seen');
  assert.equal(answerSourceId('t-1', 0), 'src:turn:t-1:0');
  assert.equal(otherSourceId('felt', 'f-1'), 'src:felt:f-1');
  assert.equal(shortHash('a', 'b'), shortHash('a', 'b'));
  assert.notEqual(shortHash('a', 'b'), shortHash('ab'));
  assert.match(shortHash('x'), /^[0-9a-f]{16}$/);
});

test('a claim id is the old itemId when there was one, else kind, owner and a hash of the stable fields', () => {
  assert.equal(itemOrDerivedId('ep-1', 'detail', ALICE, 'x'), 'ep-1');
  const derived = itemOrDerivedId(undefined, 'detail', ALICE, 7);
  assert.equal(derived, `detail:${ALICE}:${shortHash(7)}`);
  assert.equal(itemOrDerivedId('', 'detail', ALICE, 7), derived);
  assert.equal(itemOrDerivedId(undefined, 'detail', ALICE, 7), derived);
});

test('uniqueIds keeps the first and suffixes a repeat', () => {
  const uniq = uniqueIds();
  assert.deepEqual(['a', 'b', 'a', 'a', 'b'].map(uniq), ['a', 'b', 'a-2', 'a-3', 'b-2']);
});
