// The persona's interface port: the one contract every interface adapter (interfaces/discord/port.js,
// src/interface/fake.js) implements, so the engine speaks of conversations, messages and members
// and never of a chat platform (the skills design: "Discord is her interface, not her self").
// References are opaque strings namespaced by the adapter's `iface`; content is typed with a safe
// mention default (nobody is notified unless named); every operation answers a result -- it never
// throws -- whose `status` says honestly what happened: `ok`, `failed` (known not to have taken
// effect), `unknown` (may have taken effect: never retried blindly), `unsupported` (this interface
// cannot do it), `forbidden` (it may not, e.g. someone else's message). The typedefs, the
// capability names and the pure helpers live in the protocol package (packages/protocol/actions.js,
// through src/protocol.js); this module re-exports them so every importer of the port is unchanged.

/** @typedef {import('../protocol.js').ConversationRef} ConversationRef */
/** @typedef {import('../protocol.js').MessageRef} MessageRef */
/** @typedef {import('../protocol.js').Attachment} Attachment */
/** @typedef {import('../protocol.js').Mentions} Mentions */
/** @typedef {import('../protocol.js').Content} Content */
/** @typedef {import('../protocol.js').PortError} PortError */
/** @typedef {import('../protocol.js').PortResult} PortResult */
/** @typedef {import('../protocol.js').Capabilities} Capabilities */
/** @typedef {import('../protocol.js').Port} Port */
/** @typedef {import('../protocol.js').Action} Action */

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
} from '../protocol.js';
