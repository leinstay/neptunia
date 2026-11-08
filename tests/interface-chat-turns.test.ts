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
const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const quiet = { info() {}, warn() {}, error() {} };

const envelopeOf = (id: string, content: string): Envelope =>
  ({
    v: 1,
    type: 'event',
    id: `env-${id}`,
    body: { kind: 'message.received', message: { id, content, sourceText: content, attachments: [] } },
  }) as unknown as Envelope;

function rig(over: { held?: boolean; status?: string; isBusy?: () => boolean; wait?: number } = {}) {
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
    isAnyTurnRunning: over.isBusy ?? (() => false),
    log: quiet,
    now: () => 1000,
    newId: () => `id${(serial += 1)}`,
    ...(over.wait === undefined ? {} : { watchMs: 2, noTurnWaitMs: over.wait }),
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
  turns.command(link, 'turn.replay', { after: 0 });
  const held: Array<string> = [];
  const noTurn: Array<string> = [];
  const take = (id: string, content: string): Promise<Envelope> =>
    turns.take({
      id,
      value: envelopeOf(id, content),
      message: { content, attachments: [] },
      onHeld: () => void held.push(id),
      onNoTurn: () => void noTurn.push(id),
    });
  const ended = (id: string, outcome: string, reason: string | null = null): void =>
    turns.turnEnded({ trigger: { id }, outcome, reason });
  const typesOf = (turnId: string): Array<string> =>
    events.filter((event) => event.turnId === turnId).map((event) => event.type);
  const queue = (): Array<{ turnId: string; text: string }> =>
    JSON.parse(turns.command(link, 'turn.queue', {}).text) as Array<{ turnId: string; text: string }>;
  return { turns, take, ended, received, events, link, held, noTurn, typesOf, queue };
}

const statusOf = (ack: Envelope): unknown => (ack.body as { status?: unknown }).status;

test('a line sent during a running turn reaches the door at once, and shows as queued', async () => {
  // Bug: a chat line is held back from the door, so memory and her next turn do not see it.
  const { take, received, queue } = rig();
  await take('m1', 'one');
  assert.equal(statusOf(await take('m2', 'two')), 'ok');
  assert.deepEqual(received, ['one', 'two']);
  assert.deepEqual(
    queue().map((one) => one.text),
    ['two']
  );
});

test('the client sees the next line running when the first ended', async () => {
  // Bug: the row stays on the first line, or two lines show as running.
  const { take, ended, queue, typesOf } = rig();
  await take('m1', 'one');
  await take('m2', 'two');
  const [second] = queue();
  ended('m1', 'spoke');
  await tick();
  assert.equal(typesOf(second?.turnId ?? '').at(-1), 'running');
  assert.deepEqual(queue(), []);
});

test('a line the door refuses fails with the door status, and the answer is the door one', async () => {
  // Bug: a refused line reads as waiting for a turn that never comes.
  const { take, events } = rig({ status: 'invalid' });
  assert.equal(statusOf(await take('m1', 'one')), 'invalid');
  await tick();
  assert.equal(events.at(-1)?.code, 'door-invalid');
});

test('an edit is no action: the line is already said', async () => {
  // Bug: the panel promises new words while memory and her history hold the old ones.
  const { take, turns, link, queue } = rig();
  await take('m1', 'one');
  await take('m2', 'two');
  const [second] = queue();
  assert.equal(turns.command(link, 'turn.edit', { turnId: second?.turnId, text: 'other' }).status, 'invalid');
  assert.equal(queue()[0]?.text, 'two');
});

test('cancelling a waiting line ends its state at once, and its turn starts already aborted', async () => {
  // Bug: the source is removed with the turn, or the pipeline still spends a request on the cancelled line.
  const { take, turns, link, queue, typesOf, received } = rig();
  await take('m1', 'one');
  await take('m2', 'two');
  const [second] = queue();
  assert.equal(turns.command(link, 'turn.remove', { turnId: second?.turnId }).text, 'ok');
  assert.equal(typesOf(second?.turnId ?? '').at(-1), 'cancelled');
  assert.deepEqual(received, ['one', 'two'], 'the line stays said');
  assert.equal(turns.cancelOf('m2')?.aborted, true);
  assert.equal(turns.cancelOf('m1')?.aborted, false);
});

test('the cancel of the running line reaches the signal the runner reads, and only that one', async () => {
  // Bug: a chat cancel aborts a turn of another interface, or a later line.
  const { take, turns, link, ended, events } = rig();
  await take('m1', 'one');
  await take('m2', 'two');
  const signal = turns.cancelOf('m1');
  assert.equal(signal?.aborted, false);
  assert.equal(turns.cancelOf('discord-message'), null);
  assert.equal(turns.cancelOf(null), null);
  const id = events.find((event) => event.type === 'running')?.turnId;
  assert.equal(turns.command(link, 'turn.cancel', { turnId: id }).text, 'cancelling');
  assert.equal(signal?.aborted, true);
  ended('m1', 'cancelled', 'cancelled');
  await tick();
  assert.equal(turns.cancelOf('m2')?.aborted, false);
});

test('how the turn ended becomes the event: spoke and skip commit, a failure keeps its reason', async () => {
  // Bug: a failed turn shows as answered, or the journal id of the reply is lost.
  const { take, turns, events } = rig();
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

test('a line taken while paused still reaches the door, is answered held, and the next one goes on', async () => {
  // Bug: a paused core stalls every line behind the first one, or a paused line never reaches memory.
  const { take, held, received } = rig({ held: true });
  await take('m1', 'one');
  await tick();
  assert.deepEqual(held, ['m1']);
  await take('m2', 'two');
  await tick();
  assert.deepEqual(held, ['m1', 'm2']);
  assert.deepEqual(received, ['one', 'two']);
});

test('a line with no turn while nothing runs anywhere ends no-own-turn, and whoever waits hears it', async () => {
  // Bug: a line the pipeline left stalls the row for 15 minutes, and `neptunia -p` waits as long.
  const { take, events, noTurn, queue, typesOf } = rig({ wait: 4 });
  await take('m1', 'one');
  await take('m2', 'two');
  const [second] = queue();
  await pause(40);
  assert.ok(events.some((event) => event.code === 'no-own-turn'));
  assert.ok(noTurn.includes('m1'));
  assert.ok(typesOf(second?.turnId ?? '').includes('running'));
});

test('a line waiting behind another interface turn keeps waiting', async () => {
  // Bug: a long turn elsewhere reads as no turn, and the reply then arrives under a failed line.
  const { take, events } = rig({ wait: 4, isBusy: () => true });
  await take('m1', 'one');
  await pause(30);
  assert.equal(
    events.some((event) => event.code === 'no-own-turn'),
    false
  );
});

test('a begun turn is not timed out by the watch', async () => {
  // Bug: a slow reply reads as no turn.
  const { take, turns, events } = rig({ wait: 4 });
  await take('m1', 'one');
  turns.cancelOf('m1');
  await pause(30);
  assert.equal(
    events.some((event) => event.code === 'no-own-turn'),
    false
  );
});

test('a later line whose turn begins ends the wait of an earlier one that had none', async () => {
  // Bug: a line folded into another line's turn holds the row until the wait runs out.
  const { take, turns, events, noTurn, ended } = rig();
  await take('m1', 'one');
  await take('m2', 'two');
  turns.cancelOf('m2');
  await tick();
  assert.deepEqual(noTurn, ['m1']);
  assert.equal(events.find((event) => event.code === 'no-own-turn')?.type, 'failed');
  ended('m2', 'spoke');
  await tick();
  assert.equal(events.at(-1)?.type, 'committed');
});

test('a turn ended over a line the row has not reached yet is kept for it', async () => {
  // Bug: the end is lost because the row still showed an earlier line, and the line never ends.
  const { take, ended, events } = rig();
  await take('m1', 'one');
  await take('m2', 'two');
  ended('m2', 'spoke');
  await tick();
  await tick();
  assert.deepEqual(
    events.filter((event) => event.type === 'committed' || event.type === 'failed').map((event) => event.type),
    ['failed', 'committed']
  );
});

test('a resent line id is a duplicate and passes the door once, also after its turn ended', async () => {
  // Bug: a resend on reconnect makes her answer twice.
  const { take, received, ended } = rig();
  await take('m1', 'one');
  assert.equal(statusOf(await take('m1', 'one')), 'duplicate');
  ended('m1', 'spoke');
  await tick();
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

test('lines read by the turn over an earlier line end committed with that turn and never run on their own', async () => {
  // Bug: quick lines folded into one answer showed as queued and then running turns of their own, and failed no-own-turn.
  const { take, turns, queue, typesOf, events } = rig({ wait: 4 });
  await take('m1', 'one');
  await take('m2', 'two');
  await take('m3', 'three');
  const [second, third] = queue();
  turns.turnEnded({ trigger: { id: 'm1' }, outcome: 'spoke', reason: null, turnId: 't-one', folded: ['m2', 'm3'] });
  await pause(20);
  for (const folded of [second, third]) {
    assert.deepEqual(typesOf(folded?.turnId ?? ''), ['accepted', 'queued', 'committed']);
    assert.equal(events.findLast((event) => event.turnId === folded?.turnId)?.responseId, 't-one');
  }
  assert.deepEqual(queue(), []);
  assert.equal(
    events.some((event) => event.code === 'no-own-turn'),
    false
  );
});

test('a turn that failed leaves the lines it read waiting for their own turn', async () => {
  // Bug: a failed turn takes the lines it read down with it, and nothing ever answers them.
  const { take, turns, queue, typesOf } = rig();
  await take('m1', 'one');
  await take('m2', 'two');
  const [second] = queue();
  turns.turnEnded({ trigger: { id: 'm1' }, outcome: 'error', reason: 'llm-error', turnId: null, folded: ['m2'] });
  await tick();
  assert.equal(typesOf(second?.turnId ?? '').at(-1), 'running');
});
