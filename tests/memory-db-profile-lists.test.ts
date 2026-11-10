// The claim lists of a stored value (src/memory/db/profile-lists.ts): a list of items becomes one claim per item, in
// order, and the claims read back as the same list, an item's id kept or derived. Synthetic items.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claimItems, claimRows } from '../src/memory/db/profile-lists.ts';
import type { ListDef } from '../src/memory/db/profile-lists.ts';
import type { Rows } from '../src/memory/db/types.ts';

const OWNER = {
  rel: 'unit:1',
  subject_kind: 'person',
  subject_id: 'person:p1',
  owner: 'person:p1',
  scope: { scope_kind: 'group', scope_iface: 'chat', scope_dm: null },
};

test('a list of items becomes claims in order and reads back as the same list', () => {
  const def: ListDef = { key: 'details', kind: 'detail', spec: [{ col: 'text', key: 'text', type: 'text' }] };
  const items = [{ itemId: 'd1', text: 'likes tea' }, { text: 'reads at night' }];
  const rows: Rows = {};
  assert.equal(claimRows(rows, items, def, OWNER), true);
  const claims = rows.claims ?? [];
  assert.deepEqual(
    claims.map((row) => [row.id, row.position, row.text]),
    [
      ['d1', 0, 'likes tea'],
      [claims[1]?.id, 1, 'reads at night'],
    ]
  );
  assert.deepEqual(claimItems(claims, def), items);
});

test('a list that is not a list of items is not mapped', () => {
  const rows: Rows = {};
  assert.equal(claimRows(rows, 'not a list', { key: 'details', kind: 'detail' }, OWNER), false);
  assert.equal(rows.claims, undefined);
});
