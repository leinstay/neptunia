// What the owner's chat reads and changes beside her turns: `session.*` over the chat sessions, `checkpoint.*` over the
// development checkpoints, `approval.*` over the board's gates and `context.read`. They are not rows of the command table, because only the chat's panels use them (bin/chat-panels.ts),
// and each answer is JSON for a panel to read. Only the `cli` principal reaches this (src/interface/neptunia-cli.ts), so the
// session authority stays here: the owner's command line holds the right to every session, and nothing else can ask.

import type { ChatSessions, OpenSession, SourceLine } from '../../chat/sessions.ts';
import type { MediaRow } from '../../memory/db/media-store.ts';
import type { ApprovalAnswer, ApprovalGate, ApprovalResult } from '../../board/approval-view.ts';
import type { CheckpointDesk } from '../../development/checkpoint-desk.ts';
import { createApprovalRelay } from '../../tools/approvals.ts';

export type ChatStateAnswer = { text: string; status: string; code?: string };

const textOf = (value: unknown): string => (typeof value === 'string' ? value : '');
const json = (value: unknown): ChatStateAnswer => ({ text: JSON.stringify(value), status: 'ok' });
const refused = (code: string): ChatStateAnswer => ({ text: `refused: ${code}`, status: 'invalid', code });

/** How many stored lines one page holds when the chat names no count. */
const PAGE_LINES = 100;

/**
 * One page of `lines` (oldest first): the newest `count` with `before` null, else the `count` lines just before the line
 * `before`; nothing when `before` is not among them.
 */
function pageOf<T extends { id: string }>(lines: ReadonlyArray<T>, before: string | null, count: number): Array<T> {
  const end = before === null ? lines.length : lines.findIndex((line) => line.id === before);
  return end < 0 ? [] : lines.slice(Math.max(0, end - count), end);
}

/** The kinds of a line's items that are no file to open: an address and an emoji. */
const NOT_FILES = new Set(['link', 'emoji']);

/** The items of a stored line that are files, in their order. */
const fileRows = (line: SourceLine): Array<MediaRow> => (line.media ?? []).filter((row) => !NOT_FILES.has(row.kind));

/**
 * The files of a stored line for `/attach open #N` and `/attach save #N` (interfaces/cli/chat-controller.ts), in their order: each
 * with its name, its kind, its kept path under the data folder, null for a file the core did not keep, and the
 * description memory stores for it.
 */
function filesOf(
  line: SourceLine
): Array<{ name: string; kind: string; path: string | null; description: string | null }> {
  return fileRows(line).map((row) => {
    const named = row.extra.fileName ?? row.extra.name;
    const name = typeof named === 'string' && named !== '' ? named : (row.path?.split('/').at(-1) ?? row.kind);
    return { name, kind: row.kind, path: row.path, description: row.description };
  });
}

/** A session and what it shows, for the chat to put on the screen and answer the core's history reads with. */
const shownOf = (answer: OpenSession): ChatStateAnswer => json({ session: answer.session, lines: answer.lines });

export type ChatState = {
  /** The answer of `name`, or null when it is not one of these. */
  command(name: string, args: Readonly<Record<string, unknown>>): Promise<ChatStateAnswer> | null;
};

/** The board's gates, as the owner's commands read and answer them inside the memory writer. */
export type ApprovalBoard = {
  gates(): Promise<ReadonlyArray<ApprovalGate>>;
  answer(answer: ApprovalAnswer): Promise<ApprovalResult>;
};

export function createChatState({
  sessions,
  checkpoints,
  approvals,
  context,
  place,
}: {
  sessions: ChatSessions;
  checkpoints: CheckpointDesk;
  approvals: ApprovalBoard;
  /** What the core knows of a request: a number it does not hold is null. */
  context: () => { usedTokens: number | null; limitTokens: number | null; route: string | null; model: string | null };
  /** The place of the owner's chat as memory stores it (identity-links.ts#ownerConsolePlace), null before his first line. */
  place: () => string | null;
}): ChatState {
  const relay = createApprovalRelay({ authorize: (answer) => approvals.answer(answer) });

  /** The gates as the board holds them now: a gate gone from the board leaves the relay too. */
  async function currentGates(): Promise<ChatStateAnswer> {
    const gates = await approvals.gates();
    const held = new Set(gates.map((gate) => `${gate.taskId}:${gate.scope}`));
    for (const old of relay.pending()) if (!held.has(`${old.taskId}:${old.scope}`)) relay.withdraw(old);
    for (const gate of gates) relay.present(gate);
    return json(relay.pending());
  }

  async function answerGate(args: Readonly<Record<string, unknown>>): Promise<ChatStateAnswer> {
    const note = typeof args.note === 'string' ? { note: args.note } : {};
    const answer = await relay.respond({
      taskId: textOf(args.taskId),
      scope: args.scope === 'merge' ? 'merge' : 'plan',
      revision: Number(args.revision),
      decision: args.decision === 'reject' ? 'reject' : 'approve',
      ...note,
    });
    if (answer.status === 'refused') return refused(answer.code);
    if (answer.result.status === 'refused') return refused(answer.result.code);
    return { text: `The board moved the task to ${answer.result.taskStatus}.`, status: 'ok' };
  }

  // A chat that opened before its place was stored starts at the root once the place is stored.
  let rootAsked = false;

  /** The chat's place now, its root opened and selected when the chat asked for it before the place was stored. */
  function placeNow(): string | null {
    const id = place();
    if (id !== null && rootAsked) {
      rootAsked = false;
      sessions.select(sessions.open({ placeId: id }).session.id);
    }
    return id;
  }

  /** The chat's stored lines as the current session shows them, one page at a time (interfaces/cli/chat-controller.ts). */
  function pageAnswer(args: Readonly<Record<string, unknown>>): ChatStateAnswer {
    const at = placeNow();
    const current = at === null ? null : sessions.current(at);
    const shown = current === null ? null : sessions.resume(current.id);
    const count = Number.isInteger(args.count) && Number(args.count) > 0 ? Number(args.count) : PAGE_LINES;
    const lines = shown?.ok ? pageOf(shown.lines, textOf(args.before) || null, count) : [];
    return json({
      lines: lines.map((line) => ({
        id: line.id,
        at: line.at,
        who: line.who,
        text: line.text,
        // The message id the line is stored under, which an edit or a deletion of it names.
        messageId: line.nativeId ?? line.id,
        ...(line.number === undefined ? {} : { number: line.number }),
        // The kinds of its files, in the names memory stores, which the chat draws as `[voice]` and the like.
        ...(fileRows(line).length === 0 ? {} : { files: fileRows(line).map((row) => row.kind) }),
      })),
    });
  }

  /** A line by the number the chat draws, with its files and message id: over the whole stored chat, whatever the session shows. */
  function lineAnswer(args: Readonly<Record<string, unknown>>): ChatStateAnswer {
    const number = Number(args.number);
    const at = placeNow();
    const line = Number.isInteger(number) && at !== null ? sessions.line(at, number) : null;
    if (line === null) return refused('unknown-line');
    // The message id a reply to the line names as its parent, as the core's history reads give it.
    return json({ number, messageId: line.nativeId ?? line.id, files: filesOf(line) });
  }

  function sessionCommand(name: string, args: Readonly<Record<string, unknown>>): ChatStateAnswer | null {
    switch (name) {
      case 'session.open': {
        const at = place();
        if (at === null) {
          rootAsked = true;
          return json({ session: null });
        }
        rootAsked = false;
        const root = sessions.open({ placeId: at });
        sessions.select(root.session.id);
        return json({ session: root.session });
      }
      case 'session.page':
        return pageAnswer(args);
      case 'session.line':
        return lineAnswer(args);
      case 'session.list':
        return json(sessions.list());
      case 'session.current': {
        const at = placeNow();
        return json(at === null ? null : sessions.current(at));
      }
      case 'session.inspect': {
        const answer = sessions.resume(textOf(args.id));
        return answer.ok
          ? json({ id: answer.session.id, memory: answer.memory, lines: answer.lines })
          : refused(answer.code);
      }
      case 'session.resume': {
        const answer = sessions.select(textOf(args.id));
        return answer.ok ? shownOf(answer) : refused(answer.code);
      }
      case 'session.branch': {
        const from = textOf(args.from);
        const boundary = textOf(args.boundary);
        const parent = sessions.resume(from);
        if (!parent.ok) return refused(parent.code);
        // One boundary of one session is one branch, whoever asks again and however often.
        const branched = sessions.branch({
          from,
          boundary,
          requestKey: `${from}:${boundary}`,
          authority: parent.authority,
        });
        if (!branched.ok) return refused(branched.code);
        const selected = sessions.select(branched.session.id);
        return selected.ok ? shownOf(selected) : refused(selected.code);
      }
      default:
        return null;
    }
  }

  async function checkpointCommand(name: string, args: Readonly<Record<string, unknown>>): Promise<ChatStateAnswer> {
    switch (name) {
      case 'checkpoint.list':
        return json(await checkpoints.list());
      case 'checkpoint.take': {
        const taken = await checkpoints.take(textOf(args.task));
        return taken.ok ? { text: `Took checkpoint ${taken.id}.`, status: 'ok' } : refused(taken.code);
      }
      case 'checkpoint.restore': {
        const restored = await checkpoints.restore(textOf(args.task), textOf(args.id), Number(args.revision));
        if (restored.status === 'refused') return refused(restored.code);
        const undo = `${restored.undoId} (revision ${restored.undoRevision}) brings the replaced state back.`;
        return restored.status === 'restored'
          ? { text: `Restored. ${undo}`, status: 'ok' }
          : { text: `The restore failed partway. ${undo}`, status: 'failed', code: restored.code };
      }
      default:
        return refused('unknown-command');
    }
  }

  return {
    command(name, args) {
      if (name.startsWith('checkpoint.')) return checkpointCommand(name, args);
      if (name === 'approval.list') return currentGates();
      if (name === 'approval.answer') return answerGate(args);
      if (name === 'context.read') return Promise.resolve(json(context()));
      if (!name.startsWith('session.')) return null;
      const answer = sessionCommand(name, args);
      return Promise.resolve(answer ?? refused('unknown-command'));
    },
  };
}
