// `/logs`: the arguments of `journalctl` for the core's unit in the scope `service` and setup resolve
// (src/service/manager.ts#unitScope), and one read through an injected runner. A user unit's lines are in the user's
// journal, so `--user` goes with that scope. A manager that refuses or cannot run is a failure naming the scope, which a
// script tells apart from a journal with no lines. Following the journal is the chat's, which keeps a process open for it.

import { whyFailed } from '../setup/install.ts';
import { CORE_UNIT, unitScope } from './manager.ts';
import type { Environment, RunManager } from './manager.ts';

const JOURNAL_COMMAND = 'journalctl';

/** The words of `/logs` (`errors`, `since <value>`, `follow`) as arguments of `journalctl`. */
function journalWords(options: string): { args: Array<string>; follow: boolean } {
  const words = options.split(' ').filter((word) => word !== '');
  const args: Array<string> = [];
  let follow = false;
  for (let i = 0; i < words.length; i += 1) {
    const word = words[i];
    if (word === 'errors') args.push('-p', 'err');
    else if (word === 'follow') follow = true;
    else if (word === 'since') {
      i += 1;
      // The table refused `since` without a value; the value is the rest of the words up to the next keyword.
      const value: Array<string> = [];
      while (i < words.length && words[i] !== 'errors' && words[i] !== 'follow') {
        value.push(words[i] ?? '');
        i += 1;
      }
      i -= 1;
      args.push('--since', value.join(' '));
    }
  }
  return { args, follow };
}

/** Whether the words of `/logs` ask to follow the journal. */
export const followsJournal = (options: string): boolean => journalWords(options).follow;

/** The call that reads the core's journal in the scope of `env`, with `-f` when the words follow it. */
export function journalCall(env: Environment, options: string): [string, Array<string>] {
  const { args, follow } = journalWords(options);
  const scope = unitScope(env) === 'user' ? ['--user'] : [];
  return [JOURNAL_COMMAND, [...scope, '-u', CORE_UNIT, '--no-pager', ...args, ...(follow ? ['-f'] : [])]];
}

/** `/logs` once: the journal's lines, `(no lines)`, or why the manager of the scope did not give them. */
export async function readJournal(
  env: Environment,
  options: string,
  run: RunManager
): Promise<{ status: 'ok' | 'failed' | 'invalid'; text: string }> {
  if (followsJournal(options)) return { status: 'invalid', text: '/logs follow: only the chat follows the journal' };
  const scope = unitScope(env);
  const [command, args] = journalCall(env, options);
  try {
    const done = await run(command, args);
    if (done.code === 0) return { status: 'ok', text: done.stdout === '' ? '(no lines)' : done.stdout };
    return { status: 'failed', text: `/logs: the ${scope} journal did not answer: ${whyFailed(done)}` };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? 'error';
    return { status: 'failed', text: `/logs: journalctl of the ${scope} scope does not run here (${code})` };
  }
}
