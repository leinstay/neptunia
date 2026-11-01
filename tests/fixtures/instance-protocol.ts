// The messages between tests/second-instance.test.ts and tests/fixtures/instance-runner.ts over the child's IPC
// channel: the test sends a request with an id, the runner answers it with the same id. Types only, so both sides
// share one shape and neither imports the other.

/** What the test asks the runner to do inside its core. */
export type InstanceRequest =
  | { id: number; kind: 'seed'; info: unknown; event: unknown }
  | { id: number; kind: 'emit'; event: unknown }
  | { id: number; kind: 'posted'; conversationId: string }
  | { id: number; kind: 'requests' }
  | { id: number; kind: 'stop' };

/** A request before the test gives it an id. */
export type InstanceCommand = InstanceRequest extends infer Request
  ? Request extends { id: number }
    ? Omit<Request, 'id'>
    : never
  : never;

/** The runner's answer: the value of the request, or the error that stopped it. */
export type InstanceReply = { id: number; ok: true; value: unknown } | { id: number; ok: false; error: string };

/** Sent once, when the core and its fake interface are up. */
export type InstanceReady = { ready: true };
