// The fake interface as a package `neptunia interface run fake --interfaces-dir tests/fixtures/interfaces` loads in a
// process of its own: `start(host)` starts the fake interface of src/interface/fake-interface.ts over the host the
// runner built (its socket, its token, its data folder for the outbox) and hands the runner the running interface.
// The test that spawned the runner drives it over the child's IPC channel, so no platform is involved anywhere.
//
// Requests from the test carry an `id` and an `op`:
// - `seed-chat` stores a chat the core may read (`info`), answered `{ id, op: 'done' }`;
// - `emit` emits an event, and first stores the message of a `message.received` event in the fake's history; it is
//   answered `{ id, op: 'queued' }` as soon as the emit call returned, and `{ id, op: 'acked', status }` when the
//   core's ack arrives;
// - `posted` answers `{ id, op: 'posted', texts }`, what the persona sent to a chat, in order;
// - `hold` makes every later send wait, and `release` lets the waiting ones go; a send that starts waiting is told
//   as `{ op: 'held' }`.
// Once `start` resolved, the fixture tells `{ op: 'started' }`.
//
// The fake answers the invite read with `INVITE`, so a test can ask for its invite link (`/interfaces fake invite`).

import type { ChatInfo, MessageEvent, MemberInfo } from '../../../../src/protocol/adapter.ts';
import type { RootChanged } from '../../../../src/protocol/events.ts';
import type { InterfaceHost, RunningInterface } from '../../../../src/protocol/host.ts';
import { start as startFake } from '../../../../src/interface/fake-interface.ts';
import { createFakeAdapter } from '../../../../src/interface/fake.ts';

/** The persona and the root of tests/fixtures/core-over-fake.ts, so its events name her. */
const SELF = { id: 'self-id', name: 'Nova' };
const ROOT = { id: 'g1', name: 'Alpha' };

/** The link the fake's invite read answers. */
export const INVITE = 'https://chat.invalid/invite/fake';

type Request =
  | { id: number; op: 'seed-chat'; info: ChatInfo }
  | { id: number; op: 'seed-member'; rootId: string; member: MemberInfo }
  | { id: number; op: 'emit'; event: MessageEvent | RootChanged }
  | { id: number; op: 'posted'; chatId: string }
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
  const adapter = createFakeAdapter({ selfId: SELF.id, invite: INVITE });
  const running = await startFake(host, { self: SELF, root: ROOT, adapter });
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
      case 'seed-chat':
        fake.seedChat(request.info);
        tell({ id: request.id, op: 'done' });
        return;
      case 'seed-member':
        fake.seedMember(request.rootId, request.member);
        tell({ id: request.id, op: 'done' });
        return;
      case 'emit': {
        if (request.event.kind === 'message.received') fake.seedEvent(request.event);
        const acked = running.emit(request.event);
        tell({ id: request.id, op: 'queued' });
        void acked.then((status) => tell({ id: request.id, op: 'acked', status }));
        return;
      }
      case 'posted': {
        const texts = fake
          .messagesIn(request.chatId)
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
