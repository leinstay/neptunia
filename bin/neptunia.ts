#!/usr/bin/env node
// The `neptunia` command (package.json `bin`): the owner's chat with the persona, one command for a script, the checks
// of an installation, the errand runner and the interface runner that the systemd units start, and the units
// themselves.
//
//   neptunia                                     the chat
//   neptunia -p "<command>"                      one command; its answer on stdout, exit 0 when it ran
//   neptunia doctor [--live] [--json]            the checks of the installation, with the core up or down
//   neptunia errand-runner --profile <name>      the errand runner of one agent (deploy/neptunia-agent-<name>.service)
//   neptunia interface run <name> [--interfaces-dir <dir>]   one interface (deploy/neptunia-interface@.service)
//   neptunia plugin run <name>                   one plugin (deploy/neptunia-plugin@.service)
//   neptunia service start|stop|restart|status [<unit> ...]   the units, through systemctl
//   neptunia setup [--system] [--node <path>] [<step>]  the install of one user: folders, keys file, her subharness
//                                                backends, the repository of her self-development, her mechanics,
//                                                the watcher, units, linger, the core
//   neptunia setup subharness <backend> [--from <path>]   one subharness backend into <private>/subharness/<backend>/
//   neptunia task <command> [options]            the task board's command line (bin/neptunia-task.ts)
//   neptunia watcher run                         one run of the daily watcher (deploy/neptunia-watcher.service)
//
// Every command reads `NEPTUNIA_PRIVATE_DIR` (the local layer) and `NEPTUNIA_DATA_DIR` (the data folder), as the core
// does (src/paths.ts). A usage error exits 2.
//
// The chat is the `cli` interface. It connects to the core's socket `<data>/run/core.sock` with the token of the
// client `cli` (`<private>/clients/cli.token`, scripts/client-token.ts writes it) and says hello as `iface: 'cli'`. Each
// line typed is a `message.received` event in the direct chat `cli:dm:owner` between the owner and the persona, and
// her reply arrives as a send action and is printed. A line starting with `/` is parsed by the command table
// (src/interface/commands/table.ts), which prints the reason of a line it refuses, and becomes a `command.requested`
// event: its answer is printed for the owner and never reaches her memory or her requests. `/clear`, `/doctor`,
// `/logs` (journalctl of the core's unit, from PATH) and `/report` (the watcher's report, rendered by bin/markdown.ts)
// run here and ask the core nothing, but `/doctor live` asks it for the probes of the model roles. A line typed before the link is up waits in the input until it is. The chat opens with the core's
// header and, above it, the picture in `<private>/cli/picture.txt` when that file exists. In a terminal the command
// history is kept in `<private>/cli/history`. The end of the input ends the chat with exit 0, once the answers of the
// commands still running have arrived.
//
// `-p` sends one command the same way and prints its answer alone. It exits 0 when the command ran, 1 for a line the
// table refuses (the reason on stderr), for any other answer than `ok`, or when no core listens for a command that
// needs one. Log lines of the chat and of `-p` go to stderr.
//
// `watcher run` reads the watcher's folder (`watcher.dir`, default `.agents/watcher`: `prompt.md` and `reports/`), asks
// the watcher agent once (src/watcher/run.ts) and writes `reports/<UTC date>.md`. It files the tasks the agent asks for
// on the board over the core's socket as the client `NEPTUNIA_TASK_CLIENT` (default `watcher`, whose token is
// `NEPTUNIA_TASK_TOKEN` or `<private>/clients/watcher.token`). It exits 0 for a report written or already there, and 1
// for a run that failed, with the code on stderr.
//
// `selfimprovement run` runs one beat of her self-development (bin/selfimprovement.ts, docs/selfimprovement.md) as the client `selfimprovement`: her fix
// proposals are taken, each approved one is patched in a worktree and opened as a pull request, and the open ones are
// looked at. It exits 0 for a beat that ran and 1 when the board is not reachable.
//
// `doctor` writes nothing and asks the core nothing without `--live`: it checks Node, the binaries the engine runs, config.json and
// config.local.json, the local layer, the `.env` keys of the enabled roles, the client tokens, the features (the
// subharness and the simulation, a warning while either is off), the memory database (read only, with no lock) and the socket. `--live` adds `providers`, the core's probes of the model roles, which is
// `skipped` when no core answers, since the command line holds no key. `--json` prints
// `{ checks: [{ name, status, detail }] }`. A check is `ok`, `warn`, `fail` or `skipped`, and any `fail` exits 1. No
// key or token value is ever printed.
//
// `errand-runner` reads config.json and, when its user can read it, the local layer's config.local.json, takes the socket and the output folder
// from `agents.<name>.socket` and `.out` (src/agent-runner/profiles.ts#agentSettings), and serves the agent's tasks
// (src/agent-runner/server.ts). On SIGTERM it ends open tasks and exits 0.
//
// `interface run` loads `<dir>/<name>/index.ts` or `index.js` (the default dir is the checkout's `interfaces/`), reads
// the client's token from `<private>/clients/<name>.token`, connects to the core's socket and calls the package's
// `start(host)` with `host.dataDir` set to `<data>/interfaces/<name>`, where the interface keeps its outbox. Its
// settings are the core's (config/config.json, then the private settings file when this user can read it), then the
// package's own config.json, then the private `config.local/interfaces/<name>.json` (src/config/files.ts#readInterfaceConfig),
// read again whenever one of the files changes. A link that drops is opened again with backoff, from a quarter second
// doubling to 30 seconds, and the backoff starts over once a link stayed up for 30 seconds. An interface that cannot
// reconnect (no `reconnect()`) ends the process with exit code 1, and its unit restarts it. SIGTERM and SIGINT stop
// the interface and exit 0.
//
// `plugin run` loads `<private>/plugins.local/<name>/index.ts` (or `index.js`) before `<root>/plugins/<name>/index.ts`,
// the folder's `plugin.json` as the manifest, reads the token from `$CREDENTIALS_DIRECTORY/token` (the unit's
// `LoadCredential=`) or else `<private>/clients/<name>.token`, and calls the package's `start(host)` with `host.dataDir`
// set to `<data>/plugins/<name>`. `host.env` holds the keys `plugin.json` lists from the process environment. The
// settings are the core's (config/config.json, then the private settings file when this user can read it), read
// again whenever one changes. `host.serve(handle)` connects to the core's socket, says hello under `plugin`, registers
// the manifest's tools and answers each call through `handle`; a link that drops is opened again with the interface
// runner's backoff and the tools register again. SIGTERM and SIGINT stop the plugin and exit 0 (src/protocol/plugin.ts).

import { randomUUID } from 'node:crypto';
import { execFile, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { tokenVariableOf } from '../src/interface/commands/interface-token.ts';
import { interfaceCredential } from '../src/config/files.ts';
import { interfacePackageDir } from '../src/config/files.ts';
import { createRunnerServer } from '../src/agent-runner/server.ts';
import { DEFAULT_OPENCODE_PATH } from '../src/agent-runner/opencode.ts';
import { createAgentEngine, createInstalledBackend } from '../src/agent-runner/backend.ts';
import { BACKEND_NAMES, agentSettings, profileOf, listAgents, promptFilesOf } from '../src/agent-runner/profiles.ts';
import type { RunnerTask } from '../src/agent-runner/protocol.ts';
import { startSweeper } from '../src/agent-runner/sweep.ts';
import { spawnGh } from '../src/selfimprovement/repository.ts';
import { spawnRun } from '../src/setup/install.ts';
import { REPLY_CHECK_MS } from '../src/subharness/control.ts';
import type { EnableDeps } from '../src/subharness/control.ts';
import { installSubharness } from '../src/subharness/install.ts';
import type { InstallRun } from '../src/subharness/install.ts';
import { loginCommand } from '../src/subharness/place.ts';
import { SetupUsageError, nodeOf, parseSetupArgs, runSetup } from '../src/setup/run.ts';
import type { SetupReport } from '../src/setup/run.ts';
import { featureRows } from '../src/subharness/summary.ts';
import { defaultDenyDir, runAgent } from '../src/subharness/run.ts';
import { ROOT_DIR, deepMerge, parseEnv, readConfig, resolveEnvRefs } from '../src/config.ts';
import { moveConfigKeys } from '../src/config-moves.ts';
import { checkConfig as checkSettings } from '../src/config/check.ts';
import {
  MOVE_TOOL,
  localConfigPath,
  localFiles,
  localInterfacePath,
  readInterfaceConfig,
  trackedConfigPath,
} from '../src/config/files.ts';
import { cutConfigKeys } from '../src/config/cut.ts';
import type { LocalFiles } from '../src/config/files.ts';
import { CONFIG_SCHEMA } from '../src/config/schema.ts';
import { parseCommandLine } from '../src/interface/commands/table.ts';
import { CLIENTS_FILE, loadPrincipals } from '../src/interface/principals.ts';
import { coreSocketPath } from '../src/interface/socket.ts';
import { BASE_ROLES, MEMORY_ROLE } from '../src/llm/roles.ts';
import { createKeyStore, keysFileExists } from '../src/keys/store.ts';
import { ROLE_KEY_NAME, STRICT_KEY_ROLES } from '../src/llm/openrouter.ts';
import { log, logToStderr } from '../src/log.ts';
import { resolvePaths } from '../src/paths.ts';
import type {
  Adapter,
  Capabilities,
  ConversationInfo,
  Delivery,
  HistoryQuery,
  MessageEvent,
} from '../src/protocol/adapter.ts';
import type { InterfaceHost, RunningInterface } from '../src/protocol/host.ts';
import { servePlugin } from '../src/protocol/plugin.ts';
import type {
  PluginHost,
  PluginManifest,
  RegisterOutcome,
  RunningPlugin,
  ServedPlugin,
} from '../src/protocol/plugin.ts';
import { serveAdapter } from '../src/protocol/serve.ts';
import { parseManifest } from '../src/plugins/manifest.ts';
import { runSelfimprovement } from './selfimprovement.ts';
import { runTask, openBoardCaller } from './neptunia-task.ts';
import { reportAnswer } from './report.ts';
import { createAnswers, mutableOutput } from './secret-prompt.ts';
import type { Answers } from './secret-prompt.ts';
import { reportsDirOf, watcherDir } from '../src/watcher/read.ts';
import { runWatcher } from '../src/watcher/run.ts';
import type { RunAgent } from '../src/watcher/run.ts';
import type { CommandResult, Logger } from '../src/protocol/serve.ts';
import { MAX_FRAME_BYTES, connectSocket } from '../src/protocol/wire.ts';
import type { Transport } from '../src/protocol/wire.ts';

const USAGE = [
  'usage: neptunia                      the chat',
  '       neptunia -p "<command>"       one command, its answer on stdout',
  '       neptunia doctor [--live] [--json]',
  '       neptunia errand-runner --profile <name>',
  '       neptunia interface run <name> [--interfaces-dir <dir>]',
  '       neptunia plugin run <name>',
  '       neptunia service start|stop|restart|status [<unit> ...]',
  '       neptunia setup [--system] [--node <path>] [folders|keys-file|subharness|selfimprovement|mechanics|watcher|units|linger|core]',
  '       neptunia setup subharness codex|claude|opencode [--from <path>]',
  '       neptunia task <command> [options]   (neptunia task help)',
  '       neptunia selfimprovement run',
  '       neptunia watcher run',
].join('\n');

/** The first wait before a new connection, and the longest. */
const BACKOFF_FIRST_MS = 250;
const BACKOFF_MAX_MS = 30_000;
/** A link that stayed up this long was healthy: the backoff starts over after it. */
const STABLE_MS = 30_000;

/** An interface name as scripts/client-token.ts accepts a client name. */
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
      `cannot read the token ${file} (${(err as NodeJS.ErrnoException).code ?? 'error'}); run scripts/client-token.ts add`
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

/** One command as the `command.requested` event of the owner, answered by the `command.result` naming `replyRef`. */
function commandEvent(
  command: { name: string; args: Record<string, unknown> },
  replyRef: string,
  dialog: { dialogId: string; answer: string } | null = null
): Record<string, unknown> {
  return {
    // The answer to a question the command asked is a field of its own, never an argument.
    ...(dialog === null ? {} : dialog),
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
  /** Sends a command; a question it asks goes to `answers`, and without them the command is refused. */
  ask(command: Command, answers?: Answers): Promise<Answer>;
  closed: Promise<void>;
  close(): void;
};

/** Connects as the `cli` client; rejects when no core listens. `print` takes her replies, null for none. */
async function openCliLink(print: ((text: string) => void) | null): Promise<CliLink> {
  const where = paths();
  const transcript: Array<MessageEvent> = [];
  const token = readToken(where.privateDir, CLI_CLIENT);
  const transport = await connectSocket({ path: coreSocketPath(where.dataDir), maxFrameBytes: MAX_FRAME_BYTES });
  const waiting = new Map<string, (result: Reply) => void>();
  const closed = new Promise<void>((resolve) =>
    transport.onClose(() => {
      for (const resolveAnswer of waiting.values())
        resolveAnswer({ text: 'The link to the core closed.', status: 'failed' });
      waiting.clear();
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
      const resolveAnswer = waiting.get(result.replyRef);
      waiting.delete(result.replyRef);
      resolveAnswer?.({ text: result.text, status: result.status ?? 'ok', ask: result.ask ?? null });
    },
  });
  return {
    say(text) {
      const event = lineEvent(text, Date.now());
      keep(transcript, event);
      return served.emit(event);
    },
    async ask(command, answers) {
      /** One request and the reply to it: a result, or a question. */
      async function send(dialog: { dialogId: string; answer: string } | null): Promise<Reply> {
        const replyRef = randomUUID();
        const reply = new Promise<Reply>((resolve) => waiting.set(replyRef, resolve));
        const acked = await served.emit(commandEvent(command, replyRef, dialog));
        if (acked === 'ok') return reply;
        waiting.delete(replyRef);
        return { text: `The core did not take the command (${acked}).`, status: acked, ask: null };
      }
      let reply = await send(null);
      while (reply.ask != null) {
        if (answers === undefined)
          return { text: 'This command asks a question: run it in the chat.', status: 'invalid' };
        const { dialogId, prompt, secret } = reply.ask;
        reply = await send({ dialogId, answer: await answers.ask(prompt, secret) });
      }
      return { text: reply.text, status: reply.status };
    },
    closed,
    close: () => served.close(),
  };
}

/** A parsed command. */
type Command = { name: string; args: Record<string, unknown> };

/** One answer of a command, from the core or from the command line itself. */
type Answer = { text: string; status: string };

/** What the core sent for one request: an answer, or a question to put to the owner (`ask`). */
type Reply = Answer & { ask?: CommandResult['ask'] };

/** The commands the command line runs itself, with no core: the doctor, the journal, the screen and the report. */
const LOCAL_COMMANDS = new Set(['doctor', 'doctor.live', 'logs', 'clear', 'report']);

/** The core's unit, whose journal `/logs` reads (deploy/neptunia-core.service). */
const CORE_UNIT = 'neptunia-core.service';

/** The arguments of `journalctl` for `/logs` with its words (`errors`, `since <value>`, `follow`). */
function journalArgs(options: string): { args: Array<string>; follow: boolean } {
  const words = options.split(' ').filter((word) => word !== '');
  const args = ['-u', CORE_UNIT, '--no-pager'];
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
  if (follow) args.push('-f');
  return { args, follow };
}

/** `/logs` once: journalctl's output, or why it did not run. A follow is the chat's (`followJournal`). */
function readJournal(options: string): Answer {
  const { args, follow } = journalArgs(options);
  if (follow) return { text: '/logs follow: only the chat follows the journal', status: 'invalid' };
  const run = spawnSync('journalctl', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (run.error !== undefined) {
    const code = (run.error as NodeJS.ErrnoException).code ?? 'error';
    return { text: `/logs: journalctl does not run here (${code}); it is not on PATH`, status: 'failed' };
  }
  const text = run.stdout === '' ? run.stderr : run.stdout;
  return { text: text === '' ? '(no lines)' : text, status: run.status === 0 ? 'ok' : 'failed' };
}

/** `/logs ... follow` in the chat: journalctl's lines printed as they come, until the chat ends. */
function followJournal(options: string, print: (text: string) => void): Promise<unknown> {
  const child = spawn('journalctl', journalArgs(options).args, { stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (chunk: Buffer) => print(chunk.toString()));
  process.once('exit', () => child.kill());
  return new Promise<void>((resolve) => {
    child.once('error', (err: NodeJS.ErrnoException) => {
      print(`/logs: journalctl does not run here (${err.code ?? 'error'}); it is not on PATH`);
      resolve();
    });
    child.once('exit', () => resolve());
  });
}

/** The doctor's checks as lines of the chat: each check's status and name, then its detail. */
const checkLines = (checks: ReadonlyArray<Check>): string =>
  checks
    .map((check) => `${check.status.padEnd(7)}  ${check.name.padEnd(11)}  ${check.detail.replaceAll('\n', '; ')}`)
    .join('\n');

/** The watcher's reports folder: `watcher.dir` of the settings as this user can read them, else the default. */
function reportsDirIn(where: { rootDir: string; privateDir: string }): string {
  let config: unknown = {};
  try {
    config = readConfig(where.rootDir, { privateDir: where.privateDir });
  } catch {
    // Settings this user cannot read: the default folder under the checkout.
  }
  return reportsDirOf(where.privateDir, watcherDir(config));
}

/** A command the command line runs itself; `ask` reaches the core for the probes of `doctor.live`, null when down. */
async function runLocal(command: Command, ask: ((command: Command) => Promise<Answer>) | null): Promise<Answer> {
  if (command.name === 'clear') return { text: '', status: 'ok' };
  if (command.name === 'logs') return readJournal(typeof command.args.options === 'string' ? command.args.options : '');
  if (command.name === 'report') {
    return reportAnswer({
      reportsDir: reportsDirIn(paths()),
      day: typeof command.args.day === 'string' ? command.args.day : undefined,
      color: process.stdout.isTTY && !process.env.NO_COLOR,
    });
  }
  const checks = await doctorChecks(paths(), command.name === 'doctor.live' ? { ask } : null);
  return { text: checkLines(checks), status: checks.some((check) => check.status === 'fail') ? 'failed' : 'ok' };
}

async function runOne(argv: ReadonlyArray<string>): Promise<void> {
  const [line, ...rest] = argv;
  if (line === undefined || rest.length > 0) usage();
  const parsed = parseCommandLine(line);
  if (!parsed.ok) {
    console.error(`neptunia: ${parsed.reason}`);
    process.exit(1);
  }
  const command = { name: parsed.name, args: parsed.args };
  const print = (answer: Answer): never => {
    if (answer.text !== '') process.stdout.write(answer.text.endsWith('\n') ? answer.text : `${answer.text}\n`);
    process.exit(answer.status === 'ok' ? 0 : 1);
  };
  if (LOCAL_COMMANDS.has(command.name)) {
    const link = command.name === 'doctor.live' ? await tryCliLink() : null;
    const answer = await runLocal(command, link === null ? null : (asked) => link.ask(asked));
    link?.close();
    print(answer);
  }
  let link: CliLink;
  try {
    link = await openCliLink(null);
  } catch (err) {
    die(`no core listens (${(err as NodeJS.ErrnoException).code ?? 'error'}); start it with neptunia service start`);
  }
  // A command that asks a question (a key value) reads the answer from the terminal when there is one.
  const questions = process.stdin.isTTY === true ? openQuestions() : null;
  const answer = await link.ask(command, questions?.answers);
  questions?.close();
  link.close();
  print(answer);
}

/** The terminal's questions for one command: its readline interface (muted while a secret is typed) and the answers over it. */
function openQuestions(): { answers: Answers; close(): void } {
  const output = mutableOutput(process.stdout);
  const input = readline.createInterface({ input: process.stdin, output, terminal: true });
  const answers = createAnswers({ rl: input, input: process.stdin, output, target: process.stdout });
  input.on('line', (line: string) => answers.take(line));
  return { answers, close: () => input.close() };
}

/** The `cli` client's link when its token is there and a core listens, else null. */
async function tryCliLink(): Promise<CliLink | null> {
  if (!fs.existsSync(path.join(paths().privateDir, 'clients', `${CLI_CLIENT}.token`))) return null;
  try {
    return await openCliLink(null);
  } catch {
    return null;
  }
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

/**
 * The chat. With `firstLine` (`neptunia setup` hands it `/keys core add`) that line is typed first, and the chat
 * returns to its caller when the input ends instead of ending the process.
 */
async function runChat(firstLine?: string): Promise<void> {
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
  // In a terminal the interface draws into a writable that a secret answer mutes (bin/secret-prompt.ts).
  const output = terminal ? mutableOutput(process.stdout) : null;
  const input = readline.createInterface({
    input: process.stdin,
    output: output ?? undefined,
    terminal,
    history: terminal ? readHistory(historyFile) : [],
    historySize: 1000,
  });
  const answers = createAnswers({ rl: input, input: process.stdin, output, target: process.stdout });
  if (terminal) {
    input.on('history', (lines: Array<string>) => {
      // A secret answer is neither kept in the file nor in the list: it is taken out of both.
      if (answers.secretWaiting()) return;
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
    // The line a question waits for is its answer, never a command.
    if (answers.take(line)) return;
    const text = line.trim();
    if (text === '') return;
    if (text === '/clear') {
      if (terminal) console.clear();
    } else if (text.startsWith('/')) {
      const parsed = parseCommandLine(text);
      if (!parsed.ok) printBlock(parsed.reason);
      else if (
        parsed.name === 'logs' &&
        typeof parsed.args.options === 'string' &&
        journalArgs(parsed.args.options).follow
      )
        track(followJournal(parsed.args.options, printBlock));
      else if (LOCAL_COMMANDS.has(parsed.name))
        track(runLocal(parsed, (asked) => link.ask(asked)).then((answer) => printBlock(answer.text)));
      else track(link.ask(parsed, answers).then((answer) => printBlock(answer.text)));
    } else {
      track(
        link.say(line).then((status) => {
          if (status !== 'ok') console.error(`neptunia: the core did not take the line (${status})`);
        })
      );
    }
    if (terminal) input.prompt();
  });
  if (firstLine !== undefined) {
    if (terminal) process.stdout.write(`${firstLine}\n`);
    input.emit('line', firstLine);
  }
  await new Promise<void>((resolve) => input.once('close', () => resolve()));
  await Promise.race([Promise.all([...running]), link.closed]);
  link.close();
  if (firstLine === undefined) process.exit(0);
}

// ---------------------------------------------------------------------------------------------------------------
// doctor
// ---------------------------------------------------------------------------------------------------------------

/** A skipped check could not run here (the probes with the core down) and fails nothing. */
type CheckStatus = 'ok' | 'warn' | 'fail' | 'skipped';
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

/**
 * The private settings file against the schema (src/config/check.ts): `warn` naming each unknown key and each key of
 * the wrong type, or the old layout that scripts/config-files-move.ts moves; `fail` when a file is not JSON, the
 * tracked file is missing or a file sits at both its places.
 */
function checkConfig(where: { rootDir: string; privateDir: string }): Check {
  let base: Settings | null;
  let local: Settings | null;
  let found: LocalFiles;
  try {
    found = localFiles(where.privateDir);
    base = readObject(trackedConfigPath(where.rootDir));
    local = found.config === null ? null : readObject(found.config);
  } catch (err) {
    return { name: 'config', status: 'fail', detail: `a config file is not read: ${(err as Error).message}` };
  }
  if (base === null) return { name: 'config', status: 'fail', detail: 'config/config.json is missing' };
  if (local === null || found.config === null)
    return { name: 'config', status: 'warn', detail: 'no config.local/config.json: the shipped settings apply' };
  const file = path.relative(where.privateDir, found.config);
  const problems = checkSettings(settledLayer(local), CONFIG_SCHEMA).map(({ key, kind }) =>
    kind === 'unknown' ? `${key} (unknown)` : `${key} (wrong type)`
  );
  const moveNote = found.old ? `; the old layout, moved by node ${MOVE_TOOL}` : '';
  if (problems.length > 0)
    return { name: 'config', status: 'warn', detail: `${file}: ${problems.join(', ')}${moveNote}` };
  return found.old
    ? { name: 'config', status: 'warn', detail: `config/config.json and ${file} read${moveNote}` }
    : { name: 'config', status: 'ok', detail: `config/config.json and ${file} read` };
}

function checkLocalLayer(where: { privateDir: string }): Check {
  if (!fs.existsSync(where.privateDir))
    return { name: 'local-layer', status: 'fail', detail: `${where.privateDir} does not exist` };
  const prompts = fs.existsSync(path.join(where.privateDir, 'prompts'));
  return {
    name: 'local-layer',
    status: 'ok',
    detail: prompts ? 'the local layer and prompts.local/ are there' : 'the local layer is there, no prompts.local/',
  };
}

/** The model keys of a deployment with a `keys.json`: how many core keys it holds. Names and counts only. */
function checkKeyStore(privateDir: string): Check {
  try {
    const core = createKeyStore({ privateDir }).list().core.length;
    return core > 0
      ? { name: 'env-keys', status: 'ok', detail: `keys.json holds ${core} core keys` }
      : { name: 'env-keys', status: 'warn', detail: 'keys.json holds no core key: add one with /keys core add' };
  } catch {
    return { name: 'env-keys', status: 'fail', detail: 'keys.json does not read' };
  }
}

/** The `.env` keys the enabled roles name (`llm.keyByRole`), beside the core's own: names only, never a value. */
function checkEnvKeys(where: { rootDir: string; privateDir: string }): Check {
  if (keysFileExists(where.privateDir)) return checkKeyStore(where.privateDir);
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
    wanted = Object.values(byRole)
      .flat()
      .filter((name): name is string => typeof name === 'string' && name !== '');
  } catch {
    // A config that does not read is the config check's to report.
  }
  const missing = [...new Set(wanted)].filter((name) => !names.has(name));
  return missing.length === 0
    ? { name: 'env-keys', status: 'ok', detail: 'every key a role names is set' }
    : { name: 'env-keys', status: 'warn', detail: `not set: ${missing.join(', ')}` };
}

/** The base model roles `config` switches off with `models.base.<role>: false`. */
function rolesOff(config: Settings): Array<string> {
  const models = isObject(config.models) ? config.models : {};
  const base = isObject(models.base) ? models.base : {};
  return [...BASE_ROLES, MEMORY_ROLE].filter((role) => base[role] === false);
}

/**
 * The model roles that cannot run: switched off (`models.base.<role>: false`), or one whose key never falls back to
 * the main key (`STRICT_KEY_ROLES`) without its `llm.keyByRole` variable in `.env`. Either is `warn`. Names only.
 */
function checkRoles(where: { rootDir: string; privateDir: string }): Check {
  let config: Settings;
  let names: Set<string>;
  try {
    config = readConfig(where.rootDir, { privateDir: where.privateDir });
    names = keysFileExists(where.privateDir)
      ? new Set()
      : new Set(Object.keys(parseEnv(fs.readFileSync(path.join(where.privateDir, '.env'), 'utf8'))));
  } catch {
    return { name: 'roles', status: 'warn', detail: 'not checked: the config or .env does not read' };
  }
  const byRole = isObject(config.llm) && isObject(config.llm.keyByRole) ? config.llm.keyByRole : {};
  // With a key store a role goes out on a core key or its bound key; the store's own check says whether there is one.
  const noKey = keysFileExists(where.privateDir)
    ? []
    : STRICT_KEY_ROLES.filter((role) => {
        const entry = byRole[role];
        const listed = Array.isArray(entry) ? entry : [entry];
        return !listed.some((name) => typeof name === 'string' && ROLE_KEY_NAME.test(name) && names.has(name));
      });
  const problems = [
    ...rolesOff(config).map((role) => `${role} has no model`),
    ...noKey.map((role) => `${role} has no key`),
  ];
  return problems.length === 0
    ? { name: 'roles', status: 'ok', detail: 'every model role has a model and a key' }
    : { name: 'roles', status: 'warn', detail: problems.join(', ') };
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

/**
 * The probe of every model role, run by the core (`doctor.live`, the status card's probes): `ok`, `warn` when a probe
 * failed, and `skipped` without a core, since the command line holds no key.
 */
async function checkProviders(ask: ((command: Command) => Promise<Answer>) | null): Promise<Check> {
  if (ask === null) return { name: 'providers', status: 'skipped', detail: 'the core is down: only it holds the keys' };
  const answer = await ask({ name: 'doctor.live', args: {} });
  if (answer.status === 'ok') return { name: 'providers', status: 'ok', detail: answer.text };
  return { name: 'providers', status: answer.status === 'failed' ? 'warn' : 'fail', detail: answer.text };
}

/**
 * The two features the owner switches on from the chat, the subharness and the simulation (src/subharness/summary.ts):
 * `warn` naming each one that is off with the command that turns it on, never `fail`.
 */
async function checkFeatures(where: { privateDir: string }): Promise<Check> {
  let rows: Awaited<ReturnType<typeof featureRows>>;
  try {
    rows = await featureRows(where.privateDir);
  } catch (err) {
    return { name: 'features', status: 'warn', detail: `keys.json cannot be read: ${(err as Error).message}` };
  }
  const off = rows.filter((row) => !row.available);
  if (off.length === 0) return { name: 'features', status: 'ok', detail: 'the subharness and the simulation are on' };
  return {
    name: 'features',
    status: 'warn',
    detail: off.map((row) => `${row.name} is off${row.hint === null ? '' : `: ${row.hint}`}`).join('\n'),
  };
}

/** Every check of the installation; with `live`, the providers probed through the core too. */
async function doctorChecks(
  where: { rootDir: string; privateDir: string; dataDir: string },
  live: { ask: ((command: Command) => Promise<Answer>) | null } | null
): Promise<Array<Check>> {
  const checks: Array<Check> = [
    checkNode(),
    checkBinaries(),
    checkConfig(where),
    checkLocalLayer(where),
    checkEnvKeys(where),
    checkRoles(where),
    checkTokens(where),
    await checkFeatures(where),
    checkDatabase(where),
    await checkSocket(where),
  ];
  if (live !== null) checks.push(await checkProviders(live.ask));
  return checks;
}

async function runDoctor(argv: ReadonlyArray<string>): Promise<void> {
  const json = argv.includes('--json');
  const live = argv.includes('--live');
  if (argv.some((arg) => arg !== '--json' && arg !== '--live')) usage();
  const where = paths();
  const link = live ? await tryCliLink() : null;
  const checks = await doctorChecks(
    where,
    live ? { ask: link === null ? null : (command) => link.ask(command) } : null
  );
  link?.close();
  if (json) process.stdout.write(`${JSON.stringify({ checks })}\n`);
  else
    for (const check of checks)
      process.stdout.write(
        `${check.status.padEnd(7)}  ${check.name.padEnd(11)}  ${check.detail.replaceAll('\n', '; ')}\n`
      );
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

async function runErrandRunner(argv: ReadonlyArray<string>): Promise<void> {
  const name = profileFlag(argv);
  const where = paths();
  const agentPaths = { rootDir: where.rootDir, dataDir: where.dataDir, env: process.env };
  const profile = profileOf(name, agentPaths);
  if (profile === null) die(`unknown profile: ${name} (expected scout or server)`);
  // config/config.json, then the private settings file when this user can read it: the runner's user may not read the
  // local layer.
  const localFile = localConfigPath(where.privateDir);
  const files = createSettings([trackedConfigPath(where.rootDir), localFile], localFile);
  const read = (): Settings => files.read();
  let config = read();
  const errands = isObject(config.errands) ? config.errands : {};
  const settings = agentSettings(name, config, agentPaths);
  const socketPath = typeof settings?.socket === 'string' ? settings.socket : '';
  const outDir = typeof settings?.out === 'string' ? settings.out : '';
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
  const engine = createAgentEngine({
    agentPaths,
    profile,
    outDir,
    env: process.env,
    opencodePath,
    getConfig: currentConfig,
    // Every task runs through the subharness: the owner's backend and the mode of this agent, read at each task.
    subharness: { privateDir: where.privateDir, denyDir: defaultDenyDir() },
  });
  try {
    engine.checkPrompt();
  } catch (err) {
    die((err as Error).message);
  }
  const runner = {
    run(task: RunnerTask) {
      const config = currentConfig();
      const profile = profileOf(name, agentPaths);
      if (!profile) throw new Error('the worker profile is unavailable');
      const settings = agentSettings(name, config, agentPaths);
      const errands = isObject(config.errands) ? config.errands : {};
      return engine.run({
        ...task,
        limits: {
          ...profile.defaultLimits,
          ...settings?.limits,
          toolResultChars: errands.toolResultChars,
          ...task.limits,
        },
        cost: task.cost ?? settings?.cost,
        searchProvider: task.searchProvider ?? settings?.searchProvider,
      });
    },
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
// setup
// ---------------------------------------------------------------------------------------------------------------

/** The report of `setup`: each step with its state, then the commands that come next. */
function printSetup(report: SetupReport): void {
  for (const one of report.steps) console.log(`${one.state.padEnd(8)}  ${one.step.padEnd(10)}  ${one.detail}`);
  if (report.ok) console.log(`next, in the chat: ${report.next.join(', ')}`);
  else console.error('neptunia: setup stopped at the step that failed; run it again to resume');
}

/** One question at the terminal, `offered` shown in brackets; the owner's line as typed. */
async function askAtTerminal(
  question: string,
  offered: string | null,
  options: { secret: boolean } = { secret: false }
): Promise<string> {
  const output = mutableOutput(process.stdout);
  const rl = readline.createInterface({ input: process.stdin, output, terminal: process.stdin.isTTY === true });
  try {
    return await new Promise<string>((resolve) => {
      rl.question(offered === null ? `${question} ` : `${question} [${offered}] `, (answer) => {
        output.muted = false;
        if (options.secret) process.stdout.write('\n');
        resolve(answer);
      });
      // readline has drawn the question; what the owner types next is not echoed.
      output.muted = options.secret;
    });
  } finally {
    rl.close();
  }
}

/** The group of this process's user by name (`Group=` also takes the number). */
function groupName(): string {
  const named = spawnSync('id', ['-gn'], { encoding: 'utf8' });
  const name = named.status === 0 ? named.stdout.trim() : '';
  return name === '' ? String(process.getgid?.() ?? '') : name;
}

// npm fetches and unpacks a whole CLI; ten minutes covers a slow registry.
const NPM_INSTALL_MS = 10 * 60 * 1000;

/** The runner of `installSubharness`: one command with exactly the given environment. */
const installRun: InstallRun = (command, args, options) =>
  new Promise((resolve, reject) => {
    execFile(
      command,
      [...args],
      { env: options.env, timeout: NPM_INSTALL_MS, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error === null) resolve({ code: 0, stdout, stderr });
        else if (typeof error.code === 'number') resolve({ code: error.code, stdout, stderr });
        else reject(Object.assign(new Error(error.message), { code: error.code ?? 'killed' }));
      }
    );
  });

/**
 * `setup subharness <backend> [--from <path>]`: the backend installed into the private layer, then the login line the
 * owner types at this terminal. opencode is copied from `--from`, else from `errands.opencodePath`.
 */
async function runSubharnessSetup(argv: ReadonlyArray<string>): Promise<void> {
  const [name, flag, value, ...extra] = argv;
  const backend = BACKEND_NAMES.find((known) => known === name);
  if (backend === undefined || extra.length > 0) usage();
  if (flag !== undefined && (flag !== '--from' || value === undefined || backend !== 'opencode')) usage();
  const where = paths();
  let source = value === undefined ? undefined : path.resolve(value);
  if (backend === 'opencode' && source === undefined) {
    const config = readConfig(where.rootDir, { privateDir: where.privateDir });
    const errands = isObject(config.errands) ? config.errands : {};
    source = typeof errands.opencodePath === 'string' ? errands.opencodePath : DEFAULT_OPENCODE_PATH;
  }
  const outcome = await installSubharness(
    {
      privateDir: where.privateDir,
      backend,
      hostEnv: process.env,
      ...(source === undefined ? {} : { opencodeSource: source }),
    },
    installRun
  );
  console.log(`${outcome.state.padEnd(8)}  subharness ${backend}  ${outcome.detail}`);
  if (outcome.state === 'failed') process.exit(1);
  const plain = loginCommand(where.privateDir, backend);
  if (plain === null) {
    console.log(`next, in the chat: subharness enable ${backend} --key <name>`);
    process.exit(0);
  }
  // The login subcommand of claude differs between releases: the installed binary's help names the one it has.
  const help =
    backend === 'claude'
      ? spawnSync(plain.command, ['--help'], {
          env: { PATH: process.env.PATH ?? '', HOME: os.homedir(), ...plain.env },
          encoding: 'utf8',
          timeout: 30_000,
        }).stdout
      : undefined;
  const login = loginCommand(where.privateDir, backend, help) ?? plain;
  console.log(`log in at this terminal: ${login.text}`);
  console.log(`then, in the chat: subharness enable ${backend}`);
  process.exit(0);
}

/** The reply check of the subharness step: one run of her installed codex or claude, read-only, in the temp folder. */
function replyCheck(privateDir: string): EnableDeps['runBackend'] {
  return (backend, brief, model) =>
    createInstalledBackend(backend, privateDir).run(brief, {
      cwd: os.tmpdir(),
      timeoutMs: REPLY_CHECK_MS,
      sandbox: 'read-only',
      ...(model === undefined ? {} : { model }),
    });
}

async function runSetupCommand(argv: ReadonlyArray<string>): Promise<void> {
  if (argv[0] === 'subharness' && argv.length > 1) return runSubharnessSetup(argv.slice(1));
  let parsed: ReturnType<typeof parseSetupArgs>;
  try {
    parsed = parseSetupArgs(argv);
  } catch (err) {
    if (err instanceof SetupUsageError) usage();
    throw err;
  }
  const where = paths();
  const { node, ...rest } = parsed;
  const report = await runSetup(
    {
      ...rest,
      user: os.userInfo().username,
      group: groupName(),
      home: os.homedir(),
      rootDir: where.rootDir,
      privateDir: where.privateDir,
      dataDir: where.dataDir,
      node: nodeOf({ given: node, argv0: process.argv0, execPath: process.execPath, pathEnv: process.env.PATH }),
      ...(process.env.XDG_CONFIG_HOME ? { xdgConfigHome: process.env.XDG_CONFIG_HOME } : {}),
    },
    {
      run: spawnRun,
      openChat: (firstLine) => runChat(firstLine),
      report: printSetup,
      ...(process.stdin.isTTY === true
        ? {
            ask: askAtTerminal,
            gh: spawnGh(where.privateDir, process.env),
            install: installRun,
            runBackend: replyCheck(where.privateDir),
            fetch,
            hostEnv: process.env,
          }
        : {}),
    }
  );
  process.exit(report.ok ? 0 : 1);
}

// ---------------------------------------------------------------------------------------------------------------
// service
// ---------------------------------------------------------------------------------------------------------------

function runService(argv: ReadonlyArray<string>): void {
  const [verb, ...units] = argv;
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
  let interfacesDir = path.dirname(interfacePackageDir(ROOT_DIR, paths().dataDir, name));
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

type SettingsLayers = { compose?: (core: Settings) => Settings; watched?: ReadonlyArray<string> };

/** A private settings file as the core reads it: its keys of an old name under the new one, the cut keys out. */
const settledLayer = (layer: Settings): Settings => cutConfigKeys(moveConfigKeys(layer).config).config;

/**
 * The process's settings, read again when a file changed. Each change that read well is told to the listeners.
 * `local` is the private settings file among `files`, read the way the core reads it (`settledLayer`). `compose`
 * lays the files an interface adds over the merged settings (src/config/files.ts#readInterfaceConfig); a file it
 * reads itself is in `watched`, so a change to it reads the settings again.
 */
function createSettings(
  files: ReadonlyArray<string>,
  local: string,
  { compose = (core: Settings): Settings => core, watched = [] }: SettingsLayers = {}
) {
  const listeners = new Set<(what: string) => void>();
  let stamp = '';
  let current: Settings = {};
  function read(): Settings {
    const now = [...files, ...watched].map(changedAt).join(':');
    if (now === stamp) return current;
    const [base = '', ...layers] = files;
    try {
      let merged = readObject(base) ?? {};
      for (const file of layers) {
        const layer = readObject(file);
        if (layer === null) continue;
        merged = deepMerge(merged, file === local ? settledLayer(layer) : layer) as Settings;
      }
      current = resolveEnvRefs(compose(merged)) as Settings;
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
  // The core's settings (the tracked file and the private settings file), then the package's own, the package's keys a
  // private file not yet cut holds, and the private file of this interface (src/config/files.ts#readInterfaceConfig).
  const localFile = localConfigPath(where.privateDir);
  const settings = createSettings([trackedConfigPath(where.rootDir), localFile], localFile, {
    compose: (core) =>
      readInterfaceConfig({ rootDir: where.rootDir, privateDir: where.privateDir, name, base: core, packageDir }),
    watched: [path.join(packageDir, 'config.json'), localInterfacePath(where.privateDir, name)],
  });
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
    env: { [tokenVariableOf(name)]: interfaceCredential(where.dataDir, name) ?? '' },
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
// plugin run
// ---------------------------------------------------------------------------------------------------------------

type PluginPackage = { start(host: PluginHost): Promise<RunningPlugin> };

/** The plugin's folder: the private layer's `plugins.local/<name>` before the checkout's `plugins/<name>`. */
function pluginDir(where: { rootDir: string; privateDir: string }, name: string): string {
  const found = [path.join(where.privateDir, 'plugins.local', name), path.join(where.rootDir, 'plugins', name)].find(
    (dir) => fs.existsSync(path.join(dir, 'plugin.json'))
  );
  return found ?? die(`no plugin ${name}: neither plugins.local/${name} nor plugins/${name} has a plugin.json`);
}

/** The token of plugin `name`: the unit's credential when systemd gave one, else the client's token file. */
function pluginToken(privateDir: string, name: string): string {
  const credentials = process.env.CREDENTIALS_DIRECTORY;
  if (credentials !== undefined && credentials !== '') {
    try {
      const token = fs.readFileSync(path.join(credentials, 'token'), 'utf8').replace(/\r?\n$/, '');
      if (token !== '') return token;
    } catch {
      // No credential of that name: the token file is read below.
    }
  }
  return readToken(privateDir, name);
}

async function loadPlugin(dir: string): Promise<PluginPackage> {
  const entry = ['index.ts', 'index.js'].map((file) => path.join(dir, file)).find((file) => fs.existsSync(file));
  if (entry === undefined) die(`no index.ts or index.js in ${dir}`);
  const loaded: unknown = await import(pathToFileURL(entry).href);
  const start: unknown = loaded !== null && typeof loaded === 'object' ? Reflect.get(loaded, 'start') : undefined;
  if (typeof start !== 'function') die(`${entry} exports no start(host)`);
  // The package's start is the function the plugin contract names (src/protocol/plugin.ts).
  return { start: start as PluginPackage['start'] };
}

async function runPlugin(argv: ReadonlyArray<string>): Promise<void> {
  const [command, name, ...extra] = argv;
  if (command !== 'run' || name === undefined || extra.length > 0) usage();
  if (!NAME.test(name)) die(`invalid plugin name "${name}"; use lowercase letters, digits, - and _`);
  const where = paths();
  const dir = pluginDir(where, name);
  const parsed = parseManifest(fs.readFileSync(path.join(dir, 'plugin.json'), 'utf8'), name);
  if (!parsed.ok) die(`${path.join(dir, 'plugin.json')} is refused: ${parsed.code}`);
  const manifest: PluginManifest = parsed.manifest;
  const pkg = await loadPlugin(dir);
  const token = pluginToken(where.privateDir, name);
  const socketPath = coreSocketPath(where.dataDir);
  const localFile = localConfigPath(where.privateDir);
  const settings = createSettings([trackedConfigPath(where.rootDir), localFile], localFile);
  settings.read();
  const dataDir = path.join(where.dataDir, 'plugins', name);
  fs.mkdirSync(dataDir, { recursive: true });

  let delays = 0;
  let stopping = false;
  const nextDelay = (): number => {
    const ms = Math.min(BACKOFF_MAX_MS, BACKOFF_FIRST_MS * 2 ** delays);
    delays = Math.min(delays + 1, 16);
    return ms;
  };

  async function connect(): Promise<Transport> {
    for (;;) {
      if (stopping) throw new Error('the plugin is stopping');
      try {
        return await connectSocket({ path: socketPath, maxFrameBytes: MAX_FRAME_BYTES });
      } catch (err) {
        const ms = nextDelay();
        log.info('plugin: core not reachable, trying again', {
          name,
          code: (err as NodeJS.ErrnoException).code ?? null,
          inMs: ms,
        });
        await sleep(ms);
      }
    }
  }

  let current: { close(): void } | null = null;

  /** One connection: hello, the registration, and a new connection after it drops. Resolves once connected, with the registration still to come. */
  async function open(handle: Parameters<PluginHost['serve']>[0]): Promise<{ registered: Promise<RegisterOutcome> }> {
    const transport = await connect();
    const openedAt = Date.now();
    const served = servePlugin({ transport, name, token, tools: manifest.tools, handle, log });
    current = served;
    served.registered.then(
      (outcome) =>
        log.info('plugin: registered', { name, accepted: outcome.accepted.length, refused: outcome.refused.length }),
      (err: unknown) => log.warn('plugin: registration failed', { name, error: err })
    );
    transport.onClose((reason) => {
      if (reason === 'closed' || stopping) return;
      if (Date.now() - openedAt >= STABLE_MS) delays = 0;
      const ms = nextDelay();
      log.info('plugin: link lost, connecting again', { name, inMs: ms });
      setTimeout(() => {
        open(handle).catch((err: unknown) => log.warn('plugin: reconnect failed', { name, error: err }));
      }, ms);
    });
    return { registered: served.registered };
  }

  const host: PluginHost = {
    name,
    manifest,
    dataDir,
    env: Object.fromEntries(manifest.env.map((key) => [key, process.env[key]])),
    config: () => settings.read(),
    log,
    async serve(handle): Promise<ServedPlugin> {
      const { registered } = await open(handle);
      return {
        registered,
        stop(): Promise<void> {
          stopping = true;
          current?.close();
          return Promise.resolve();
        },
      };
    },
  };

  let running: RunningPlugin | null = null;
  async function stop(signal: string): Promise<void> {
    if (stopping && running === null) return;
    stopping = true;
    log.info('plugin: stopping', { name, signal });
    await running?.stop().catch((err: unknown) => log.warn('plugin: stop failed', { name, error: err }));
    current?.close();
    process.exit(0);
  }
  process.on('SIGTERM', () => void stop('SIGTERM'));
  process.on('SIGINT', () => void stop('SIGINT'));

  running = await pkg.start(host);
  log.info('plugin: running', { name, tools: manifest.tools.length });
}

// ---------------------------------------------------------------------------------------------------------------
// watcher

/** How long one watcher run may take before its process group is killed (ms). */
const WATCHER_TIMEOUT_MS = 60 * 60 * 1000;

/** The watcher's agent: the subharness's backend, in the mode of `watcher`, working in the checkout. */
function watcherAgent(where: { rootDir: string; privateDir: string }): RunAgent {
  return async (_profile, brief) => {
    const done = await runAgent(
      { agent: 'watcher', brief, cwd: where.rootDir, timeoutMs: WATCHER_TIMEOUT_MS },
      { privateDir: where.privateDir, denyDir: defaultDenyDir() }
    );
    return { ok: done.ok, text: done.text, exitCode: done.exitCode ?? -1 };
  };
}

async function runWatcherCommand(argv: ReadonlyArray<string>): Promise<void> {
  const [command, ...extra] = argv;
  if (command !== 'run' || extra.length > 0) usage();
  const where = paths();
  const reportsDir = reportsDirIn(where);
  const agentPaths = { rootDir: where.rootDir, dataDir: where.dataDir, env: process.env };
  const definition = listAgents(agentPaths).find((agent) => agent.kind === 'watcher');
  if (!definition) die('the watcher definition is unavailable');
  const promptFiles = promptFilesOf(definition.id, { ...agentPaths, prompt: definition.prompt });
  const opened = await openBoardCaller({
    ...process.env,
    NEPTUNIA_TASK_CLIENT: process.env.NEPTUNIA_TASK_CLIENT || 'watcher',
  });
  if (typeof opened === 'string') die(`the board is not reachable: ${opened}`);
  try {
    const result = await runWatcher({
      now: Date.now,
      runAgent: watcherAgent(where),
      promptFiles,
      board: opened.board,
      reportsDir,
    });
    if (!result.ok) die(`the watcher run of ${result.day} failed: ${result.code}, ${result.detail}`);
    console.log(
      result.ran
        ? `watcher: report of ${result.day} written, ${result.filed.length} tasks filed`
        : `watcher: report of ${result.day} already there`
    );
  } finally {
    opened.close();
  }
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
  case 'setup':
    await runSetupCommand(rest).catch(fault);
    break;
  case 'interface':
    await runInterface(rest).catch(fault);
    break;
  case 'plugin':
    await runPlugin(rest).catch(fault);
    break;
  case 'task':
    process.exit(await runTask(rest).catch(fault));
    break;
  case 'selfimprovement':
    process.exit(await runSelfimprovement(rest).catch(fault));
    break;
  case 'watcher':
    await runWatcherCommand(rest).catch(fault);
    process.exit(0);
    break;
  default:
    usage();
}
