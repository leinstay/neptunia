// The persona's interface port: the one contract every interface adapter (the package's `port.js`,
// src/interface/fake.js) implements, so the engine speaks of conversations, messages and members
// and never of a chat platform (the skills design: "a platform is her interface, not her self").
// References are opaque strings namespaced by the adapter's `iface`; content is typed with a safe
// mention default (nobody is notified unless named); every operation answers a result -- it never
// throws -- whose `status` says honestly what happened: `ok`, `failed` (known not to have taken
// effect), `unknown` (may have taken effect: never retried blindly), `unsupported` (this interface
// cannot do it), `forbidden` (it may not, e.g. someone else's message). The typedefs, the
// capability names and the pure functions live in the protocol (src/protocol/actions.js,
// through src/protocol/index.js); this module re-exports them so every importer of the port is unchanged.

/** @typedef {import('../protocol/index.js').ConversationRef} ConversationRef */
/** @typedef {import('../protocol/index.js').MessageRef} MessageRef */
/** @typedef {import('../protocol/index.js').Attachment} Attachment */
/** @typedef {import('../protocol/index.js').Mentions} Mentions */
/** @typedef {import('../protocol/index.js').Content} Content */
/** @typedef {import('../protocol/index.js').PortError} PortError */
/** @typedef {import('../protocol/index.js').PortResult} PortResult */
/** @typedef {import('../protocol/index.js').Capabilities} Capabilities */
/** @typedef {import('../protocol/index.js').Port} Port */
/** @typedef {import('../protocol/index.js').Action} Action */

export {
  STATUSES,
  CAPABILITIES,
  INCOMING_HOOKS,
  NO_MENTIONS,
  ok,
  notOk,
  mentionsOf,
  isRefOf,
  refRefusal,
  contentRefusal,
  declaredHooks,
} from '../protocol/index.js';
