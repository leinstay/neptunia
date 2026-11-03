// The optional service credentials of the persona's `keys.json`, section `services`: the YouTube Data API key, the
// Brave and Exa keys of quick search, and the video proxy. `serviceCredential` in src/keys/file.ts reads them for their
// one consumer. The owner sets them through `/keys service` and through the `services` step of `neptunia setup`.
// Answers name services and the last four characters, never a value.

import fs from 'node:fs';
import path from 'node:path';
import type { Dialog } from './commands.ts';
import { KEYS_FILE, serviceCredential } from './file.ts';

/** Each service, in the order they are listed, and what it is for. */
export const SERVICES = {
  youtube:
    'YouTube Data API key: reads video metadata when other methods fail, https://developers.google.com/youtube/data/getting-started',
  brave: 'Brave Search API key: the brave engine of quick search',
  exa: 'Exa API key: the exa engine of quick search',
  videoProxy: 'Video proxy URL: the route video downloads take, which may hold credentials',
} as const;
export type ServiceName = keyof typeof SERVICES;
export type ServiceAnswer = { text: string; status: string };

const isService = (name: string): name is ServiceName => Object.hasOwn(SERVICES, name);

function readStore(dataDir: string): Record<string, unknown> {
  const file = path.join(dataDir, KEYS_FILE);
  if (!fs.existsSync(file)) return {};
  const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
    throw new Error(`${KEYS_FILE} is not a JSON object`);
  return parsed as Record<string, unknown>;
}

/** Changes one service through a temp file at 0600, keeping every other section of the store. */
export function writeService(dataDir: string, name: ServiceName, value: string | null): void {
  const store = readStore(dataDir);
  const services = { ...(store.services as Record<string, unknown> | undefined) };
  if (value === null) delete services[name];
  else services[name] = value;
  const file = path.join(dataDir, KEYS_FILE);
  const temp = `${file}.${process.pid}.tmp`;
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  try {
    fs.writeFileSync(temp, `${JSON.stringify({ ...store, services }, null, 2)}\n`, { mode: 0o600 });
    fs.chmodSync(temp, 0o600);
    fs.renameSync(temp, file);
  } catch (err) {
    fs.rmSync(temp, { force: true });
    throw err;
  }
}

function listText(dataDir: string): string {
  return Object.keys(SERVICES)
    .filter(isService)
    .map((name) => {
      const value = serviceCredential(dataDir, name);
      return `${name}: ${value === null ? 'not set' : `set, ends in ${value.slice(-4)}`} (${SERVICES[name]})`;
    })
    .join('\n');
}

/** Runs `keys.service.list`, `.set` or `.clear`. A refused command writes nothing. */
export async function serviceCommand(
  dataDir: string,
  command: string,
  args: Readonly<Record<string, unknown>>,
  dialog: Dialog | null
): Promise<ServiceAnswer> {
  if (command === 'keys.service.list') return { text: listText(dataDir), status: 'ok' };
  const name = typeof args.name === 'string' ? args.name : '';
  if (!isService(name))
    return { text: `no service "${name}"; use one of ${Object.keys(SERVICES).join(', ')}`, status: 'invalid' };
  if (command === 'keys.service.clear') {
    writeService(dataDir, name, null);
    return { text: `${name} cleared`, status: 'ok' };
  }
  if (dialog === null) return { text: `${name} is asked in the chat; run the command there`, status: 'invalid' };
  const value = (await dialog.ask(`${SERVICES[name]}:`, { secret: true })).trim();
  if (value === '') return { text: `${name} needs a value; nothing is written`, status: 'invalid' };
  writeService(dataDir, name, value);
  return { text: `${name} set`, status: 'ok' };
}
