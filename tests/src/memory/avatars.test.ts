// Tests for src/memory/avatars.ts: the normalisation of the stored avatar field and which avatar is due for a
// description.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isAvatarDue, normalizeAvatar } from '../../../src/memory/avatars.ts';

test('normalizeAvatar: a described avatar, the default one, anything else is no field', () => {
  assert.deepEqual(
    normalizeAvatar({ hash: 'h1', text: ' a  red\nfox ', describedAt: '2026-10-15T12:00:00.000Z', extra: 1 }),
    {
      hash: 'h1',
      text: 'a red fox',
      describedAt: '2026-10-15T12:00:00.000Z',
    }
  );
  assert.deepEqual(normalizeAvatar({ hash: null, default: true }), { hash: null, default: true });
  assert.deepEqual(normalizeAvatar({ hash: 'h1', text: 'fox', describedAt: 'not a date' }), {
    hash: 'h1',
    text: 'fox',
    describedAt: null,
  });
  for (const broken of [
    null,
    'fox',
    [],
    {},
    { hash: 'h1' },
    { hash: 'h1', text: '   ' },
    { hash: '', text: 'fox' },
    { hash: null },
    { default: 'yes' },
  ]) {
    assert.equal(normalizeAvatar(broken), null, JSON.stringify(broken));
  }
});

test('isAvatarDue: nothing stored or another hash is due; the same hash or the default again is not', () => {
  const described = { hash: 'h1', text: 'fox', describedAt: null };
  assert.equal(isAvatarDue(undefined, 'h1'), true);
  assert.equal(isAvatarDue(undefined, null), true);
  assert.equal(isAvatarDue(described, 'h1'), false);
  assert.equal(isAvatarDue(described, 'h2'), true);
  assert.equal(isAvatarDue(described, null), true);
  assert.equal(isAvatarDue({ hash: null, default: true }, null), false);
  assert.equal(isAvatarDue({ hash: null, default: true }, 'h1'), true);
  assert.equal(isAvatarDue({ hash: 'h1' }, 'h1'), true, 'a broken stored field is described again');
});
