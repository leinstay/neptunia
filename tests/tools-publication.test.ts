// The trusted publication boundary restricts one adapter binding without changing shared adapter authority.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeAdapter } from '../src/interface/fake.ts';
import { bindPublicationPort, publicationRefusal, type PublicationBoundary } from '../src/tools/publication.ts';

const boundary: PublicationBoundary = { kind: 'internal-turn', origin: { iface: 'fake', chatId: 'origin' } };

test('a publication boundary distinguishes equal chat IDs on different interfaces', () => {
  assert.equal(publicationRefusal(boundary, { iface: 'fake', chatId: 'origin' }), null);
  assert.deepEqual(publicationRefusal(boundary, { iface: 'other', chatId: 'origin' }), {
    status: 'denied',
    code: 'not-allowed',
    reason: 'publication-boundary',
  });
});

test('a bound port retains private replies while an independent ordinary binding remains unrestricted', async () => {
  const port = createFakeAdapter({ iface: 'fake', selfId: 'self', now: () => 1000 });
  const restricted = bindPublicationPort(port, boundary);
  const ordinary = bindPublicationPort(port, null);
  const refused = await restricted.send({ iface: 'fake', chatId: 'group' }, { text: 'private body' });
  assert.deepEqual([refused.status, refused.error?.code], ['failed', 'not-allowed']);
  assert.deepEqual(port.messagesIn('group'), []);
  const privateAnswer = await restricted.send(boundary.origin, { text: 'private answer' });
  assert.equal(privateAnswer.status, 'ok');
  assert.equal(restricted.messagesIn('origin')[0].text, 'private answer');
  const ordinaryAnswer = await ordinary.send({ iface: 'fake', chatId: 'group' }, { text: 'ordinary answer' });
  assert.equal(ordinaryAnswer.status, 'ok');
  assert.equal(port.messagesIn('group')[0].text, 'ordinary answer');
});

test('a bound port blocks edits and reaction additions but preserves reads and deletion', async () => {
  const port = createFakeAdapter({ iface: 'fake', selfId: 'self', now: () => 1000 });
  port.seed('group', { messageId: 'own', authorId: 'self', text: 'original' });
  const ref = { iface: 'fake', chatId: 'group', messageId: 'own' };
  const restricted = bindPublicationPort(port, boundary);
  const edit = await restricted.edit(ref, { text: 'private replacement' });
  const reaction = await restricted.react(ref, 'yes');
  assert.deepEqual(
    [edit.status, edit.error?.code, reaction.status, reaction.error?.code],
    ['failed', 'not-allowed', 'failed', 'not-allowed']
  );
  assert.equal(port.messagesIn('group')[0].text, 'original');
  assert.equal(port.messagesIn('group')[0].reactions.size, 0);
  const read = await restricted.fetchMessages(ref, ['own']);
  assert.equal(read.status, 'ok');
  if (read.status !== 'ok') throw new Error('ordinary stored read was refused');
  assert.equal(read.messages.length, 1);
  assert.equal((await restricted.delete(ref)).status, 'ok');
});

test('a bound port preserves the receiver and own members of an adapter subtype', async () => {
  const fake = createFakeAdapter({ iface: 'fake', selfId: 'self', now: () => 1000 });
  const port = {
    ...fake,
    marker: 'receiver-731',
    send(...args: Parameters<typeof fake.send>) {
      assert.equal(this, port);
      assert.equal(this.marker, 'receiver-731');
      return fake.send(...args);
    },
  };
  const bound = bindPublicationPort(port, boundary);
  assert.equal(bound.marker, 'receiver-731');
  assert.equal((await bound.send(boundary.origin, { text: 'private answer' })).status, 'ok');
  assert.equal(port.messagesIn('origin')[0].text, 'private answer');
});
