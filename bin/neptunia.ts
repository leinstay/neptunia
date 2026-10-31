#!/usr/bin/env node
// The `neptunia` command (package.json `bin`): the owner's chat with the persona, one command for a script, the checks
// of an installation, the errand runner and the interface runner that the systemd units start, and the units
// themselves.
//
//   neptunia                                     the chat
//   neptunia -p "<command>"                      one command; its answer on stdout, exit 0 when it ran
//   neptunia doctor [--json]                     the checks of the installation, with the core up or down
//   neptunia errand-runner --profile <name>      the errand runner of one agent (deploy/neptunia-agent-<name>.service)
//   neptunia interface run <name> [--interfaces-dir <dir>]   one interface (deploy/neptunia-interface@.service)
//   neptunia service install|start|stop|restart|status [<unit> ...]   the units, through systemctl
//
// Every command reads `NEPTUNIA_PRIVATE_DIR` (the local layer) and `NEPTUNIA_DATA_DIR` (the data folder), as the core
// does (src/paths.js). A usage error exits 2.
//
// The chat is the `cli` interface. It connects to the core's socket `<data>/run/core.sock` with the token of the
// client `cli` (`<private>/clients/cli.token`, tools/client-token.mjs writes it) and says hello as `iface: 'cli'`. Each
// line typed is a `message.received` event in the direct chat `cli:dm:owner` between the owner and the persona, and
// her reply arrives as a send action and is printed. A line starting with `/` is a `command.requested` event: its
// answer is printed for the owner and never reaches her memory or her requests. `/clear` clears the screen and asks
// the core nothing. A line typed before the link is up waits in the input until it is. The chat opens with the core's
// header and, above it, the picture in `<private>/cli/picture.txt` when that file exists. In a terminal the command
// history is kept in `<private>/cli/history`. The end of the input ends the chat with exit 0, once the answers of the
// commands still running have arrived.
//
// `-p` sends one command the same way and prints its answer alone. It exits 0 when the core answers `ok`, 1 for any
// other answer or when no core listens. Log lines of the chat and of `-p` go to stderr.
//
// `doctor` asks the core nothing and writes nothing: it checks Node, the binaries the engine runs, config.json and
// config.local.json, the local layer, the `.env` keys of the enabled roles, the client tokens, the memory database
// (read only, with no lock) and the socket. `--json` prints `{ checks: [{ name, status, detail }] }`. A check is `ok`,
// `warn` or `fail`, and any `fail` exits 1. No key or token value is ever printed.
//
// `errand-runner` reads config.json and, when its user can read it, the local layer's config.local.json, takes the socket and the output folder
// from `agents.<name>.socket` and `.out` (src/agent-runner/profiles.js#agentSettings), and serves the agent's tasks
// (src/agent-runner/server.js). On SIGTERM it ends open tasks and exits 0.
//
// `interface run` loads `<dir>/<name>/index.ts` or `index.js` (the default dir is the checkout's `interfaces/`), reads
// the client's token from `<private>/clients/<name>.token`, connects to the core's socket and calls the package's
// `start(host)` with `host.dataDir` set to `<data>/interfaces/<name>`, where the interface keeps its outbox. Its
// settings are config.json, then the package's own config.json, then config.local.json when this user can read it,
// read again whenever one of the files changes. A link that drops is opened again with backoff, from a quarter second
// doubling to 30 seconds, and the backoff starts over once a link stayed up for 30 seconds. An interface that cannot
// reconnect (no `reconnect()`) ends the process with exit code 1, and its unit restarts it. SIGTERM and SIGINT stop
// the interface and exit 0.

import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import readline from 'node:readline';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { createRunnerServer } from '../src/agent-runner/server.js';
import { DEFAULT_OPENCODE_PATH, createOpencodeRunner } from '../src/agent-runner/opencode.js';
import { agentSettings, profileOf } from '../src/agent-runner/profiles.js';
import { startSweeper } from '../src/agent-runner/sweep.js';
import { ROOT_DIR, deepMerge, parseEnv, readConfig, resolveEnvRefs } from '../src/config.js';
import { moveConfigKeys } from '../src/config-moves.ts';
import { CLIENTS_FILE, loadPrincipals } from '../src/interface/principals.ts';
import { coreSocketPath } from '../src/interface/socket.ts';
import { log, logToStderr } from '../src/log.js';
import { resolvePaths } from '../src/paths.js';
import type {
  Adapter,
  Capabilities,
  ConversationInfo,
  Delivery,
  HistoryQuery,
  MessageEvent,
} from '../src/protocol/adapter.ts';
import type { InterfaceHost, RunningInterface } from '../src/protocol/host.ts';
import { serveAdapter } from '../src/protocol/serve.ts';
import type { CommandResult, Logger } from '../src/protocol/serve.ts';
import { MAX_FRAME_BYTES, connectSocket } from '../src/protocol/wire.ts';
import type { Transport } from '../src/protocol/wire.ts';

const USAGE = [
  'usage: neptunia                      the chat',
  '       neptunia -p "<command>"       one command, its answer on stdout',
  '       neptunia doctor [--json]',
  '       neptunia errand-runner --profile <name>',
  '       neptunia interface run <name> [--interfaces-dir <dir>]',
  '       neptunia service install|start|stop|restart|status [<unit> ...]',
].join('\n');

/** The first wait before a new connection, and the longest. */
const BACKOFF_FIRST_MS = 250;
const BACKOFF_MAX_MS = 30_000;
/** A link that stayed up this long was healthy: the backoff starts over after it. */
const STABLE_MS = 30_000;

/** An interface name as tools/client-token.mjs accepts a client name. */
const NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** The owner's command line: its client, its namespace and its one conversation. */
const CLI_CLIENT = 'cli';
const CLI_IFACE = 'cli';
const OWNER_ID = 'owner';
const CHAT_ID = 'cli:dm:owner';

/** The units `service` acts on when none is named: the core and the two errand runners (deploy/). */
const DEFAULT_UNITS = ['neptunia-core.service', 'neptunia-agent-scout.service', 'neptunia-agent-server.service'];
const SERVICE_VERBS = ['start', 'stop', 'restart', 'status'];

type Settings = Record<string, unknown>;
type InterfacePackage = { start(host: InterfaceHost): Promise<RunningInterface> };

function die(message: string): never {
  console.error(`neptunia: ${message}`);
  process.exit(message.startsWith('usage:') ? 2 : 1);
}

function usage(): never {
  return die(USAGE);
}

const isObject = (value: unknown): value is Settings =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const paths = (): { rootDir: string; privateDir: string; dataDir: string } => resolvePaths({ rootDir: ROOT_DIR });

/** The client's token, a trailing newline dropped. */
function readToken(privateDir: string, name: string): string {
  const file = path.join(privateDir, 'clients', `${name}.token`);
  let token: string;
  try {
    token = fs.readFileSync(file, 'utf8').replace(/\r?\n$/, '');
  } catch (err) {
    die(
      `cannot read the token ${file} (${(err as NodeJS.ErrnoException).code ?? 'error'}); run tools/client-token.mjs add`
    );
  }
  if (token === '') die(`the token file ${file} is empty`);
  return token;
}

/** A JSON object file, or null when it is absent or this user cannot read it. */
function readObject(file: string): Settings | null {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8').trim();
  } catch {
    return null;
  }
  if (text === '') return null;
  const value: unknown = JSON.parse(text);
  return isObject(value) ? value : null;
}

// ---------------------------------------------------------------------------------------------------------------
// The chat and -p: the `cli` interface.
// ---------------------------------------------------------------------------------------------------------------

/** What the command line declares to the core: it sends text and answers who its one conversation is. */
const CLI_CAPABILITIES: Capabilities = {
  operations: ['message.send', 'conversation.typing'],
  maxChars: 100_000,
  maxFiles: 0,
  maxFileBytes: 0,
  edit: { ownOnly: true, windowMs: null },
  history: false,
  threads: false,
  reactions: false,
  customEmoji: false,
  presence: false,
  voiceFormats: [],
  publish: [],
  search: false,
  reads: ['conversation.info', 'messages.history', 'messages.fetch'],
};

/** How many lines of this session the chat keeps to answer the core's history reads. */
const TRANSCRIPT_LINES = 200;

/** The one conversation of the command line: the direct chat between the owner and the persona. */
const CHAT_CONVERSATION = { id: CHAT_ID, kind: 'dm', communityId: null, name: OWNER_ID, partnerId: OWNER_ID } as const;

const CHAT_INFO: ConversationInfo = {
  ...CHAT_CONVERSATION,
  iface: CLI_IFACE,
  permissions: { read: true, send: true, attach: false, react: false },
  owner: null,
  lastMessageAt: null,
  voice: false,
  public: false,
  audience: null,
};

const unsupported = (): Promise<{
  status: 'unsupported';
  error: { code: string; retryable: boolean; retryAfterMs: null };
}> => Promise.resolve({ status: 'unsupported', error: { code: 'unsupported', retryable: false, retryAfterMs: null } });

/**
 * The command line's adapter: a send of the chat prints its text with `print` (none when the client takes no
 * replies, as `-p`), the conversation it answers is the chat, and the chat's history is `transcript`, the lines of
 * this session. Everything else is unsupported.
 */
function cliAdapter(print: ((text: string) => void) | null, transcript: Array<MessageEvent>): Adapter {
  const inChat = (conversation: { conversationId: string }): boolean => conversation.conversationId === CHAT_ID;
  const effectRefused = { status: 'unsupported' as const, error: { code: 'unsupported', retryable: false } };
  return {
    iface: CLI_IFACE,
    capabilities: () => CLI_CAPABILITIES,
    send(conversation, content, options = {}): Promise<Delivery> {
      const idempotencyKey = options.idempotencyKey ?? randomUUID();
      if (print === null || conversation.conversationId !== CHAT_ID) {
        const error = { code: 'unsupported', retryable: false, retryAfterMs: null };
        return Promise.resolve({ status: 'unsupported', ref: null, parts: [], at: null, idempotencyKey, error });
      }
      const text: unknown = isObject(content) ? content.text : null;
      const ref = { iface: CLI_IFACE, conversationId: CHAT_ID, messageId: randomUUID() };
      const at = Date.now();
      if (typeof text === 'string' && text !== '') {
        print(text);
        keep(transcript, lineEvent(text, at, { id: ref.messageId, self: true }));
      }
      return Promise.resolve({ status: 'ok', ref, parts: [ref], at, idempotencyKey, error: null });
    },
    edit: () => Promise.resolve(effectRefused),
    delete: () => Promise.resolve(effectRefused),
    react: () => Promise.resolve(effectRefused),
    unreact: () => Promise.resolve(effectRefused),
    typing: () => Promise.resolve({ status: 'ok' }),
    fetchMessages: (conversation, messageIds) =>
      inChat(conversation)
        ? Promise.resolve({
            status: 'ok',
            messages: messageIds.map((messageId) => {
              const event = transcript.find((line) => line.message.id === messageId);
              return event === undefined
                ? { messageId, missing: true }
                : { messageId, text: event.message.content ?? '', event };
            }),
          })
        : unsupported(),
    conversationInfo: (conversation) =>
      inChat(conversation) ? Promise.resolve({ status: 'ok', conversation: CHAT_INFO }) : unsupported(),
    conversations: unsupported,
    history: (conversation, query) =>
      inChat(conversation)
        ? Promise.resolve({ status: 'ok', events: historyOf(transcript, query), complete: true })
        : unsupported(),
    memberInfo: unsupported,
    searchMessages: unsupported,
    searchMembers: unsupported,
    emoji: unsupported,
    parseLinks: unsupported,
    reactors: unsupported,
  };
}

/** Keeps `event` in the transcript, the oldest line going first past TRANSCRIPT_LINES. */
function keep(transcript: Array<MessageEvent>, event: MessageEvent): void {
  transcript.push(event);
  if (transcript.length > TRANSCRIPT_LINES) transcript.shift();
}

/** The newest `limit` lines of the transcript before `query.before`, oldest first. */
function historyOf(transcript: ReadonlyArray<MessageEvent>, query: HistoryQuery): Array<MessageEvent> {
  const found = query.before === undefined ? -1 : transcript.findIndex((line) => line.message.id === query.before);
  const upTo = found === -1 ? transcript.length : found;
  return transcript.slice(Math.max(0, upTo - Math.max(0, query.limit)), upTo);
}

/** A line of the chat as a `message.received` event: the owner's, or with `self` the persona's reply. */
function lineEvent(text: string, at: number, options: { id?: string; self?: boolean } = {}): MessageEvent {
  const id = options.id ?? randomUUID();
  const self = options.self === true;
  return {
    kind: 'message.received',
    iface: CLI_IFACE,
    at,
    id: `${CLI_IFACE}:message:${id}`,
    conversation: CHAT_CONVERSATION,
    message: {
      id,
      author: self
        ? { id: 'self', name: null, self: true, bot: false }
        : { id: OWNER_ID, name: OWNER_ID, self: false, bot: false },
      content: text,
      sourceText: text,
      system: false,
      at,
      replyToId: null,
      replyPingUserId: null,
      forwardedFrom: null,
      attachments: [],
      links: [],
      forwarded: [],
      stickers: [],
      emojis: [],
      reactions: [],
    },
    addressing: { mentioned: false, replyToSelf: false, mentionedUserIds: [], mentionedConversationIds: [] },
  };
}

/**
 * A command line (`/interface list`, `status`) as the command's name and arguments: `interface` takes its action as
 * `interface.<action>` and the interface as `args.name`; any other command is its first word, with `full` as
 * `args.full`. Null for an empty line.
 */
function commandOf(line: string): { name: string; args: Record<string, unknown> } | null {
  const words = line
    .trim()
    .replace(/^\//, '')
    .split(/\s+/)
    .filter((word) => word !== '');
  const [first, second, third] = words;
  if (first === undefined) return null;
  if (first === 'interface' && second !== undefined)
    return { name: `interface.${second}`, args: third === undefined ? {} : { name: third } };
  return { name: first, args: second === 'full' ? { full: true } : {} };
}

/** One command as the `command.requested` event of the owner, answered by the `command.result` naming `replyRef`. */
function commandEvent(
  command: { name: string; args: Record<string, unknown> },
  replyRef: string
): Record<string, unknown> {
  return {
    kind: 'command.requested',
    iface: CLI_IFACE,
    at: Date.now(),
    id: `${CLI_IFACE}:command:${replyRef}`,
    conversation: CHAT_CONVERSATION,
    name: command.name,
    args: command.args,
    requester: { id: OWNER_ID, name: OWNER_ID, roles: [], owner: true },
    replyRef,
  };
}

const quiet: Logger = { info() {}, warn() {}, error() {} };

/** The command line's link to the core: its events, and the answers of its commands by their `replyRef`. */
type CliLink = {
  say(text: string): Promise<string>;
  ask(command: { name: string; args: Record<string, unknown> }): Promise<{ text: string; status: string }>;
  closed: Promise<void>;
  close(): void;
};

/** Connects as the `cli` client; rejects when no core listens. `print` takes her replies, null for none. */
async function openCliLink(print: ((text: string) => void) | null): Promise<CliLink> {
  const where = paths();
  const transcript: Array<MessageEvent> = [];
  const token = readToken(where.privateDir, CLI_CLIENT);
  const transport = await connectSocket({ path: coreSocketPath(where.dataDir), maxFrameBytes: MAX_FRAME_BYTES });
  const answers = new Map<string, (result: { text: string; status: string }) => void>();
  const closed = new Promise<void>((resolve) =>
    transport.onClose(() => {
      for (const resolveAnswer of answers.values())
        resolveAnswer({ text: 'The link to the core closed.', status: 'failed' });
      answers.clear();
      resolve();
    })
  );
  const served = serveAdapter({
    transport,
    hello: {
      iface: CLI_IFACE,
      self: { id: OWNER_ID, name: OWNER_ID },
      community: null,
      capabilities: CLI_CAPABILITIES,
      resume: null,
    },
    token,
    adapter: cliAdapter(print, transcript),
    log: quiet,
    onCommandResult: (result: CommandResult) => {
      const resolveAnswer = answers.get(result.replyRef);
      answers.delete(result.replyRef);
      resolveAnswer?.({ text: result.text, status: result.status ?? 'ok' });
    },
  });
  return {
    say(text) {
      const event = lineEvent(text, Date.now());
      keep(transcript, event);
      return served.emit(event);
    },
    async ask(command) {
      const replyRef = randomUUID();
      const answer = new Promise<{ text: string; status: string }>((resolve) => answers.set(replyRef, resolve));
      const acked = await served.emit(commandEvent(command, replyRef));
      if (acked !== 'ok') {
        answers.delete(replyRef);
        return { text: `The core did not take the command (${acked}).`, status: acked };
      }
      return answer;
    },
    closed,
    close: () => served.close(),
  };
}

async function runOne(argv: ReadonlyArray<string>): Promise<void> {
  const [line, ...rest] = argv;
  if (line === undefined || rest.length > 0) usage();
  const command = commandOf(line);
  if (command === null) usage();
  let link: CliLink;
  try {
    link = await openCliLink(null);
  } catch (err) {
    die(`no core listens (${(err as NodeJS.ErrnoException).code ?? 'error'}); start it with neptunia service start`);
  }
  const answer = await link.ask(command);
  process.stdout.write(answer.text.endsWith('\n') ? answer.text : `${answer.text}\n`);
  link.close();
  process.exit(answer.status === 'ok' ? 0 : 1);
}

/** The command history of a terminal chat, oldest last as readline keeps it; none when the file is unreadable. */
function readHistory(file: string): Array<string> {
  try {
    return fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .filter((line) => line !== '')
      .reverse();
  } catch {
    return [];
  }
}

function printBlock(text: string): void {
  process.stdout.write(text.endsWith('\n') ? text : `${text}\n`);
}

async function runChat(): Promise<void> {
  const where = paths();
  const terminal = process.stdin.isTTY === true && process.stdout.isTTY === true;
  let link: CliLink;
  try {
    link = await openCliLink(printBlock);
  } catch (err) {
    die(`no core listens (${(err as NodeJS.ErrnoException).code ?? 'error'}); start it with neptunia service start`);
  }
  const picture = path.join(where.privateDir, 'cli', 'picture.txt');
  if (fs.existsSync(picture)) printBlock(fs.readFileSync(picture, 'utf8'));
  const header = await link.ask({ name: 'header', args: {} });
  if (header.status === 'ok') printBlock(header.text);

  const historyFile = path.join(where.privateDir, 'cli', 'history');
  const input = readline.createInterface({
    input: process.stdin,
    output: terminal ? process.stdout : undefined,
    terminal,
    history: terminal ? readHistory(historyFile) : [],
    historySize: 1000,
  });
  if (terminal) {
    input.on('history', (lines: Array<string>) => {
      fs.mkdirSync(path.dirname(historyFile), { recursive: true, mode: 0o700 });
      fs.writeFileSync(historyFile, `${[...lines].reverse().join('\n')}\n`, { mode: 0o600 });
    });
    input.setPrompt('> ');
    input.prompt();
  }
  const running = new Set<Promise<unknown>>();
  const track = (work: Promise<unknown>): void => {
    running.add(work);
    void work.finally(() => running.delete(work));
  };
  input.on('line', (line: string) => {
    const text = line.trim();
    if (text === '') return;
    if (text === '/clear') {
      if (terminal) console.clear();
    } else if (text.startsWith('/')) {
      const command = commandOf(text);
      if (command !== null) track(link.ask(command).then((answer) => printBlock(answer.text)));
    } else {
      track(
        link.say(line).then((status) => {
          if (status !== 'ok') console.error(`neptunia: the core did not take the line (${status})`);
        })
      );
    }
    if (terminal) input.prompt();
  });
  await new Promise<void>((resolve) => input.once('close', () => resolve()));
  await Promise.race([Promise.all([...running]), link.closed]);
  link.close();
  process.exit(0);
}

// ---------------------------------------------------------------------------------------------------------------
// doctor
// ---------------------------------------------------------------------------------------------------------------

type CheckStatus = 'ok' | 'warn' | 'fail';
type Check = { name: string; status: CheckStatus; detail: string };

/** The major version of Node the engine runs on (package.json `engines`). */
const NODE_MAJOR = 26;

function checkNode(): Check {
  const major = Number(process.versions.node.split('.')[0]);
  return {
    name: 'node',
    status: major === NODE_MAJOR ? 'ok' : 'fail',
    detail: `node ${process.versions.node}, the engine needs ${NODE_MAJOR}`,
  };
}

/** ffmpeg turns her voice messages into the platform's format; without it `voice.say` is off. */
function checkBinaries(): Check {
  const ffmpeg = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' });
  return ffmpeg.status === 0
    ? { name: 'binaries', status: 'ok', detail: 'ffmpeg found' }
    : { name: 'binaries', status: 'warn', detail: 'ffmpeg not found: voice messages are off' };
}

/** The leaves of `local` whose type differs from the value config.json gives the same key. */
function mismatchedKeys(base: Settings, local: Settings, prefix = ''): Array<string> {
  const found: Array<string> = [];
  for (const [key, value] of Object.entries(local)) {
    if (!Object.hasOwn(base, key)) continue;
    const shipped = base[key];
    const at = prefix === '' ? key : `${prefix}.${key}`;
    if (isObject(shipped) && isObject(value)) found.push(...mismatchedKeys(shipped, value, at));
    else if (shipped !== null && value !== null && Array.isArray(shipped) !== Array.isArray(value)) found.push(at);
    else if (shipped !== null && value !== null && typeof shipped !== typeof value) found.push(at);
  }
  return found;
}

function checkConfig(where: { rootDir: string; privateDir: string }): Check {
  let base: Settings | null;
  let local: Settings | null;
  try {
    base = readObject(path.join(where.rootDir, 'config.json'));
    local = readObject(path.join(where.privateDir, 'config.local.json'));
  } catch (err) {
    return { name: 'config', status: 'fail', detail: `a config file is not JSON: ${(err as Error).message}` };
  }
  if (base === null) return { name: 'config', status: 'fail', detail: 'config.json is missing' };
  if (local === null)
    return { name: 'config', status: 'warn', detail: 'no config.local.json: the shipped settings apply' };
  const wrong = mismatchedKeys(base, moveConfigKeys(local).config);
  return wrong.length === 0
    ? { name: 'config', status: 'ok', detail: 'config.json and config.local.json read' }
    : { name: 'config', status: 'warn', detail: `keys of another type than config.json's: ${wrong.join(', ')}` };
}

function checkLocalLayer(where: { privateDir: string }): Check {
  if (!fs.existsSync(where.privateDir))
    return { name: 'local-layer', status: 'fail', detail: `${where.privateDir} does not exist` };
  const prompts = fs.existsSync(path.join(where.privateDir, 'prompts.local'));
  return {
    name: 'local-layer',
    status: 'ok',
    detail: prompts ? 'the local layer and prompts.local/ are there' : 'the local layer is there, no prompts.local/',
  };
}

/** The `.env` keys the enabled roles name (`llm.keyByRole`), beside the core's own: names only, never a value. */
function checkEnvKeys(where: { rootDir: string; privateDir: string }): Check {
  let names: Set<string>;
  try {
    names = new Set(Object.keys(parseEnv(fs.readFileSync(path.join(where.privateDir, '.env'), 'utf8'))));
  } catch {
    return { name: 'env-keys', status: 'fail', detail: 'no readable .env in the local layer' };
  }
  if (!names.has('OPENROUTER_CORE_KEY'))
    return { name: 'env-keys', status: 'fail', detail: 'OPENROUTER_CORE_KEY is not set' };
  let wanted: Array<string> = [];
  try {
    const config = readConfig(where.rootDir, { privateDir: where.privateDir }) as Settings;
    const byRole = isObject(config.llm) && isObject(config.llm.keyByRole) ? config.llm.keyByRole : {};
    wanted = Object.values(byRole).filter((name): name is string => typeof name === 'string' && name !== '');
  } catch {
    // A config that does not read is the config check's to report.
  }
  const missing = [...new Set(wanted)].filter((name) => !names.has(name));
  return missing.length === 0
    ? { name: 'env-keys', status: 'ok', detail: 'every key a role names is set' }
    : { name: 'env-keys', status: 'warn', detail: `not set: ${missing.join(', ')}` };
}

function checkTokens(where: { privateDir: string }): Check {
  const clients = loadPrincipals(where.privateDir);
  if (clients === null)
    return { name: 'tokens', status: 'warn', detail: `no ${CLIENTS_FILE}: only an in-process interface connects` };
  const problems: Array<string> = [];
  for (const client of clients) {
    const file = path.resolve(where.privateDir, client.tokenFile);
    try {
      const stat = fs.statSync(file);
      if (stat.size === 0) problems.push(`${client.name} empty`);
      else if ((stat.mode & 0o077) !== 0) problems.push(`${client.name} readable by others`);
    } catch {
      problems.push(`${client.name} missing`);
    }
  }
  if (clients.length === 0) return { name: 'tokens', status: 'warn', detail: `${CLIENTS_FILE} names no client` };
  return problems.length === 0
    ? { name: 'tokens', status: 'ok', detail: `${clients.length} clients, each token file in place` }
    : { name: 'tokens', status: 'fail', detail: problems.join(', ') };
}

/** The database's integrity, opened read only and immutable: no lock, no journal file, nothing written. */
function checkDatabase(where: { rootDir: string; privateDir: string; dataDir: string }): Check {
  let file = path.join(where.dataDir, 'memory.db');
  try {
    const config = readConfig(where.rootDir, { privateDir: where.privateDir }) as Settings;
    const name = isObject(config.memoryDb) ? config.memoryDb.file : null;
    if (typeof name === 'string' && name !== '') file = path.join(where.dataDir, name);
  } catch {
    // The default file name stands when the config does not read.
  }
  if (!fs.existsSync(file)) return { name: 'database', status: 'warn', detail: 'no memory database yet' };
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(`${pathToFileURL(file).href}?immutable=1`, { readOnly: true });
    const row = db.prepare('PRAGMA quick_check').get() as Record<string, unknown> | undefined;
    const verdict = row === undefined ? '' : String(Object.values(row)[0]);
    return verdict === 'ok'
      ? { name: 'database', status: 'ok', detail: 'quick_check ok' }
      : { name: 'database', status: 'fail', detail: `quick_check: ${verdict}` };
  } catch (err) {
    return { name: 'database', status: 'fail', detail: (err as Error).message };
  } finally {
    db?.close();
  }
}

function checkSocket(where: { dataDir: string }): Promise<Check> {
  const file = coreSocketPath(where.dataDir);
  return new Promise((resolve) => {
    if (!fs.existsSync(file)) {
      resolve({ name: 'socket', status: 'fail', detail: 'no core socket: the core is down' });
      return;
    }
    const conn = net.connect(file);
    conn.once('connect', () => {
      conn.end();
      resolve({ name: 'socket', status: 'ok', detail: 'the core listens' });
    });
    conn.once('error', (err: NodeJS.ErrnoException) =>
      resolve({ name: 'socket', status: 'fail', detail: `the socket does not answer (${err.code ?? 'error'})` })
    );
  });
}

async function runDoctor(argv: ReadonlyArray<string>): Promise<void> {
  const json = argv.includes('--json');
  if (argv.some((arg) => arg !== '--json')) usage();
  const where = paths();
  const checks: Array<Check> = [
    checkNode(),
    checkBinaries(),
    checkConfig(where),
    checkLocalLayer(where),
    checkEnvKeys(where),
    checkTokens(where),
    checkDatabase(where),
    await checkSocket(where),
  ];
  if (json) process.stdout.write(`${JSON.stringify({ checks })}\n`);
  else
    for (const check of checks)
      process.stdout.write(`${check.status.padEnd(4)}  ${check.name.padEnd(11)}  ${check.detail}\n`);
  process.exit(checks.some((check) => check.status === 'fail') ? 1 : 0);
}

// ---------------------------------------------------------------------------------------------------------------
// errand-runner
// ---------------------------------------------------------------------------------------------------------------

/** `--profile <name>`, the one flag of `errand-runner`. */
function profileFlag(argv: ReadonlyArray<string>): string {
  const [flag, name, ...rest] = argv;
  if (flag !== '--profile' || name === undefined || rest.length > 0) usage();
  return name;
}

// The runner's modules are JavaScript: their results are read through the fields named here.
type RunnerSettings = { socket?: unknown; out?: unknown; limits?: Settings; cost?: unknown; searchProvider?: unknown };
type Task = Settings & { id?: unknown; limits?: Settings; model?: unknown; cost?: unknown; searchProvider?: unknown };

async function runErrandRunner(argv: ReadonlyArray<string>): Promise<void> {
  const name = profileFlag(argv);
  const where = paths();
  const profile = profileOf(name) as (Settings & { defaultLimits?: Settings }) | null;
  if (profile === null) die(`unknown profile: ${name} (expected scout or server)`);
  // config.json, then config.local.json when this user can read it: the runner's user may not read the local layer.
  const files = createSettings([
    path.join(where.rootDir, 'config.json'),
    path.join(where.privateDir, 'config.local.json'),
  ]);
  const read = (): Settings => files.read();
  let config = read();
  const errands = isObject(config.errands) ? config.errands : {};
  const settings = (agentSettings(name, config) ?? {}) as RunnerSettings;
  const socketPath = typeof settings.socket === 'string' ? settings.socket : '';
  const outDir = typeof settings.out === 'string' ? settings.out : '';
  if (socketPath === '') die(`no socket for ${name}: set agents.${name}.socket`);
  if (outDir === '') die(`no output folder for ${name}: set agents.${name}.out`);
  const opencodePath = typeof errands.opencodePath === 'string' ? errands.opencodePath : DEFAULT_OPENCODE_PATH;
  fs.mkdirSync(outDir, { recursive: true });
  // The keys come with each task from the core; this environment is used only for what a task does not bring.
  if (!process.env.OPENROUTER_ERRAND_KEY)
    log.info('agent-runner: no key in the environment, each task brings its own', { profile: name });
  // The config as of each task (for the model role); the last readable one while the files are mid-edit.
  const currentConfig = (): Settings => {
    try {
      config = read();
    } catch (err) {
      log.warn('agent-runner: config reload failed', { profile: name, reason: (err as Error).name });
    }
    return config;
  };
  const engine = createOpencodeRunner({
    profile,
    outDir,
    env: process.env as Record<string, string>,
    opencodePath,
    getConfig: currentConfig,
  }) as { checkPrompt(): void; run(task: Task): Promise<unknown> };
  try {
    engine.checkPrompt();
  } catch (err) {
    die((err as Error).message);
  }
  const limitsDefault = {
    ...(profile.defaultLimits ?? {}),
    ...(settings.limits ?? {}),
    toolResultChars: errands.toolResultChars,
  };
  const runner = {
    run: (task: Task): Promise<unknown> =>
      engine.run({
        ...task,
        limits: { ...limitsDefault, ...(task.limits ?? {}) },
        model: task.model,
        cost: task.cost ?? settings.cost,
        searchProvider: task.searchProvider ?? settings.searchProvider,
      }),
  };
  const server = createRunnerServer({ profile: name, runner, socketPath }) as {
    start(): Promise<void>;
    stop(): Promise<void>;
    liveIds(): Array<string>;
  };
  await server.start();
  log.info('agent-runner: ready', { profile: name, socket: socketPath, out: outDir, opencode: opencodePath });
  const sweeper = startSweeper({
    profile: name,
    outDir,
    keepHours: () =>
      isObject(currentConfig().errands) ? (currentConfig().errands as Settings).keepFilesHours : undefined,
    liveIds: () => server.liveIds(),
  }) as { stop(): void };
  let stopping = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    log.info('agent-runner: shutting down', { profile: name, signal });
    sweeper.stop();
    await server.stop();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

// ---------------------------------------------------------------------------------------------------------------
// service
// ---------------------------------------------------------------------------------------------------------------

function runService(argv: ReadonlyArray<string>): void {
  const [verb, ...units] = argv;
  if (verb === 'install') {
    const run = spawnSync(path.join(ROOT_DIR, 'deploy', 'install.sh'), units, { stdio: 'inherit' });
    process.exit(run.status ?? 1);
  }
  if (verb === undefined || !SERVICE_VERBS.includes(verb)) usage();
  const run = spawnSync('systemctl', [verb, ...(units.length > 0 ? units : DEFAULT_UNITS)], { stdio: 'inherit' });
  process.exit(run.status ?? 1);
}

// ---------------------------------------------------------------------------------------------------------------
// interface run
// ---------------------------------------------------------------------------------------------------------------

/** The interface name and folder of `interface run`, or a usage error. */
function parseRun(argv: ReadonlyArray<string>): { name: string; interfacesDir: string } {
  const [command, name, ...rest] = argv;
  if (command !== 'run' || name === undefined) usage();
  if (!NAME.test(name)) die(`invalid interface name "${name}"; use lowercase letters, digits, - and _`);
  let interfacesDir = path.join(ROOT_DIR, 'interfaces');
  for (let i = 0; i < rest.length; i += 1) {
    const value = rest[i + 1];
    if (rest[i] !== '--interfaces-dir' || value === undefined) usage();
    interfacesDir = path.resolve(value);
    i += 1;
  }
  return { name, interfacesDir };
}

/** The package's entry, `index.ts` before `index.js`. */
async function loadPackage(dir: string): Promise<InterfacePackage> {
  const entry = ['index.ts', 'index.js'].map((file) => path.join(dir, file)).find((file) => fs.existsSync(file));
  if (entry === undefined) die(`no index.ts or index.js in ${dir}`);
  const loaded: unknown = await import(pathToFileURL(entry).href);
  const start: unknown = loaded !== null && typeof loaded === 'object' ? Reflect.get(loaded, 'start') : undefined;
  if (typeof start !== 'function') die(`${entry} exports no start(host)`);
  // The package's start is the function the interface contract names (src/protocol/host.ts).
  return { start: start as InterfacePackage['start'] };
}

/** When `file` last changed, or 0 when it cannot be seen. */
function changedAt(file: string): number {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

/** The interface's settings, read again when a file changed. Each change that read well is told to the listeners. */
function createSettings(files: ReadonlyArray<string>) {
  const listeners = new Set<(what: string) => void>();
  let stamp = '';
  let current: Settings = {};
  function read(): Settings {
    const now = files.map(changedAt).join(':');
    if (now === stamp) return current;
    const [base = '', ...layers] = files;
    try {
      let merged = readObject(base) ?? {};
      for (const [index, file] of layers.entries()) {
        const layer = readObject(file);
        if (layer === null) continue;
        // The last layer is config.local.json, read with its keys of an old name under the new one, as the core reads it.
        merged = deepMerge(merged, index === layers.length - 1 ? moveConfigKeys(layer).config : layer) as Settings;
      }
      current = resolveEnvRefs(merged) as Settings;
    } catch (err) {
      if (stamp === '') throw err;
      log.warn('interface: settings not reloaded, keeping the previous ones', { error: err });
    }
    const first = stamp === '';
    stamp = now;
    if (!first) for (const listener of listeners) listener('config');
    return current;
  }
  return {
    read,
    onChange(listener: (what: string) => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

async function runInterface(argv: ReadonlyArray<string>): Promise<void> {
  const { name, interfacesDir } = parseRun(argv);
  const where = paths();
  const packageDir = path.join(interfacesDir, name);
  const pkg = await loadPackage(packageDir);
  const token = readToken(where.privateDir, name);
  const socketPath = coreSocketPath(where.dataDir);
  const settings = createSettings([
    path.join(where.rootDir, 'config.json'),
    path.join(packageDir, 'config.json'),
    path.join(where.privateDir, 'config.local.json'),
  ]);
  settings.read();

  let delays = 0;
  let stopping = false;
  let reconnecting = false;
  let lostEarly = false;
  let running: RunningInterface | null = null;
  const nextDelay = (): number => {
    const ms = Math.min(BACKOFF_MAX_MS, BACKOFF_FIRST_MS * 2 ** delays);
    delays = Math.min(delays + 1, 16);
    return ms;
  };

  function reconnect(): void {
    if (stopping || reconnecting) return;
    if (running === null) {
      lostEarly = true;
      return;
    }
    const again: (() => Promise<void>) | undefined = running.reconnect?.bind(running);
    if (again === undefined) {
      log.error('interface: link lost and the interface cannot reconnect, exiting for a restart', { name });
      process.exit(1);
    }
    reconnecting = true;
    const ms = nextDelay();
    log.info('interface: link lost, connecting again', { name, inMs: ms });
    setTimeout(() => {
      again()
        .catch((err: unknown) => log.warn('interface: reconnect failed', { name, error: err }))
        .finally(() => {
          reconnecting = false;
        });
    }, ms);
  }

  // A transport that this side closed (`closed`) was closed by the interface itself, on a reconnect or a stop.
  function watch(transport: Transport): void {
    const openedAt = Date.now();
    transport.onClose((reason) => {
      if (reason === 'closed' || stopping) return;
      if (Date.now() - openedAt >= STABLE_MS) delays = 0;
      reconnect();
    });
  }

  async function connect(): Promise<Transport> {
    for (;;) {
      if (stopping) throw new Error('the interface is stopping');
      try {
        const transport = await connectSocket({ path: socketPath, maxFrameBytes: MAX_FRAME_BYTES });
        watch(transport);
        return transport;
      } catch (err) {
        const ms = nextDelay();
        log.info('interface: core not reachable, trying again', {
          name,
          code: (err as NodeJS.ErrnoException).code ?? null,
          inMs: ms,
        });
        await sleep(ms);
      }
    }
  }

  const host: InterfaceHost = {
    connect,
    token,
    dataDir: path.join(where.dataDir, 'interfaces', name),
    env: process.env,
    config: () => settings.read(),
    onConfigChange: (listener) => settings.onChange(listener),
    log,
  };

  async function stop(signal: string): Promise<void> {
    if (stopping) return;
    stopping = true;
    log.info('interface: stopping', { name, signal });
    await running?.stop().catch((err: unknown) => log.warn('interface: stop failed', { name, error: err }));
    process.exit(0);
  }
  process.on('SIGTERM', () => void stop('SIGTERM'));
  process.on('SIGINT', () => void stop('SIGINT'));

  running = await pkg.start(host);
  running.open();
  log.info('interface: running', { name, iface: running.iface });
  if (lostEarly) reconnect();
}

// ---------------------------------------------------------------------------------------------------------------

const [group, ...rest] = process.argv.slice(2);
const fault = (err: unknown): never => die(err instanceof Error ? err.message : String(err));
switch (group) {
  case undefined:
    logToStderr();
    await runChat().catch(fault);
    break;
  case '-p':
    logToStderr();
    await runOne(rest).catch(fault);
    break;
  case 'doctor':
    logToStderr();
    await runDoctor(rest).catch(fault);
    break;
  case 'errand-runner':
    await runErrandRunner(rest).catch(fault);
    break;
  case 'service':
    runService(rest);
    break;
  case 'interface':
    await runInterface(rest).catch(fault);
    break;
  default:
    usage();
}
