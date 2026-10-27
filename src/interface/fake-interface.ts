// The fake interface: the in-memory adapter (src/interface/fake.js) started the way an interface package is, so a test
// runs the core over the real link with no platform behind it. `start(host)` opens the interface's end of the link
// with `host.connect()`, says hello with the fake's capabilities and serves the adapter over it, and resolves with
// the running interface plus two handles for the test: `emit(event)` injects an inbound event as the interface would
// deliver it and resolves with the core's ack status, and `adapter` is the fake adapter whose stored messages are what
// the persona posted and whose seeded conversations, members and messages the core reads. `legacy` is what the core's
// tool and memory-job subsystems still read from a platform (src/interface/legacy.ts): the fake has none, and a test
// that needs one passes it in `options.legacy`.
//
// `options.self` and `options.community` are what `hello` tells the core about the persona and the community it serves.
// `options.reads` limits the reads the fake offers (their wire names; all when absent).
//
// The fake holds no event back before `open()`: the core's end of the link makes an envelope wait for its door.
//
// When the host gives it a data folder (`host.dataDir`), the fake numbers its events in an outbox there
// (src/protocol/outbox.ts), so a restart of the core or of the fake resends what the core has not acknowledged.
// `drop()` closes its end of the link as a lost connection would, and `reconnect()` opens a new one with
// `host.connect()`, says hello again and resends the outbox; an event emitted between the two waits in the outbox.

import path from 'node:path';
import { createOutbox } from '../protocol/outbox.ts';
import { serveAdapter } from '../protocol/serve.ts';
import type { AckStatus, Named } from '../protocol/serve.ts';
import type { InterfaceHost, RunningInterface } from '../protocol/host.ts';
import { createFakeAdapter } from './fake.js';

/** The community the fake serves when a test names none: the one fake guild of the legacy fixture. */
const DEFAULT_COMMUNITY: Named = { id: 'g1', name: 'Fake community' };

/** How many unacknowledged events the fake's outbox holds. */
const OUTBOX_CAPACITY = 1000;

export type FakeInterface = RunningInterface & {
  /** Injects an inbound event over the link and resolves with the status of the core's ack. */
  emit(event: unknown): Promise<AckStatus>;
  /** The adapter the core's actions run on: its stored messages are what the persona posted. */
  adapter: ReturnType<typeof createFakeAdapter>;
  /** Closes the fake's end of the link, as a lost connection would. */
  drop(): Promise<void>;
  /** Opens a new connection to the core and says hello again; the outbox goes again after the core's answer. */
  reconnect(): Promise<void>;
};

export async function start(
  host: InterfaceHost,
  options: {
    legacy?: unknown;
    selfId?: string;
    self?: Named;
    community?: Named | null;
    reads?: ReadonlyArray<string>;
  } = {}
): Promise<FakeInterface> {
  const selfId = options.self?.id ?? options.selfId;
  const adapter = createFakeAdapter({
    ...(selfId === undefined ? {} : { selfId }),
    ...(options.reads === undefined ? {} : { reads: options.reads }),
  });
  // The persona is `self` when given, else the account of `selfId` (the fake's own default) under a name the fake picks.
  const self = options.self ?? { id: options.selfId ?? 'self', name: 'Fake' };
  const community = options.community === undefined ? DEFAULT_COMMUNITY : options.community;
  const outbox =
    host.dataDir === undefined
      ? undefined
      : createOutbox({ dir: path.join(host.dataDir, 'outbox'), capacity: OUTBOX_CAPACITY });
  const serve = async (): Promise<ReturnType<typeof serveAdapter>> =>
    serveAdapter({
      transport: await host.connect(),
      hello: { iface: adapter.iface, self, community, capabilities: adapter.capabilities(), resume: null },
      token: host.token,
      adapter,
      log: host.log,
      ...(outbox === undefined ? {} : { outbox }),
    });
  let served = await serve();
  return {
    iface: adapter.iface,
    legacy: options.legacy ?? null,
    adapter,
    emit: (event) => served.emit(event),
    drop(): Promise<void> {
      served.close();
      return Promise.resolve();
    },
    async reconnect(): Promise<void> {
      served.close();
      served = await serve();
    },
    open(): void {},
    stop(): Promise<void> {
      served.close();
      return Promise.resolve();
    },
  };
}
