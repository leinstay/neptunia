// The persona's interface port: the one contract every interface adapter (the package's `port.ts`,
// scripts/lib/fake.ts) implements, so the engine speaks of chats, messages and members
// and never of a chat platform, since a platform is the persona's interface, not their self.
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
  MessageRef,
  Port,
  PortError,
  PortResult,
} from '../protocol/index.ts';

export type { ChatRef, MessageRef, Attachment, Content, PortError, PortResult, Capabilities, Port, Action };

export { CAPABILITIES, ok, notOk, isRefOf, refRefusal, contentRefusal, declaredHooks } from '../protocol/index.ts';
