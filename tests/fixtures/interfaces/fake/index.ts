// The fake interface as a package `neptunia interface run fake --interfaces-dir tests/fixtures/interfaces` loads in a
// process of its own: `start(host)` starts the fake interface of src/interface/fake-interface.ts over the host the
// runner built (its socket, its token, its data folder for the outbox) and hands the runner the running interface.
// The test that spawned the runner drives it over the child's IPC channel, so no platform is involved anywhere.
//
// Requests from the test carry an `id` and an `op`:
// - `seed-conversation` stores a conversation the core may read (`info`), answered `{ id, op: 'done' }`;
// - `emit` stores the message of a `message.received` event in the fake's history and emits the event; it is
//   answered `{ id, op: 'queued' }` as soon as the emit call returned, and `{ id, op: 'acked', status }` when the
//   core's ack arrives;
// - `posted` answers `{ id, op: 'posted', texts }`, what the persona sent to a conversation, in order;
// - `hold` makes every later send wait, and `release` lets the waiting ones go; a send that starts waiting is told
//   as `{ op: 'held' }`.
// Once `start` resolved, the fixture tells `{ op: 'started' }`.

import type { ConversationInfo, MessageEvent } from '../../../../src/protocol/adapter.ts';
import type { InterfaceHost, RunningInterface } from '../../../../src/protocol/host.ts';
import { start as startFake } from '../../../../src/interface/fake-interface.ts';

/** The persona and the community of tests/fixtures/core-over-fake.ts, so its events name her. */
const SELF = { id: 'self-id', name: 'Nova' };
const COMMUNITY = { id: 'g1', name: 'Alpha' };

type Request =
  | { id: number; op: 'seed-conversation'; info: ConversationInfo }
  | { id: number; op: 'emit'; event: MessageEvent }
  | { id: number; op: 'posted'; conversationId: string }
  | { id: number; op: 'hold' }
  | { id: number; op: 'release' };

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

function requestOf(value: unknown): Request | null {
  if (!isObject(value) || typeof value.id !== 'number' || typeof value.op !== 'string') return null;
  // The test process builds every request from this file's own list of ops.
  return value as Request;
}

export async function start(host: InterfaceHost): Promise<RunningInterface> {
  const tell = process.send?.bind(process);
  if (tell === undefined) {
    throw new Error('the fake unit fixture runs only as a child process with an IPC channel; spawn it with "ipc"');
  }
  const running = await startFake(host, { self: SELF, community: COMMUNITY });
  const fake = running.adapter;

  // The gate of `hold`: every send that starts while it is set waits for `release`.
  let gate: PromiseWithResolvers<void> | null = null;
  const send = fake.send.bind(fake);
  fake.send = async (...args: Parameters<typeof send>) => {
    if (gate !== null) {
      const waiting = gate.promise;
      tell({ op: 'held' });
      await waiting;
    }
    return send(...args);
  };

  process.on('message', (raw: unknown) => {
    const request = requestOf(raw);
    if (request === null) return;
    switch (request.op) {
      case 'seed-conversation':
        fake.seedConversation(request.info);
        tell({ id: request.id, op: 'done' });
        return;
      case 'emit': {
        fake.seedEvent(request.event);
        const acked = running.emit(request.event);
        tell({ id: request.id, op: 'queued' });
        void acked.then((status) => tell({ id: request.id, op: 'acked', status }));
        return;
      }
      case 'posted': {
        const texts = fake
          .messagesIn(request.conversationId)
          .filter((message) => message.authorId === SELF.id)
          .map((message) => message.text);
        tell({ id: request.id, op: 'posted', texts });
        return;
      }
      case 'hold':
        gate ??= Promise.withResolvers<void>();
        tell({ id: request.id, op: 'done' });
        return;
      case 'release':
        gate?.resolve();
        gate = null;
        tell({ id: request.id, op: 'done' });
        return;
    }
  });

  tell({ op: 'started' });
  return running;
}
