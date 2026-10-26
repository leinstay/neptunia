// The fake interface: the in-memory adapter (src/interface/fake.js) started the way an interface package is, so a test
// runs the core over the real link with no platform behind it. `start(host)` opens the interface's end of the link
// with `host.connect()`, says hello with the fake's capabilities and serves the adapter over it, and resolves with
// the running interface plus two handles for the test: `emit(event)` injects an inbound event as the interface would
// deliver it and resolves with the core's ack status, and `adapter` is the fake adapter whose stored messages are what
// the persona posted. `legacy` is what the core's subsystems still read from a platform (src/interface/legacy.ts):
// the fake has none of its own, so a test that needs a turn to run builds it (tests/fixtures/fake-legacy.ts) and
// passes it in `options.legacy`.
//
// The fake holds no event back before `open()`: the core's end of the link makes an envelope wait for its door.

import { serveAdapter } from '../protocol/serve.ts';
import type { AckStatus } from '../protocol/serve.ts';
import type { InterfaceHost, RunningInterface } from '../protocol/host.ts';
import { createFakeAdapter } from './fake.js';

export type FakeInterface = RunningInterface & {
  /** Injects an inbound event over the link and resolves with the status of the core's ack. */
  emit(event: unknown): Promise<AckStatus>;
  /** The adapter the core's actions run on: its stored messages are what the persona posted. */
  adapter: ReturnType<typeof createFakeAdapter>;
};

export async function start(
  host: InterfaceHost,
  options: { legacy?: unknown; selfId?: string } = {}
): Promise<FakeInterface> {
  const adapter = createFakeAdapter(options.selfId === undefined ? {} : { selfId: options.selfId });
  const served = serveAdapter({
    transport: await host.connect(),
    hello: { iface: adapter.iface, capabilities: adapter.capabilities(), resume: null },
    token: host.token,
    adapter,
    log: host.log,
  });
  return {
    iface: adapter.iface,
    legacy: options.legacy ?? null,
    adapter,
    emit: (event) => served.emit(event),
    open(): void {},
    stop(): Promise<void> {
      served.close();
      return Promise.resolve();
    },
  };
}
