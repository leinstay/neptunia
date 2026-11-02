// `interface token set <iface>`: the owner gives an interface its platform token from the chat. The token is asked once
// through the chat's secret prompt (src/interface/commands/dialogs.ts) and written as `<VARIABLE>=<token>` into
// `<private>/clients/<iface>.env`, the environment file the interface's unit reads (deploy/neptunia-interface@.service).
// The file is mode 600, written whole to a temp file and renamed over the old one; its other lines are kept. The
// console (src/interface/commands/console.ts) routes the command here. No answer and no log line holds the token.

import fs from 'node:fs';
import path from 'node:path';
import { log } from '../../log.ts';
import type { Dialog } from '../../keys/commands.ts';

/** An interface name: lowercase letters, digits and dashes, starting with a letter, up to 32 characters. */
const IFACE_NAME = /^[a-z][a-z0-9-]{0,31}$/;

/** The variable the interface reads its platform token from: `my-chat` -> `MY_CHAT_TOKEN`, dashes become `_`. */
export function tokenVariableOf(iface: string): string {
  return `${iface.toUpperCase().replaceAll('-', '_')}_TOKEN`;
}

/** The lines of an existing environment file without the ones that set `variable`. */
function otherLines(file: string, variable: string): Array<string> {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const own = new RegExp(`^\\s*(export\\s+)?${variable}\\s*=`);
  return text.split('\n').filter((line) => line.trim() !== '' && !own.test(line));
}

/** Writes `text` over `file` at mode 600 through a temp file, so a reader never sees half a file. */
function writePrivate(file: string, text: string): void {
  const temp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temp, text, { mode: 0o600 });
    // The rename gives the file the temp file's mode, so the mode is set here, whatever the umask.
    fs.chmodSync(temp, 0o600);
    fs.renameSync(temp, file);
  } catch (err) {
    fs.rmSync(temp, { force: true });
    throw err;
  }
}

export async function setInterfaceToken({
  privateDir,
  iface,
  dialog,
}: {
  privateDir: string;
  iface: string;
  dialog: Dialog | null;
}): Promise<{ text: string; status: 'ok' | 'invalid' | 'failed' }> {
  if (!IFACE_NAME.test(iface))
    return {
      text: '/interface token set: an interface name is lowercase letters, digits and dashes, starting with a letter',
      status: 'invalid',
    };
  if (dialog === null)
    return { text: '/interface token set: the token is asked in the chat; run the command there', status: 'invalid' };
  const variable = tokenVariableOf(iface);
  // A paste often carries a trailing newline or space.
  const token = (await dialog.ask(`Token of ${iface} (${variable}):`, { secret: true })).trim();
  if (token === '' || /\s/.test(token))
    return {
      text: '/interface token set: a token is not blank and holds no whitespace; nothing is written',
      status: 'invalid',
    };
  const dir = path.join(privateDir, 'clients');
  const file = path.join(dir, `${iface}.env`);
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    writePrivate(file, `${[...otherLines(file, variable), `${variable}=${token}`].join('\n')}\n`);
  } catch (err) {
    log.warn('interface: the token file could not be written', {
      iface,
      code: (err as NodeJS.ErrnoException).code ?? null,
    });
    return { text: `/interface token set: clients/${iface}.env could not be written`, status: 'failed' };
  }
  log.info('interface: token set', { iface, variable });
  return {
    text: `${variable} is saved in clients/${iface}.env; the interface's unit reads it when it next starts.`,
    status: 'ok',
  };
}
