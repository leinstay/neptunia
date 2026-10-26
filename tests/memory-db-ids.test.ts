// Tests for the memory ids (src/memory/db/ids.ts): the builders take the interface as an argument, so `discord` gives
// the strings stored today and any other interface its own namespace, and the helpers that read the legacy Discord
// spellings keep naming the legacy namespace (src/memory/db/legacy-namespace.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  accountId,
  channelPlaceId,
  dmPlaceId,
  guildAuthorityOf,
  guildPlaceId,
  legacyAccountIdOf,
  legacyNativeKind,
  legacyPlaceOf,
  legacySourceIdOf,
  messageSourceId,
  personId,
} from '../src/memory/db/ids.ts';
import { LEGACY_IFACE } from '../src/memory/db/legacy-namespace.ts';

test('names a Discord person, account and places with the spellings the database stores today', () => {
  assert.equal(personId('discord', '100000000000000001'), 'person:discord:100000000000000001');
  assert.equal(accountId('discord', '100000000000000001'), 'discord:100000000000000001');
  assert.equal(guildPlaceId('discord', '300000000000000001'), 'discord:guild:300000000000000001');
  assert.equal(channelPlaceId('discord', '200000000000000001'), 'discord:channel:200000000000000001');
  assert.equal(dmPlaceId('discord', '100000000000000001'), 'discord:dm:100000000000000001');
});

test('names a command-line person under the cli namespace', () => {
  assert.equal(personId('cli', 'owner'), 'person:cli:owner');
  assert.equal(accountId('cli', 'owner'), 'cli:owner');
  assert.equal(channelPlaceId('cli', 'main'), 'cli:channel:main');
  assert.equal(dmPlaceId('cli', 'owner'), 'cli:dm:owner');
});

test('gives one person on two interfaces two ids and accepts a number as a native id', () => {
  assert.notEqual(personId('discord', '7'), personId('fake', '7'));
  assert.equal(personId('fake', 7), 'person:fake:7');
});

test('names a message source with its interface, message, revision and kind', () => {
  assert.equal(messageSourceId('discord', '400000000000000001', 2, 'seen'), 'src:discord:400000000000000001:2:seen');
  assert.equal(messageSourceId('cli', 'm9', 1, 'said'), 'src:cli:m9:1:said');
});

test('names the community-local authority of a community on its interface', () => {
  assert.equal(guildAuthorityOf('300000000000000001', 'discord'), 'discord/guild:300000000000000001');
  assert.equal(guildAuthorityOf('g1', 'fake'), 'fake/guild:g1');
});

test('keeps the legacy namespace as the stored discord spelling', () => {
  assert.equal(LEGACY_IFACE, 'discord');
  assert.equal(personId(LEGACY_IFACE, '1'), 'person:discord:1');
});

test('spells an observed Discord tuple the way the importer wrote it', () => {
  assert.equal(legacyAccountIdOf('discord/global', '100000000000000001'), 'discord:100000000000000001');
  assert.deepEqual(legacyPlaceOf('discord/global', 'channel:200000000000000001'), {
    id: 'discord:channel:200000000000000001',
    native_id: '200000000000000001',
  });
  assert.deepEqual(legacyPlaceOf('discord/global', 'dm:100000000000000001'), {
    id: 'discord:dm:100000000000000001',
    native_id: null,
  });
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
  assert.equal(legacyAccountIdOf('cli/local', 'owner'), null);
  assert.equal(legacyAccountIdOf('fake/global', 'u1'), null);
  assert.equal(legacyPlaceOf('fake/global', 'channel:c1'), null);
  assert.equal(
    legacySourceIdOf({ authority: 'fake/global', kind: 'message', key: 'm1', revision: 1, subtype: 'seen' }),
    null
  );
  assert.equal(legacyNativeKind('fake'), null);
});
