// The protocol: the transport-neutral contract between the persona's core and its
// interfaces. What an interface sends in (events.ts), what the core sends out and the results it
// gets back (actions.ts), and the boundary checks of both (validate.ts). Plain ESM, no build
// step, no dependencies; nothing here touches a platform, runs a service or logs.

export * from './events.ts';
export * from './actions.ts';
export { validateEvent, validateAction } from './validate.ts';
export * from './envelope.ts';
export { originOf } from './origin.ts';
export { deliveryOf } from './adapter.ts';
export { splitText } from './split-text.ts';
export { encodeEnvelope, decodeEnvelope, createLoopback, connectSocket } from './wire.ts';
