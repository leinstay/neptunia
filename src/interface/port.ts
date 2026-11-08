// The persona's interface port: the one contract every interface adapter (the package's `port.ts`,
// src/interface/fake.ts) implements, so the engine speaks of chats, messages and members
// and never of a chat platform (the skills design: "a platform is her interface, not her self").
// References are opaque strings namespaced by the adapter's `iface`; content is typed with a safe
// mention default (nobody is notified unless named); every operation answers a result -- it never
// throws -- whose `status` says honestly what happened: `ok`, `failed` (known not to have taken
// effect), `unknown` (may have taken effect: never retried blindly), `unsupported` (this interface
// cannot do it), `forbidden` (it may not, e.g. someone else's message). The typedefs, the
// capability names and the pure functions live in the protocol (src/protocol/actions.ts,
// through src/protocol/index.ts); this module re-exports them so every importer of the port is unchanged.

import type {
  Action,
  Attachment,
  Capabilities,
  Content,
  ChatRef,
  Mentions,
  MessageRef,
  Port,
  PortError,
  PortResult,
} from '../protocol/index.ts';

export type { ChatRef, MessageRef, Attachment, Mentions, Content, PortError, PortResult, Capabilities, Port, Action };

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
} from '../protocol/index.ts';
