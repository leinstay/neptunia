// Joining a root: which roots of an interface the core serves. Only the owner can add the bot to a root, so every root
// the interface reports is served. Each root it is added to (`joined`) or finds at its start (`present`) arrives as a
// `root.changed` event, and `rootChanged` serves it at once and writes its place. A root it leaves (`left`) stops being
// served at once, and nothing of her memory of it is removed. `/interfaces <name> invite` asks the interface for its
// invite link (the `invite.link` read), and `/interfaces <name> list` lists the roots she serves there. Both first refuse
// an interface with no stored token, a disabled one or one whose link is down, naming the repair. Every text is a label
// under `labels.roots`, which names a root by the interface's own noun and quotes no command itself. Built by
// src/core.ts; the commands are src/interface/commands/interfaces-roots.ts.

import { fill, formatDay } from '../format.ts';
import { log } from '../log.ts';
import type { RootRoutes } from '../core-routing.ts';
import type { RootChanged } from '../protocol/events.ts';
import type { ReadAnswer } from './reads.ts';

export type Named = { id: string; name: string; joinedAt?: number };
export type RootState = 'served';
export type RootRow = { id: string; name: string | null; state: RootState; joinedAt: number | null };
export type JoiningAnswer = { text: string; status: 'ok' | 'invalid' | 'failed'; code?: string };
/** Whether the interface has a stored token, is enabled by the owner, and has a link up now. */
export type InterfaceState = { token: boolean; enabled: boolean; connected: boolean };

export type RootJoiningDeps = {
  /** The live prompts: `labels.roots`, read at each use. */
  hot: { readonly prompts?: unknown };
  /** The clock, injected as in every module that decides. */
  now?: () => number;
  stateOf(iface: string): InterfaceState;
  routes: Pick<RootRoutes, 'note' | 'rootsOf'>;
  /** Writes the place of a root that starts to be served. */
  noteRoots(iface: string, roots: ReadonlyArray<Named>): void;
  invite(iface: string): Promise<ReadAnswer<'inviteLink'>>;
  /** The interface's own noun for its top place, as its `hello` declared it; absent or null, `labels.roots.noun`. */
  nounOf?(iface: string): string | null;
};

export type RootJoining = {
  /** What a reported root is now, or null when it is no longer served. */
  rootChanged(event: RootChanged): RootState | null;
  rows(iface: string): Array<RootRow>;
  invite(iface: string): Promise<JoiningAnswer>;
  roots(iface: string): JoiningAnswer;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** `labels.roots.<path>` of the live prompts, '' when it is missing. */
function labelOf(prompts: unknown, ...keys: Array<string>): string {
  const labels = isRecord(prompts) ? prompts.labels : null;
  let node: unknown = isRecord(labels) ? labels.roots : null;
  for (const key of keys) node = isRecord(node) ? node[key] : null;
  return typeof node === 'string' ? node : '';
}

/** The command that repairs each refusal of an interface that cannot work. */
const REPAIRS: Readonly<Record<string, (iface: string) => string>> = {
  'no-token': (iface) => `/interfaces ${iface} setup`,
  'interface-disabled': (iface) => `/interfaces ${iface} enable`,
  'link-down': (iface) => `neptunia services start neptunia-interface@${iface}`,
};

export function createRootJoining(deps: RootJoiningDeps): RootJoining {
  const { hot, routes } = deps;
  /** The last name and the moment of joining each interface reported for a root, for the list. */
  const names = new Map<string, Map<string, { name: string; joinedAt: number | null }>>();

  /** Keeps the name an event gave and, when it gave one, the moment of joining; a later event with none leaves the one kept. */
  const rememberName = (iface: string, root: Named): void => {
    const known = names.get(iface) ?? new Map<string, { name: string; joinedAt: number | null }>();
    known.set(root.id, { name: root.name, joinedAt: root.joinedAt ?? known.get(root.id)?.joinedAt ?? null });
    names.set(iface, known);
  };

  /**
   * `labels.roots.<path>` filled with every value a roots label may hold: the interface, its noun for a root, the root's
   * id and name, and the command a label names, so no label spells a platform word or a command itself.
   */
  function say(path: ReadonlyArray<string>, iface: string, root: { id?: string; name?: string } = {}, extra = {}) {
    const values: Record<string, string> = {
      iface,
      id: root.id ?? '',
      name: root.name ?? '',
      noun: deps.nounOf?.(iface) ?? labelOf(hot.prompts, 'noun'),
      invite: `/interfaces ${iface} invite`,
      ...extra,
    };
    return fill(labelOf(hot.prompts, ...path), values);
  }

  /** `labels.roots.since` with the day she joined as `YYYY-MM-DD` (UTC), '' for a root with no known moment. */
  function sinceOf(joinedAt: number | null): string {
    if (joinedAt === null) return '';
    const day = formatDay(joinedAt, 'UTC');
    return fill(labelOf(hot.prompts, 'since'), { day });
  }

  function refusal(code: string, iface: string): JoiningAnswer {
    const repair = REPAIRS[code]?.(iface) ?? '';
    const text = say(['refused', code], iface, {}, { repair });
    log.info('roots: refused', { iface, code });
    return { text, status: 'failed', code };
  }

  /** The refusal of an interface that cannot work, in the order its repairs come, or null. */
  function unworkable(iface: string): JoiningAnswer | null {
    const state = deps.stateOf(iface);
    if (!state.token) return refusal('no-token', iface);
    if (!state.enabled) return refusal('interface-disabled', iface);
    if (!state.connected) return refusal('link-down', iface);
    return null;
  }

  function rootChanged(event: RootChanged): RootState | null {
    const { iface, change } = event;
    const root: Named = { ...event.root, ...(typeof event.joinedAt === 'number' ? { joinedAt: event.joinedAt } : {}) };
    rememberName(iface, root);
    const served = routes.rootsOf(iface);
    if (change === 'left') {
      if (served.includes(root.id))
        routes.note(
          iface,
          served.filter((id) => id !== root.id)
        );
      log.info('roots: left', { iface, served: routes.rootsOf(iface).length });
      return null;
    }
    if (!served.includes(root.id)) routes.note(iface, [...served, root.id]);
    deps.noteRoots(iface, [root]);
    log.info('roots: served', { iface, served: routes.rootsOf(iface).length });
    return 'served';
  }

  function rows(iface: string): Array<RootRow> {
    return routes.rootsOf(iface).map((id): RootRow => ({
      id,
      name: names.get(iface)?.get(id)?.name ?? null,
      state: 'served',
      joinedAt: names.get(iface)?.get(id)?.joinedAt ?? null,
    }));
  }

  async function invite(iface: string): Promise<JoiningAnswer> {
    const refused = unworkable(iface);
    if (refused !== null) return refused;
    const answer = await deps.invite(iface);
    if (answer.status !== 'ok')
      return refusal(
        answer.status === 'unsupported' || answer.code === 'not-offered' ? 'no-invite' : 'invite-failed',
        iface
      );
    log.info('roots: invite link', { iface });
    return { text: say(['invite'], iface, {}, { url: answer.url }), status: 'ok' };
  }

  function roots(iface: string): JoiningAnswer {
    const refused = unworkable(iface);
    if (refused !== null) return refused;
    const found = rows(iface);
    if (found.length === 0) return { text: say(['none'], iface), status: 'ok' };
    const lines = found.map((row) =>
      say(
        ['row'],
        iface,
        { id: row.id, name: row.name ?? '' },
        { state: labelOf(hot.prompts, 'state', row.state), since: sinceOf(row.joinedAt) }
      ).trim()
    );
    return { text: lines.join('\n'), status: 'ok' };
  }

  return { rootChanged, rows, invite, roots };
}
