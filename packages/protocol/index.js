// @neptunia/protocol: the transport-neutral contract between the persona's core and its
// interfaces. What an interface sends in (events.js), what the core sends out and the results it
// gets back (actions.js), and the boundary checks of both (validate.js). Plain ESM, no build
// step, no dependencies; nothing here touches a platform, runs a service or logs.

export * from './events.js';
export * from './actions.js';
export { validateEvent, validateAction } from './validate.js';
export * from './envelope.js';
export { originOf } from './origin.js';
