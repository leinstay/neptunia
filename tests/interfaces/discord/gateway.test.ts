// interfaces/discord/gateway.ts and the snowflake time of interfaces/discord/collect.ts: the client a root logs in
// with, and the creation time of an id.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as discordInterface from '../../../interfaces/discord/index.ts';
import { present } from '../../fixtures/loose-types.ts';

test('snowflakeTime and createDiscordClient: the creation time of an id, and the client the root logs in', () => {
  // The Discord epoch plus the timestamp bits: 175928847299117063 is 2016-04-30T11:18:25.796Z.
  assert.equal(discordInterface.snowflakeTime('175928847299117063'), Date.UTC(2016, 3, 30, 11, 18, 25, 796));
  const plain = discordInterface.createDiscordClient();
  const wide = discordInterface.createDiscordClient({ presences: true, members: true });
  try {
    const intents2 = plain.options.intents;
    const intents = wide.options.intents;
    assert.equal(intents.bitfield - intents2.bitfield, (1 << 8) + (1 << 1), 'presences and members add their intents');
    assert.equal(present(plain.options.partials).length, 4);
  } finally {
    plain.destroy();
    wide.destroy();
  }
});
