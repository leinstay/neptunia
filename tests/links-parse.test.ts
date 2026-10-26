// messageRefOf (src/tools/impl/shared.ts): the message an operation's argument names, a bare id or a link a person
// pasted. A link is read by the interface (`parseLinks`, the wire action `links.parse`), so the core holds no platform
// address grammar. The fake adapter writes and reads message addresses as `https://discord.com/channels/...` shaped
// templates, so the links below are the ones it would hand out.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Reads } from '../src/interface/reads.ts';
import { rig } from './fixtures/reads-rig.ts';

type MessageRef = { channelId: string | null; messageId: string };
type Shared = { messageRefOf: (value: unknown, reads: Reads | null) => Promise<MessageRef> };

const shared = (await import('../src/tools/impl/shared.ts')) as Shared;

const COMMUNITY_LINK = 'https://discord.com/channels/g1/c42/m77';
const DIRECT_LINK = 'https://discord.com/channels/@me/dm9/m5';

test('takes a bare id as it is and asks the interface nothing', async () => {
  const { reads, asked } = rig();
  const ref = await shared.messageRefOf('m77', reads);
  assert.deepEqual(ref, { channelId: null, messageId: 'm77' });
  assert.deepEqual(asked('parseLinks'), []);
});

test('reads a pasted link through the interface into its conversation and message', async () => {
  const { reads, asked } = rig();
  const ref = await shared.messageRefOf(COMMUNITY_LINK, reads);
  assert.deepEqual(ref, { channelId: 'c42', messageId: 'm77' });
  assert.deepEqual(asked('parseLinks'), [[COMMUNITY_LINK]]);
});

test('reads the link of a private chat the same way', async () => {
  const { reads } = rig();
  assert.deepEqual(await shared.messageRefOf(DIRECT_LINK, reads), { channelId: 'dm9', messageId: 'm5' });
});

test('strips the angle brackets and the spaces around a link before asking', async () => {
  const { reads, asked } = rig();
  const ref = await shared.messageRefOf(`  <${COMMUNITY_LINK}>  `, reads);
  assert.deepEqual(ref, { channelId: 'c42', messageId: 'm77' });
  assert.deepEqual(asked('parseLinks'), [[COMMUNITY_LINK]]);
});

test('refuses a link of another platform as an unknown message', async () => {
  const { reads } = rig();
  await assert.rejects(shared.messageRefOf('https://example.com/channels/g1/c42/m77', reads), {
    status: 'invalid',
    code: 'unknown-message',
  });
});

test('refuses text that is neither an id nor a link without asking the interface', async () => {
  const { reads, asked } = rig();
  await assert.rejects(shared.messageRefOf('that message from yesterday', reads), {
    status: 'invalid',
    code: 'unknown-message',
  });
  assert.deepEqual(asked('parseLinks'), []);
});

test('refuses a link when the interface cannot read links, and still takes a bare id', async () => {
  const { reads } = rig({ reads: ['messages.fetch'] });
  await assert.rejects(shared.messageRefOf(COMMUNITY_LINK, reads), { status: 'invalid', code: 'unknown-message' });
  assert.deepEqual(await shared.messageRefOf('m77', reads), { channelId: null, messageId: 'm77' });
});

test('refuses a link when there are no reads at all, and still takes a bare id', async () => {
  await assert.rejects(shared.messageRefOf(COMMUNITY_LINK, null), { status: 'invalid', code: 'unknown-message' });
  assert.deepEqual(await shared.messageRefOf('m77', null), { channelId: null, messageId: 'm77' });
});

test('refuses an empty value', async () => {
  const { reads } = rig();
  await assert.rejects(shared.messageRefOf('   ', reads), { status: 'invalid', code: 'unknown-message' });
});
