// How a line's old scope becomes its place and scope columns and back (src/memory/db/scope-parts.ts). The chat a
// line names is found by its row and read back from it; no id is taken apart.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scopeFrom, scopeInto } from '../src/memory/db/scope-parts.ts';
import type { Row } from '../src/memory/db/types.ts';

const reads = {
  placeOfChannel: (iface: string, native: string): string | null =>
    iface === 'chat' && native === 'room-n' ? 'place:9b25' : null,
  channelOfPlace: (placeId: string): string | null => (placeId === 'place:9b25' ? 'room-n' : null),
  partnerOfDm: (audienceId: string): string | null => (audienceId === 'aud:dm:place:dm-1' ? 'd1' : null),
};

test('a line of a chat whose place id spells nothing is stored on that place and reads its chat back', () => {
  const rest: Row = {};
  const cols = scopeInto(rest, { channel: 'room-n' }, null, 'chat', null, reads);
  assert.equal(cols.place_id, 'place:9b25');
  assert.deepEqual(rest, {}, 'the columns rebuild the scope, so nothing is kept beside them');
  assert.deepEqual(scopeFrom(cols, rest, null, reads), { channel: 'room-n' });
});

test('a direct-chat line names the partner its audience names and never one its person id spells', () => {
  // Bug: the partner was parsed from the person id or the audience id when no reader answered.
  const row = { place_id: null, scope_kind: 'dm', scope_iface: 'chat', scope_dm: 'person:chat:d9' };
  assert.deepEqual(scopeFrom({ ...row, audience_id: 'aud:dm:place:dm-1' }, {}, null, reads), { user: 'd1' });
  assert.deepEqual(scopeFrom({ ...row, audience_id: 'aud:dm:chat:dm:d9' }, {}, null, reads), { user: null });
});
