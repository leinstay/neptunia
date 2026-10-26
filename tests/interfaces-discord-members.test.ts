// Tests for interfaces/discord/members.ts: a discord.js member as the avatar queue sees it (`memberView`) and the
// avatar hash it is built from (`avatarHashOf`). The same view is what `membership.changed` and a message's
// author carry as `avatar`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { avatarHashOf, memberView } from '../interfaces/discord/members.ts';

const view = (member: unknown) => memberView(member);

test('prefers the server avatar hash over the account avatar hash', () => {
  assert.equal(avatarHashOf({ memberAvatar: 'srv', userAvatar: 'acc' }), 'srv');
});

test('falls back to the account avatar hash when the member set no server avatar', () => {
  assert.equal(avatarHashOf({ memberAvatar: null, userAvatar: 'acc' }), 'acc');
});

test('gives no hash for empty strings or no fields at all', () => {
  assert.equal(avatarHashOf({ memberAvatar: '', userAvatar: '' }), null);
  assert.equal(avatarHashOf({}), null);
});

test('asks for a static 256 px PNG and reports id, bot flag, hash and url of a member with an avatar', () => {
  const asked: Array<unknown> = [];
  const member = {
    avatar: null,
    user: { id: 'u1', bot: false, avatar: 'a_anim' },
    displayAvatarURL: (options: unknown) => {
      asked.push(options);
      return 'https://cdn.example/a.png';
    },
  };
  assert.deepEqual(view(member), { id: 'u1', bot: false, hash: 'a_anim', url: 'https://cdn.example/a.png' });
  assert.deepEqual(asked, [{ extension: 'png', size: 256, forceStatic: true }]);
});

test('gives hash and url null for a bot on the default avatar', () => {
  const member = { avatar: null, user: { id: 'u2', bot: true, avatar: null }, displayAvatarURL: () => 'x' };
  assert.deepEqual(view(member), { id: 'u2', bot: true, hash: null, url: null });
});

test('gives null for no member and for a member without a user id', () => {
  assert.equal(view(null), null);
  assert.equal(view({ user: {} }), null);
});

test('keeps the hash and gives a null url when the url builder throws', () => {
  const member = {
    avatar: 's',
    user: { id: 'u3', avatar: null },
    displayAvatarURL: () => {
      throw new Error('boom');
    },
  };
  assert.deepEqual(view(member), { id: 'u3', bot: false, hash: 's', url: null });
});
