// src/interface/chat-turns.ts: the real wiring of the turn control between the link, the event door and the turn's end. The
// door and the link are fakes; the control, the protocol reader and the envelope are the real ones.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createChatTurns } from '../src/interface/chat-turns.ts';
import type { AdapterLink, LinkDoor } from '../src/interface/link.ts';
import { ackOf } from '../src/protocol/index.ts';
import { readTurnEvent } from '../src/protocol/turn-control.ts';
import type { TurnEvent } from '../src/protocol/turn-control.ts';
import type { Envelope } from '../src/protocol/wire.ts';

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
const quiet = { info() {}, warn() {}, error() {} };

const envelopeOf = (id: string, content: string): Envelope =>
  ({
    v: 1,
    type: 'event',
    id: `env-${id}`,
    body: { kind: 'message.received', message: { id, content, sourceText: content, attachments: [] } },
  }) as unknown as Envelope;

function rig(over: { held?: boolean; status?: string; endWaitMs?: number; capacity?: number } = {}) {
  const received: Array<string> = [];
  const door: LinkDoor = {
    receive(value) {
      const envelope = value as { id: string; body: { message: { content: string } } };
      received.push(envelope.body.message.content);
      return Promise.resolve(ackOf(envelope.id, over.status ?? 'ok'));
    },
  };
  let serial = 0;
  const turns = createChatTurns({
    door,
    linesHeld: () => over.held === true,
    capacity: () => over.capacity ?? 3,
    log: quiet,
    now: () => 1000,
    newId: () => `id${(serial += 1)}`,
    ...(over.endWaitMs === undefined ? {} : { endWaitMs: over.endWaitMs }),
  });
  const events: Array<TurnEvent> = [];
  const link = {
    isClosed: () => false,
    answerCommand(answer: { text: string; status: string }) {
      if (answer.status === 'turn') {
        const read = readTurnEvent(JSON.parse(answer.text));
        if (read.ok) events.push(read.event);
      }
      return Promise.resolve({ status: 'ok' });
    },
  } as unknown as AdapterLink;
  const held: Array<string> = [];
  const take = (id: string, content: string): Promise<Envelope> =>
    turns.take({
      id,
      value: envelopeOf(id, content),
      message: { content, attachments: [] },
      onHeld: () => void held.push(id),
    });
  const ended = (id: string, outcome: string, reason: string | null = null): void =>
    turns.turnEnded({ trigger: { id }, outcome, reason });
  return { turns, take, ended, received, events, link, held };
}

const statusOf = (ack: Envelope): unknown => (ack.body as { status?: unknown }).status;

test('the first line goes through the door at once with the door answer, the second waits for the end of its turn', async () => {
  // Bug: two turns run at once over one conversation.
  const { take, ended, received } = rig();
  assert.equal(statusOf(await take('m1', 'one')), 'ok');
  assert.equal(statusOf(await take('m2', 'two')), 'ok');
  assert.deepEqual(received, ['one']);
  ended('m1', 'spoke');
  await tick();
  assert.deepEqual(received, ['one', 'two']);
});

test('a line the door refuses fails its turn with the door status, and the core does not wait for a turn', async () => {
  // Bug: a refused line holds the queue until the wait runs out.
  const { take, turns, link, events } = rig({ status: 'invalid' });
  turns.command(link, 'turn.replay', { after: 0 });
  assert.equal(statusOf(await take('m1', 'one')), 'invalid');
  await tick();
  assert.equal(events.at(-1)?.code, 'door-invalid');
});

test('a queue edit reaches the door as the edited text, in content and sourceText', async () => {
  // Bug: the owner edits a queued line and the old words reach her.
  const { take, ended, received, turns, link } = rig();
  await take('m1', 'one');
  await take('m2', 'two');
  const [queued] = JSON.parse(turns.command(link, 'turn.queue', {}).text) as Array<{ turnId: string }>;
  assert.equal(turns.command(link, 'turn.edit', { turnId: queued?.turnId, text: 'two edited' }).text, 'ok');
  ended('m1', 'skip');
  await tick();
  assert.deepEqual(received, ['one', 'two edited']);
});

test('a line past the capacity is refused, and what the queue holds stays', async () => {
  // Bug: a refused line takes a place, or pushes an older one out.
  const { take, turns, link } = rig({ capacity: 1 });
  await take('m1', 'one');
  await take('m2', 'two');
  const refused = await take('m3', 'three');
  assert.equal(statusOf(refused), 'invalid');
  const queued = JSON.parse(turns.command(link, 'turn.queue', {}).text) as Array<{ text: string }>;
  assert.deepEqual(
    queued.map((one) => one.text),
    ['two']
  );
});

test('the cancel reaches the signal the runner reads by message id, and only that one', async () => {
  // Bug: a chat cancel aborts a turn of another interface, or a later line.
  const { take, turns, link, ended } = rig();
  turns.command(link, 'turn.replay', { after: 0 });
  await take('m1', 'one');
  await take('m2', 'two');
  const signal = turns.cancelOf('m1');
  assert.equal(signal?.aborted, false);
  assert.equal(turns.cancelOf('discord-message'), null);
  assert.equal(turns.cancelOf('m2'), null, 'a queued line has no run yet');
  assert.equal(turns.cancelOf(null), null);
  const running = JSON.parse(turns.command(link, 'turn.replay', { after: 0 }).text) as { events: Array<TurnEvent> };
  const id = running.events.find((event) => event.type === 'running')?.turnId;
  assert.equal(turns.command(link, 'turn.cancel', { turnId: id }).text, 'cancelling');
  assert.equal(signal?.aborted, true);
  ended('m1', 'cancelled', 'cancelled');
  await tick();
  assert.equal(turns.cancelOf('m1'), null);
  assert.equal(turns.cancelOf('m2')?.aborted, false);
});

test('how the turn ended becomes the event: spoke and skip commit, a failure keeps its reason', async () => {
  // Bug: a failed turn shows as answered, or the journal id of the reply is lost.
  const { take, turns, link, events } = rig();
  turns.command(link, 'turn.replay', { after: 0 });
  await take('m1', 'one');
  turns.turnEnded({ trigger: { id: 'm1' }, outcome: 'spoke', reason: null, turnId: 'journal-1' });
  await tick();
  assert.equal(events.at(-1)?.type, 'committed');
  assert.equal(events.at(-1)?.responseId, 'journal-1');
  await take('m2', 'two');
  turns.turnEnded({ trigger: { id: 'm2' }, outcome: 'error', reason: 'provider-down' });
  await tick();
  assert.equal(events.at(-1)?.type, 'failed');
  assert.equal(events.at(-1)?.code, 'provider-down');
});

test('a line taken while paused has no turn to wait for: it is answered held and the queue moves on', async () => {
  // Bug: a paused core stalls every line behind the first one.
  const { take, held, received } = rig({ held: true });
  await take('m1', 'one');
  await tick();
  assert.deepEqual(held, ['m1']);
  await take('m2', 'two');
  await tick();
  assert.deepEqual(received, ['one', 'two']);
});

test('a line whose turn never ends fails at the wait, and the next line runs', async () => {
  // Bug: a line the core dropped without a turn stalls the conversation for good.
  const { take, received, turns, link, events } = rig({ endWaitMs: 5 });
  turns.command(link, 'turn.replay', { after: 0 });
  await take('m1', 'one');
  await take('m2', 'two');
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(events.some((event) => event.code === 'no-turn-end'));
  assert.deepEqual(received, ['one', 'two']);
});

test('a resent line id is a duplicate and runs once', async () => {
  // Bug: a resend on reconnect makes her answer twice.
  const { take, received } = rig();
  await take('m1', 'one');
  assert.equal(statusOf(await take('m1', 'one')), 'duplicate');
  assert.deepEqual(received, ['one']);
});

test('a subscribed link gets the events and a replay of what it missed; an unknown action is refused', async () => {
  // Bug: a client that reconnects loses the state, or a malformed action reads as the cancel of the running turn.
  const { take, turns, link, events } = rig();
  await take('m1', 'one');
  const replay = JSON.parse(turns.command(link, 'turn.replay', { after: 0 }).text) as {
    instance: string;
    events: Array<TurnEvent>;
  };
  assert.deepEqual(
    replay.events.map((event) => event.type),
    ['accepted', 'running']
  );
  assert.ok(replay.instance !== '');
  await take('m2', 'two');
  assert.equal(events[0]?.type, 'accepted');
  assert.equal(turns.command(link, 'turn.cancel', {}).status, 'invalid');
  assert.equal(turns.command(link, 'turn.other', { turnId: 'x' }).status, 'invalid');
});
