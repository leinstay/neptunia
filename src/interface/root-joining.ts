// Joining a root: which roots of an interface the core serves, decided by the owner. `/interfaces invite <name>` asks
// the interface for its invite link (the `invite.link` read) and opens joining on it for an hour, as pairing opens
// (owner-pairing.ts). The interface reports each root it is added to, finds unlisted at its start, or leaves, as a
// `root.changed` event, and `rootChanged` decides: a root on the interface's roots setting is served, a root that joins
// while joining is open is served and written to the setting (and joining closes), and any other root waits. A waiting
// root has no route, so nothing of it reaches memory or a turn, and the owner gets one notice that names it.
// `/interfaces roots <name>` lists the served, waiting and listed-but-absent roots, `accept` serves a waiting one and
// `remove` stops serving one and takes it off the setting, leaving her memory of it as it is. Every command first
// refuses an interface with no stored token, a disabled one or one whose link is down, naming the repair. The waiting
// roots live in process memory: the interface reports them again at its next start. Every text is a label under
// `labels.roots`. Built by src/core.ts; the commands are src/interface/commands/interfaces-roots.ts.

import { log } from '../log.ts';
import type { RootRoutes } from '../core-routing.ts';
import type { RootChanged } from '../protocol/events.ts';
import { fillLabel } from './owner-pairing.ts';
import type { ReadAnswer } from './reads.ts';

/** How long joining stays open after an invite. */
export const JOINING_MS = 60 * 60_000;

export type Named = { id: string; name: string };
export type RootState = 'served' | 'waiting' | 'absent';
export type RootRow = { id: string; name: string | null; state: RootState };
export type JoiningAnswer = { text: string; status: 'ok' | 'invalid' | 'failed'; code?: string };
/** Whether the interface has a stored token, is enabled by the owner, and has a link up now. */
export type InterfaceState = { token: boolean; enabled: boolean; connected: boolean };
export type RootNotice = { iface: string; root: Named; text: string };

export type RootJoiningDeps = {
  /** The live prompts: `labels.roots`, read at each use. */
  hot: { readonly prompts?: unknown };
  now?: () => number;
  stateOf(iface: string): InterfaceState;
  /** The interface's roots setting; `read` is null when its package declares none. */
  listed: {
    read(iface: string): ReadonlyArray<string> | null;
    add(iface: string, rootId: string): void;
    remove(iface: string, rootId: string): void;
  };
  routes: Pick<RootRoutes, 'note' | 'rootsOf'>;
  /** Writes the place of a root that starts to be served. */
  noteRoots(iface: string, roots: ReadonlyArray<Named>): void;
  invite(iface: string): Promise<ReadAnswer<'inviteLink'>>;
  notify(notice: RootNotice): void;
};

export type RootJoining = {
  /** What a reported root is now, or null when the event names no root to keep. */
  rootChanged(event: RootChanged): RootState | null;
  isOpen(iface: string): boolean;
  rows(iface: string): Array<RootRow>;
  invite(iface: string): Promise<JoiningAnswer>;
  roots(iface: string): JoiningAnswer;
  accept(iface: string, rootId: string): JoiningAnswer;
  remove(iface: string, rootId: string): JoiningAnswer;
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
  'no-token': (iface) => `/interfaces setup ${iface}`,
  'interface-disabled': (iface) => `/interfaces enable ${iface}`,
  'link-down': (iface) => `neptunia services start neptunia-interface@${iface}`,
};

export function createRootJoining(deps: RootJoiningDeps): RootJoining {
  const { hot, routes, listed } = deps;
  const now = deps.now ?? Date.now;
  /** Until when joining is open, by interface. */
  const openUntil = new Map<string, number>();
  /** The roots that wait for the owner, by interface. */
  const waiting = new Map<string, Map<string, Named>>();
  /** The last name each interface reported for a root, for the list. */
  const names = new Map<string, Map<string, string>>();

  const waitingOf = (iface: string): Map<string, Named> => {
    const known = waiting.get(iface);
    if (known !== undefined) return known;
    const fresh = new Map<string, Named>();
    waiting.set(iface, fresh);
    return fresh;
  };
  const rememberName = (iface: string, root: Named): void => {
    const known = names.get(iface) ?? new Map<string, string>();
    known.set(root.id, root.name);
    names.set(iface, known);
  };
  const isOpen = (iface: string): boolean => (openUntil.get(iface) ?? 0) > now();

  function refusal(code: string, iface: string, rootId = '', status: JoiningAnswer['status'] = 'failed') {
    const repair = REPAIRS[code]?.(iface) ?? '';
    const text = fillLabel(labelOf(hot.prompts, 'refused', code), { iface, root: rootId, repair });
    log.info('roots: refused', { iface, code });
    return { text, status, code };
  }

  /** The refusal of an interface that cannot work, in the order its repairs come, or null. */
  function unworkable(iface: string, rootId = ''): JoiningAnswer | null {
    const state = deps.stateOf(iface);
    if (!state.token) return refusal('no-token', iface, rootId);
    if (!state.enabled) return refusal('interface-disabled', iface, rootId);
    if (!state.connected) return refusal('link-down', iface, rootId);
    return null;
  }

  function serve(iface: string, root: Named): void {
    const served = routes.rootsOf(iface);
    if (!served.includes(root.id)) routes.note(iface, [...served, root.id]);
    deps.noteRoots(iface, [root]);
    waiting.get(iface)?.delete(root.id);
  }

  function unserve(iface: string, rootId: string): void {
    const served = routes.rootsOf(iface);
    if (served.includes(rootId))
      routes.note(
        iface,
        served.filter((id) => id !== rootId)
      );
  }

  function wait(iface: string, root: Named): RootState {
    const roots = waitingOf(iface);
    const first = !roots.has(root.id);
    roots.set(root.id, root);
    if (first) {
      const text = fillLabel(labelOf(hot.prompts, 'notice'), { iface, root: root.id, name: root.name });
      deps.notify({ iface, root, text });
      log.info('roots: waiting', { iface, waiting: roots.size });
    }
    return 'waiting';
  }

  function rootChanged(event: RootChanged): RootState | null {
    const { iface, root, change } = event;
    rememberName(iface, root);
    if (change === 'left') {
      unserve(iface, root.id);
      waiting.get(iface)?.delete(root.id);
      log.info('roots: left', { iface });
      return 'absent';
    }
    const list = listed.read(iface);
    if (list?.includes(root.id) === true || routes.rootsOf(iface).includes(root.id)) {
      serve(iface, root);
      return 'served';
    }
    if (change === 'joined' && list !== null && isOpen(iface)) {
      listed.add(iface, root.id);
      serve(iface, root);
      openUntil.delete(iface);
      log.info('roots: joined while open', { iface, served: routes.rootsOf(iface).length });
      return 'served';
    }
    return wait(iface, root);
  }

  function rows(iface: string): Array<RootRow> {
    const nameOf = (id: string): string | null => names.get(iface)?.get(id) ?? null;
    const served = routes.rootsOf(iface);
    const held = [...(waiting.get(iface)?.values() ?? [])].filter((root) => !served.includes(root.id));
    const absent = (listed.read(iface) ?? []).filter(
      (id) => !served.includes(id) && !held.some((root) => root.id === id)
    );
    return [
      ...served.map((id): RootRow => ({ id, name: nameOf(id), state: 'served' })),
      ...held.map((root): RootRow => ({ id: root.id, name: root.name, state: 'waiting' })),
      ...absent.map((id): RootRow => ({ id, name: nameOf(id), state: 'absent' })),
    ];
  }

  async function invite(iface: string): Promise<JoiningAnswer> {
    const refused = unworkable(iface) ?? (listed.read(iface) === null ? refusal('no-roots-setting', iface) : null);
    if (refused !== null) return refused;
    const answer = await deps.invite(iface);
    if (answer.status !== 'ok')
      return refusal(
        answer.status === 'unsupported' || answer.code === 'not-offered' ? 'no-invite' : 'invite-failed',
        iface
      );
    openUntil.set(iface, now() + JOINING_MS);
    log.info('roots: joining open', { iface });
    return { text: fillLabel(labelOf(hot.prompts, 'invite'), { iface, url: answer.url }), status: 'ok' };
  }

  function roots(iface: string): JoiningAnswer {
    const refused = unworkable(iface);
    if (refused !== null) return refused;
    const found = rows(iface);
    if (found.length === 0) return { text: fillLabel(labelOf(hot.prompts, 'none'), { iface }), status: 'ok' };
    const lines = found.map((row) =>
      fillLabel(labelOf(hot.prompts, 'row'), {
        root: row.id,
        name: row.name ?? '',
        state: labelOf(hot.prompts, 'state', row.state),
      }).trim()
    );
    return { text: lines.join('\n'), status: 'ok' };
  }

  function accept(iface: string, rootId: string): JoiningAnswer {
    const refused =
      unworkable(iface, rootId) ?? (listed.read(iface) === null ? refusal('no-roots-setting', iface, rootId) : null);
    if (refused !== null) return refused;
    const root = waiting.get(iface)?.get(rootId);
    if (root === undefined) return refusal('not-waiting', iface, rootId, 'invalid');
    listed.add(iface, rootId);
    serve(iface, root);
    log.info('roots: accepted', { iface, served: routes.rootsOf(iface).length });
    return { text: fillLabel(labelOf(hot.prompts, 'accepted'), { iface, root: rootId }), status: 'ok' };
  }

  function remove(iface: string, rootId: string): JoiningAnswer {
    const list = listed.read(iface);
    const refused = unworkable(iface, rootId) ?? (list === null ? refusal('no-roots-setting', iface, rootId) : null);
    if (refused !== null) return refused;
    const known =
      routes.rootsOf(iface).includes(rootId) || list?.includes(rootId) === true || waiting.get(iface)?.has(rootId);
    if (known !== true) return refusal('unknown-root', iface, rootId, 'invalid');
    unserve(iface, rootId);
    listed.remove(iface, rootId);
    waiting.get(iface)?.delete(rootId);
    log.info('roots: removed', { iface, served: routes.rootsOf(iface).length });
    return { text: fillLabel(labelOf(hot.prompts, 'removed'), { iface, root: rootId }), status: 'ok' };
  }

  return { rootChanged, isOpen, rows, invite, roots, accept, remove };
}
