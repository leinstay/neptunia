// Durable chat sessions: a named view over the stored lines of one place, with a lineage. The lines stay where memory
// keeps them, and a session holds only their source ids and the times it was selected, so it copies, edits or deletes nothing.
// The root of a place shows its lines but those written while a branch was selected. A branch shows its parent's view up to
// the boundary, then the lines written while it was selected. Branching changes which lines the chat shows and sends as
// context, while memory stays continuous: what she learned after the boundary stays known. Names come from the owner's own
// first line, with no model. src/chat/store.ts is the real store, src/interface/commands/chat-state.ts the commands.

/** A stored line as memory holds it. `nativeId` is the interface's message id, when it has one. */
export type SourceLine = {
  id: string;
  placeId: string;
  at: number;
  who: 'owner' | 'her';
  text: string;
  nativeId?: string;
};

/** When a branch was the selected session: lines written from `from` until `to` are its own. */
export type SessionSpan = { from: number; to: number | null };

/** One stored session. `authority` is issued once, and `requestKey` makes a repeated branch the same branch. */
export type SessionRow = {
  id: string;
  placeId: string;
  parentId: string | null;
  boundarySourceId: string | null;
  requestKey: string | null;
  authority: string;
  createdAt: number;
  spans: ReadonlyArray<SessionSpan>;
};

export type ChatStore = {
  /** The place's stored lines, oldest first. Read only. */
  lines(placeId: string): ReadonlyArray<SourceLine>;
  sessions(): ReadonlyArray<SessionRow>;
  /** Writes `row` under its id, in place of an older one. */
  saveSession(row: SessionRow): void;
};

/** A session as a reader sees it. */
export type Session = Pick<SessionRow, 'id' | 'placeId' | 'parentId' | 'boundarySourceId'> & { name: string };

export type SessionSummary = Session & { lines: number; lastAt: number | null };

type Refusal = { ok: false; code: 'unknown-session' | 'unknown-boundary' | 'forbidden' };

/** A session with what it shows, and the authority that opens it again. */
export type OpenSession = {
  ok: true;
  session: Session;
  lines: ReadonlyArray<SourceLine>;
  authority: string;
  memory: 'continuous';
};

export type ChatSessions = {
  list(): Array<SessionSummary>;
  /** The root session of a place, made once. */
  open(request: { placeId: string }): OpenSession;
  /** A known session with its stored lines, after a restart too. Writes nothing. */
  resume(id: string): OpenSession | Refusal;
  /** A session read under its authority. */
  inspect(id: string, authority: string): OpenSession | Refusal;
  branch(request: { from: string; boundary: string; requestKey: string; authority: string }): OpenSession | Refusal;
  /** The session new lines of `placeId` belong to now: the branch selected there, else the root. */
  current(placeId: string): Session | null;
  /** Makes `id` the session new lines of its place belong to. */
  select(id: string): OpenSession | Refusal;
};

/** How much of the first line names a session. */
const NAME_CHARS = 60;
const EMPTY_NAME = 'Empty chat';

const inSpan = (span: SessionSpan, at: number): boolean => at >= span.from && (span.to === null || at < span.to);

export function createChatSessions({
  store,
  now,
  newId,
}: {
  store: ChatStore;
  now: () => number;
  newId: () => string;
}): ChatSessions {
  const rowOf = (id: string): SessionRow | null => store.sessions().find((row) => row.id === id) ?? null;

  /** The lines `row` shows: see the head of this file. */
  function viewOf(row: SessionRow): Array<SourceLine> {
    const lines = store.lines(row.placeId);
    const own = (span: ReadonlyArray<SessionSpan>, at: number): boolean => span.some((one) => inSpan(one, at));
    if (row.parentId === null) {
      const branches = store.sessions().filter((one) => one.placeId === row.placeId && one.parentId !== null);
      return lines.filter((line) => !branches.some((branch) => own(branch.spans, line.at)));
    }
    const parent = rowOf(row.parentId);
    const inherited = parent === null ? [] : viewOf(parent);
    const cut = inherited.findIndex((line) => line.id === row.boundarySourceId);
    const before = cut === -1 ? [] : inherited.slice(0, cut + 1);
    return [...before, ...lines.filter((line) => own(row.spans, line.at))];
  }

  function nameOf(row: SessionRow): string {
    const first = viewOf(row).find((line) => line.who === 'owner');
    if (first === undefined) return EMPTY_NAME;
    const words = first.text.replaceAll(/\s+/g, ' ').trim();
    return words === '' ? EMPTY_NAME : words.slice(0, NAME_CHARS);
  }

  const sessionOf = (row: SessionRow): Session => ({
    id: row.id,
    placeId: row.placeId,
    parentId: row.parentId,
    boundarySourceId: row.boundarySourceId,
    name: nameOf(row),
  });

  const opened = (row: SessionRow): OpenSession => ({
    ok: true,
    session: sessionOf(row),
    lines: viewOf(row),
    authority: row.authority,
    memory: 'continuous',
  });

  return {
    list: () =>
      store.sessions().map((row) => {
        const lines = viewOf(row);
        return { ...sessionOf(row), lines: lines.length, lastAt: lines.at(-1)?.at ?? null };
      }),
    open({ placeId }) {
      const known = store.sessions().find((row) => row.placeId === placeId && row.parentId === null);
      if (known !== undefined) return opened(known);
      const row: SessionRow = {
        id: newId(),
        placeId,
        parentId: null,
        boundarySourceId: null,
        requestKey: null,
        authority: newId(),
        createdAt: now(),
        spans: [],
      };
      store.saveSession(row);
      return opened(row);
    },
    resume(id) {
      const row = rowOf(id);
      return row === null ? { ok: false, code: 'unknown-session' } : opened(row);
    },
    inspect(id, authority) {
      const row = rowOf(id);
      if (row === null) return { ok: false, code: 'unknown-session' };
      return row.authority === authority ? opened(row) : { ok: false, code: 'forbidden' };
    },
    branch({ from, boundary, requestKey, authority }) {
      const parent = rowOf(from);
      if (parent === null) return { ok: false, code: 'unknown-session' };
      if (parent.authority !== authority) return { ok: false, code: 'forbidden' };
      const repeated = store.sessions().find((row) => row.parentId === from && row.requestKey === requestKey);
      if (repeated !== undefined) return opened(repeated);
      if (!viewOf(parent).some((line) => line.id === boundary)) return { ok: false, code: 'unknown-boundary' };
      const row: SessionRow = {
        id: newId(),
        placeId: parent.placeId,
        parentId: from,
        boundarySourceId: boundary,
        requestKey,
        authority: newId(),
        createdAt: now(),
        spans: [],
      };
      store.saveSession(row);
      return opened(row);
    },
    current(placeId) {
      const rows = store.sessions().filter((row) => row.placeId === placeId);
      const chosen = rows.find((row) => row.spans.some((span) => span.to === null));
      const row = chosen ?? rows.find((one) => one.parentId === null);
      return row === undefined ? null : sessionOf(row);
    },
    select(id) {
      const chosen = rowOf(id);
      if (chosen === null) return { ok: false, code: 'unknown-session' };
      const at = now();
      for (const row of store.sessions()) {
        if (row.placeId !== chosen.placeId || row.id === id) continue;
        if (row.spans.some((span) => span.to === null))
          store.saveSession({
            ...row,
            spans: row.spans.map((span) => (span.to === null ? { ...span, to: at } : span)),
          });
      }
      // The root owns whatever no branch owns, so only a branch keeps spans.
      const isOpen = chosen.parentId === null || chosen.spans.some((span) => span.to === null);
      const row = isOpen ? chosen : { ...chosen, spans: [...chosen.spans, { from: at, to: null }] };
      if (row !== chosen) store.saveSession(row);
      return opened(row);
    },
  };
}
