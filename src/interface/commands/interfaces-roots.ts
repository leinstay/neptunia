// The owner's commands over the roots of an interface: `/interfaces <name> invite` prints the interface's invite link,
// and `/interfaces <name> list` lists the roots she is in there. The decisions are src/interface/root-joining.ts.
// Called by src/interface/commands/console.ts.

import type { JoiningAnswer, RootJoining } from '../root-joining.ts';

const word = (args: Readonly<Record<string, unknown>>, key: string): string =>
  typeof args[key] === 'string' ? args[key] : '';

/** One of the two commands answered over the core's joining; null for any other command. */
export function rootsCommand(
  joining: RootJoining | null | undefined,
  name: string,
  args: Readonly<Record<string, unknown>>
): Promise<JoiningAnswer> | null {
  if (name !== 'interfaces.invite' && name !== 'interfaces.roots') return null;
  if (joining == null)
    return Promise.resolve({ text: 'the roots are known in the core; start it first', status: 'failed' });
  const iface = word(args, 'name');
  return name === 'interfaces.invite' ? joining.invite(iface) : Promise.resolve(joining.roots(iface));
}
