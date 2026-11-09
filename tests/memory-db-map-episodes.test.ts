// Round trips of src/memory/db/map/selfreflection.ts, the diary <-> rows, through the real schema.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as selfreflection from '../src/memory/db/map/selfreflection.ts';
import { assertRoundTrip, roundTrip } from './fixtures/memory-db/roundtrip.ts';
import type { Untyped } from '../src/tools/types.ts';
import { removeField, wrongly } from './fixtures/loose-types.ts';

const selfreflectionFile = () => ({
  updatedAt: 1792000000000,
  posts: [
    {
      at: 1792000000000,
      kind: 'day',
      gist: 'a quiet day',
      picture: 'a lamp in the rain',
      messageIds: ['500000000000000001', '500000000000000002'],
      search: null,
      itemId: 'd-1',
      pictures: 1,
    },
    { at: 2, kind: 'night', gist: 'late', picture: null, messageIds: [], search: 'moths', itemId: 'd-2' },
  ],
});

test('selfreflection: posts become diary rows and the message ids a mirror row', () => {
  const rows = assertRoundTrip(selfreflection, 'diary.json', selfreflectionFile());
  const [post] = rows.selfreflection;
  assert.equal(post.id, 'd-1');
  assert.equal(post.at_ms, 1792000000000);
  assert.equal(post.gist, 'a quiet day');
  assert.equal(post.picture_prompt, 'a lamp in the rain');
  assert.equal(post.scope_kind, 'group');
  assert.deepEqual(JSON.parse(String(post.extra)), { pictures: 1, $null: ['search'] });
  assert.deepEqual(JSON.parse(String(rows.selfreflection_mirrors[0].native_ids)), [
    '500000000000000001',
    '500000000000000002',
  ]);
  assert.equal(rows.selfreflection_mirrors[0].iface, 'discord');
});

test('selfreflection: absent, empty and odd message ids stay as they were', () => {
  const file = selfreflectionFile();
  removeField(file.posts[1], 'messageIds');
  const { rows, back }: Record<string, Untyped> = roundTrip(selfreflection, 'diary.json', file);
  assert.equal(rows.selfreflection_mirrors.length, 1);
  assert.ok(!Object.hasOwn(back.posts[1], 'messageIds'));
  assert.deepEqual(back, file);
  wrongly<{ messageIds: Array<unknown> }>(file.posts[0]).messageIds = [1, 'x'];
  assertRoundTrip(selfreflection, 'diary.json', file);
  assertRoundTrip(selfreflection, 'diary.json', { posts: [] });
  assertRoundTrip(selfreflection, 'diary.json', { posts: [{ gist: 5 }, { itemId: 'same' }, { itemId: 'same' }] });
});
