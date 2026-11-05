// The owner supplies a platform token through a secret dialog. The setter atomically writes the interface's
// data/interfaces/<name>/credentials.json at mode 0600, preserving other fields. Runtime interface startup reads
// the same file. Responses and logs contain paths and interface names, never token values.

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

/** Preserve independent fields when the owner rotates a platform token. */
function otherCredentials(file: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid credentials');
    return value as Record<string, unknown>;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw err;
  }
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
      text: '/interfaces token set: an interface name is lowercase letters, digits and dashes, starting with a letter',
      status: 'invalid',
    };
  if (dialog === null)
    return { text: '/interfaces token set: the token is asked in the chat; run the command there', status: 'invalid' };
  const variable = tokenVariableOf(iface);
  // A paste often carries a trailing newline or space.
  const token = (await dialog.ask(`Token of ${iface} (${variable}):`, { secret: true })).trim();
  if (token === '' || /\s/.test(token))
    return {
      text: '/interfaces token set: a token is not blank and holds no whitespace; nothing is written',
      status: 'invalid',
    };
  const dir = path.join(privateDir, 'interfaces', iface);
  const file = path.join(dir, 'credentials.json');
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    writePrivate(file, `${JSON.stringify({ ...otherCredentials(file), token }, null, 2)}\n`);
  } catch (err) {
    log.warn('interface: the token file could not be written', {
      iface,
      code: (err as NodeJS.ErrnoException).code ?? null,
    });
    return {
      text: `/interfaces token set: interfaces/${iface}/credentials.json could not be written`,
      status: 'failed',
    };
  }
  log.info('interface: token set', { iface, variable });
  return {
    text: `The token is saved in interfaces/${iface}/credentials.json; the interface reads it when it next starts.`,
    status: 'ok',
  };
}
