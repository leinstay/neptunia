// What the core hands an interface when it starts one, and what the interface hands back. An interface package
// exports `start(host)`; the core calls it once, with its end of the link and the settings and the logger the
// interface reads, and keeps the `RunningInterface` it resolves with. The package imports nothing of the core
// beyond src/protocol/, so everything it needs from the core comes through the host.

import type { Logger } from './serve.ts';
import type { Transport } from './wire.ts';

export type InterfaceHost = {
  /** Opens the interface's end of the link to the core. */
  connect(): Promise<Transport>;
  /** The token the core made at boot, sent in `hello`. */
  token: string;
  /** The environment the interface reads its own keys from (the platform token). */
  env: Readonly<Record<string, string | undefined>>;
  /** The live config, read at the moment of use: the core hands over `() => hot.config`. */
  config(): Readonly<Record<string, unknown>>;
  /** Calls `fn` with the layer name (`config` or `prompts`) after each reload that took; returns the unsubscribe. */
  onConfigChange(fn: (what: string) => void): () => void;
  log: Logger;
  /** Builds the platform client from the privileged intents asked for. Tests inject a stand-in. */
  createClient?: (intents: { presences: boolean; members: boolean }) => unknown;
};

export type RunningInterface = {
  /** The interface's namespace on the link (`fake`, say). */
  iface: string;
  /** The platform objects and reads the core's subsystems still take, each one a seam a later stage removes. */
  legacy: unknown;
  /** Delivers the events held since `start` and every later one: the core calls it once its door has handlers. */
  open(): void;
  /** Closes the link and the platform client. */
  stop(): Promise<void>;
};
