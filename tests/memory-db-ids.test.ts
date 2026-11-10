// Tests for the memory ids (src/memory/db/ids.ts): the builders take the interface as an argument, so `discord` gives
// the strings stored today and any other interface its own namespace, and the helpers that read the legacy Discord
// spellings keep naming the legacy namespace (ids.ts).
import { legacyServerPlaceId } from './fixtures/memory-db/legacy-paths.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  accountId,
  channelPlaceId,
  dmPlaceId,
  legacyNativeKind,
  legacySourceIdOf,
  messageSourceId,
} from '../src/memory/db/ids.ts';

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

// The root-local authority `guildAuthorityOf` spelled is gone with the partition by root (plan task 5).

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
