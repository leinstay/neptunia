// The open questions of the owner's commands, in process memory. A command that needs more than its line (the key
// value of `/keys add`) asks through a `Dialog`: the broker answers the command's request with a question (status
// `ask`, a `dialogId`, the prompt, whether the answer is secret), keeps the command waiting, and hands the answer to it
// when the chat sends a second `command.requested` with the same command name, the `dialogId` and the `answer`. That
// request is answered by whatever comes first: the command's next question, or its result. An open question expires
// after five minutes and the command it held ends without a result. The broker never logs, stores or echoes an answer:
// it passes the text to the waiting command and forgets it. Used by the command desk (src/interface/neptunia-cli.ts).

import { randomUUID } from 'node:crypto';
import type { Dialog } from '../../keys/commands.ts';

/** How long a question waits for its answer: past it the command ends and the answer is refused. */
export const DIALOG_EXPIRY_MS = 5 * 60_000;

/** A command's result: the text the owner reads and its outcome. */
export type Result = { text: string; status: string; code?: string };

/** A question to the owner: `text` is the prompt too, for a client that knows no dialog. */
export type Question = {
  status: 'ask';
  text: string;
  dialogId: string;
  prompt: string;
  secret: boolean;
  choices?: Array<string>;
};

export type DialogBroker = {
  /** Runs a command that may ask; resolves with its first question or, when it asks nothing, its result. */
  start(command: string, run: (dialog: Dialog) => Promise<Result>): Promise<Result | Question>;
  /** Hands `text` to the command waiting on `dialogId`; null when the dialog is unknown, expired or of another command. */
  answer(command: string, dialogId: string, text: string): Promise<Result | Question> | null;
};

type Session = {
  command: string;
  expiresAt: number;
  deliver: (reply: Result | Question) => void;
  /** Ends the request now waiting for a reply with the command's failure. */
  fail: (err: unknown) => void;
  /** The waiting `ask`, null between questions. */
  resolve: ((text: string) => void) | null;
  reject: ((err: Error) => void) | null;
};

export function createDialogBroker({
  now,
  newId = randomUUID,
  expiryMs = DIALOG_EXPIRY_MS,
}: {
  now: () => number;
  newId?: () => string;
  expiryMs?: number;
}): DialogBroker {
  const open = new Map<string, Session>();

  /** Ends the commands whose question went unanswered past the expiry. */
  function sweep(): void {
    for (const [id, session] of open) {
      if (session.expiresAt > now()) continue;
      open.delete(id);
      session.reject?.(new Error('the question expired before it was answered'));
    }
  }

  return {
    start(command, run) {
      sweep();
      return new Promise((deliver, fail) => {
        const id = newId();
        const session: Session = { command, expiresAt: Infinity, deliver, fail, resolve: null, reject: null };
        const dialog: Dialog = {
          ask: (question, options) =>
            new Promise<string>((resolve, reject) => {
              session.resolve = resolve;
              session.reject = reject;
              session.expiresAt = now() + expiryMs;
              open.set(id, session);
              session.deliver({
                status: 'ask',
                text: question,
                dialogId: id,
                prompt: question,
                secret: options?.secret === true,
                ...(options?.choices === undefined ? {} : { choices: [...options.choices] }),
              });
            }),
        };
        run(dialog).then(
          (result) => {
            open.delete(id);
            session.deliver(result);
          },
          (err: unknown) => {
            open.delete(id);
            session.fail(err);
          }
        );
      });
    },
    answer(command, dialogId, text) {
      sweep();
      const session = open.get(dialogId);
      if (session === undefined || session.command !== command || session.resolve === null) return null;
      const resolve = session.resolve;
      session.resolve = null;
      session.reject = null;
      return new Promise((deliver, fail) => {
        session.deliver = deliver;
        session.fail = fail;
        resolve(text);
      });
    },
  };
}
