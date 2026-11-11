// The owner's commands of joining a root: `/interfaces invite <name>` prints the interface's invite link and opens
// joining on it for an hour, `/interfaces roots <name>` lists its roots with their state, and
// `/interfaces roots accept <name> <root>` and `/interfaces roots remove <name> <root>` serve a waiting root or stop
// serving one. The decisions are src/interface/root-joining.ts. Called by src/interface/commands/console.ts.

import type { JoiningAnswer, RootJoining } from '../root-joining.ts';

const word = (args: Readonly<Record<string, unknown>>, key: string): string =>
  typeof args[key] === 'string' ? args[key] : '';

const NAMES = new Set(['interfaces.invite', 'interfaces.roots', 'interfaces.roots.accept', 'interfaces.roots.remove']);

/** One of the four commands answered over the core's joining; null for any other command. */
export function rootsCommand(
  joining: RootJoining | null | undefined,
  name: string,
  args: Readonly<Record<string, unknown>>
): Promise<JoiningAnswer> | null {
  if (!NAMES.has(name)) return null;
  if (joining == null) return Promise.resolve({ text: 'joining runs in the core; start it first', status: 'failed' });
  const iface = word(args, 'name');
  switch (name) {
    case 'interfaces.invite':
      return joining.invite(iface);
    case 'interfaces.roots':
      return Promise.resolve(joining.roots(iface));
    case 'interfaces.roots.accept':
      return Promise.resolve(joining.accept(iface, word(args, 'root')));
    default:
      return Promise.resolve(joining.remove(iface, word(args, 'root')));
  }
}
