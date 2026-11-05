// What the owner's chat reads and changes beside her turns: `session.*` over the conversation sessions and `checkpoint.*` over
// the development checkpoints. They are not rows of the command table, because only the chat's panels use them (bin/chat-panels.ts),
// and each answer is JSON for a panel to read. Only the `cli` principal reaches this (src/interface/neptunia-cli.ts), so the
// session authority stays here: the owner's command line holds the right to every session, and nothing else can ask.

import type { ConversationSessions, OpenSession } from '../../conversation/sessions.ts';
import type { CheckpointDesk } from '../../development/checkpoint-desk.ts';

export type ChatStateAnswer = { text: string; status: string; code?: string };

/** The one conversation of the owner's command line, as memory places it (src/memory/db/ids.ts#dmPlaceId). */
const CLI_PLACE = 'cli:dm:owner';

const textOf = (value: unknown): string => (typeof value === 'string' ? value : '');
const json = (value: unknown): ChatStateAnswer => ({ text: JSON.stringify(value), status: 'ok' });
const refused = (code: string): ChatStateAnswer => ({ text: `refused: ${code}`, status: 'invalid', code });

/** A session and what it shows, for the chat to put on the screen and answer the core's history reads with. */
const shownOf = (answer: OpenSession): ChatStateAnswer => json({ session: answer.session, lines: answer.lines });

export type ChatState = {
  /** The answer of `name`, or null when it is not one of these. */
  command(name: string, args: Readonly<Record<string, unknown>>): Promise<ChatStateAnswer> | null;
};

export function createChatState({
  sessions,
  checkpoints,
}: {
  sessions: ConversationSessions;
  checkpoints: CheckpointDesk;
}): ChatState {
  function sessionCommand(name: string, args: Readonly<Record<string, unknown>>): ChatStateAnswer | null {
    switch (name) {
      case 'session.open': {
        const root = sessions.open({ placeId: CLI_PLACE });
        sessions.select(root.session.id);
        return json({ session: root.session });
      }
      case 'session.list':
        return json(sessions.list());
      case 'session.current':
        return json(sessions.current(CLI_PLACE));
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
      if (!name.startsWith('session.')) return null;
      const answer = sessionCommand(name, args);
      return Promise.resolve(answer ?? refused('unknown-command'));
    },
  };
}
