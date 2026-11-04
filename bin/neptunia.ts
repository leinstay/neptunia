#!/usr/bin/env node
// The `neptunia` command (package.json `bin`): the owner's chat with the persona, one command for a script, the checks
// of an installation, the errand runner and the interface runner that the systemd units start, and the units
// themselves.
//
//   neptunia                                     the chat, at a terminal
//   neptunia <command> [args]                    one command of the chat's table, its words kept as argv gives them
//   neptunia -p "/<command> [args]"              one command as a typed line
//   neptunia -p "<text>"                         one turn with the persona; her reply on stdout
//   neptunia doctor [live] [--live] [--json]     the checks of the installation, with the core up or down
//   neptunia errand-runner --profile <name>      the errand runner of one agent (deploy/neptunia-agent-<name>.service)
//   neptunia interface run <name> [--interfaces-dir <dir>]   one interface (deploy/neptunia-interface@.service)
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
// The direct form and `-p` with a slash send one command the same way and print its answer alone. Exit 0 is an answer
// `ok` on stdout with stderr empty, 1 any other answer or no core (the reason on stderr, stdout empty), and 2 a line the
// table refuses, a word the table does not know, or a request that needs a terminal (bin/neptunia-request.ts), each
// with no connection. A question with no terminal to ask at exits 1 and names itself on stderr; `--secret-stdin` on a
// leaf that asks for a secret answers that one question from stdin. `-p` with text is a `message.received` line like
// one typed in the chat: it waits for the `command.result` that names the line's message id, which the core sends when
// the turn over the line ended (src/interface/neptunia-cli.ts), and prints her reply. A chat with no terminal explains
// itself and exits 2 unless `NEPTUNIA_PLAIN_CHAT=1` asks for the chat over the pipes. Log lines go to stderr.
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
// config.local.json, the local layer, the key store's keys of the enabled roles, the client tokens, the features (the
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
import type { BackendName } from '../src/agent-runner/profiles.ts';
import type { RunnerTask } from '../src/agent-runner/protocol.ts';
import { startSweeper } from '../src/agent-runner/sweep.ts';
import { spawnGh } from '../src/selfimprovement/repository.ts';
import { spawnRun } from '../src/setup/install.ts';
import { REPLY_CHECK_MS } from '../src/subharness/control.ts';
import type { EnableDeps } from '../src/subharness/control.ts';
import { installSubharness, rollbackSubharness, updateSubharness } from '../src/subharness/install.ts';
import type { InstallRun } from '../src/subharness/install.ts';
import { loginCommand } from '../src/subharness/place.ts';
import type { LoginCommand } from '../src/subharness/place.ts';
import { SetupUsageError, nodeOf, parseSetupArgs, runSetup } from '../src/setup/run.ts';
import type { SetupReport } from '../src/setup/run.ts';
import { featureRows } from '../src/subharness/summary.ts';
import { defaultDenyDir, runAgent } from '../src/subharness/run.ts';
import { ROOT_DIR, deepMerge, readConfig, resolveEnvRefs } from '../src/config.ts';
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
import { COMMANDS, parseCommandLine } from '../src/interface/commands/table.ts';
import type { StatusBrief } from '../cli/index.ts';
import { chatPanel } from './chat-panels.ts';
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
import { serveAdapter } from '../src/protocol/serve.ts';
import { runSelfimprovement } from './selfimprovement.ts';
import { runTask, openBoardCaller } from './neptunia-task.ts';
import { reportAnswer } from './report.ts';
import {
  COMMANDS_LINE,
  COMMAND_NAMES,
  UnansweredQuestion,
  panelRefusal,
  parseLineRequest,
  parseRequest,
  secretFromStdin,
  unansweredText,
} from './neptunia-request.ts';
import type { Request } from './neptunia-request.ts';
import { createAnswers, mutableOutput } from './secret-prompt.ts';
import type { Answers } from './secret-prompt.ts';
import { reportsDirOf, watcherDir } from '../src/watcher/read.ts';
import { runWatcher } from '../src/watcher/run.ts';
import type { RunAgent } from '../src/watcher/run.ts';
import type { CommandResult, Logger } from '../src/protocol/serve.ts';
import { MAX_FRAME_BYTES, connectSocket } from '../src/protocol/wire.ts';
import type { Transport } from '../src/protocol/wire.ts';

const USAGE = [
  'usage: neptunia                      the chat, at a terminal',
  '       neptunia <command> [args]     one command, its answer on stdout',
  '       neptunia -p "/<command> [args]"   the same as a typed line',
  '       neptunia -p "<text>"          one turn with the persona, her reply on stdout',
  '       neptunia doctor [live] [--live] [--json]',
  '       neptunia errand-runner --profile <name>',
  '       neptunia interface run <name> [--interfaces-dir <dir>]',
  '       neptunia service start|stop|restart|status [<unit> ...]',
  '       neptunia setup [--system] [--node <path>] [folders|keys-file|subharness|selfimprovement|mechanics|watcher|units|linger|core]',
  '       neptunia setup subharness codex|claude|opencode [--from <path>] [--version <version>] [--rollback]',
  '       neptunia task <command> [options]   (neptunia task help)',
  '       neptunia selfimprovement run',
  '       neptunia watcher run',
  COMMANDS_LINE,
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
  /** Sends a line and waits for the end of the turn over it. */
  turn(text: string): Promise<Answer>;
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
    async turn(text) {
      const event = lineEvent(text, Date.now());
      keep(transcript, event);
      const replyRef = event.message.id;
      const ended = new Promise<Reply>((resolve) => waiting.set(replyRef, resolve));
      const acked = await served.emit(event);
      if (acked === 'ok') return ended;
      waiting.delete(replyRef);
      return { text: `the core did not take the line (${acked})`, status: acked };
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
        const { dialogId, prompt, secret } = reply.ask;
        if (answers === undefined) return { text: unansweredText(prompt, secret), status: 'invalid' };
        let answer: string;
        try {
          answer = await answers.ask(prompt, secret);
        } catch (err) {
          if (err instanceof UnansweredQuestion) return { text: err.message, status: 'invalid' };
          throw err;
        }
        reply = await send({ dialogId, answer });
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

/** Ends the process with a line the table refused or a request that needs a terminal: exit 2, the reason on stderr. */
function refuseSyntax(reason: string): never {
  console.error(`neptunia: ${reason}`);
  process.exit(2);
}

/** Ends the process with one answer: `ok` on stdout and exit 0, anything else on stderr and exit 1. */
function finish(answer: Answer): never {
  if (answer.status === 'ok') {
    if (answer.text !== '') printBlock(answer.text);
    process.exit(0);
  }
  console.error(`neptunia: ${answer.text === '' ? answer.status : answer.text}`);
  process.exit(1);
}

/** The `cli` client's link for one request; no core listening ends the process with exit 1. */
async function requireCliLink(print: ((text: string) => void) | null): Promise<CliLink> {
  try {
    return await openCliLink(print);
  } catch (err) {
    return die(
      `no core listens (${(err as NodeJS.ErrnoException).code ?? 'error'}); start it with neptunia service start`
    );
  }
}

/** One parsed command to its answer: the direct form and `-p` with a slash. */
async function runCommand({ parsed, secretStdin }: Request): Promise<never> {
  if (!parsed.ok) return refuseSyntax(parsed.reason);
  const command = { name: parsed.name, args: parsed.args };
  if (LOCAL_COMMANDS.has(command.name)) {
    const link = command.name === 'doctor.live' ? await tryCliLink() : null;
    const answer = await runLocal(command, link === null ? null : (asked) => link.ask(asked));
    link?.close();
    // The doctor's lines are its result even when a check failed, as `neptunia doctor` prints them; the exit code says so.
    if (command.name.startsWith('doctor') && answer.status !== 'ok') {
      printBlock(answer.text);
      process.exit(1);
    }
    return finish(answer);
  }
  const link = await requireCliLink(null);
  // A command that asks a question (a key value) reads the answer from the terminal when there is one.
  const questions = !secretStdin && process.stdin.isTTY === true ? openQuestions() : null;
  const answers = secretStdin ? secretFromStdin(process.stdin) : questions?.answers;
  const answer = await link.ask(command, answers);
  questions?.close();
  link.close();
  return finish(answer);
}

/** The longest `-p` waits for the end of a turn (ms), so a line that never gets a turn still ends; decided 2026-11-04. */
const TURN_WAIT_MS = 15 * 60 * 1000;

/** `-p` with text: one line in the chat, her reply on stdout once the turn over it ended. Silence is an empty reply. */
async function runPrompt(text: string): Promise<never> {
  const said: Array<string> = [];
  const link = await requireCliLink((part) => said.push(part));
  const late = new Promise<Answer>((resolve) => {
    setTimeout(
      () => resolve({ text: `no end of her turn in ${TURN_WAIT_MS / 60_000} minutes`, status: 'failed' }),
      TURN_WAIT_MS
    );
  });
  const answer = await Promise.race([link.turn(text), late]);
  link.close();
  return finish(answer.status === 'ok' ? { text: said.join('\n'), status: 'ok' } : answer);
}

/** `-p "<text>"`: a leading slash is a command, anything else is one turn with her. */
async function runPrint(argv: ReadonlyArray<string>): Promise<never> {
  const [text, ...rest] = argv;
  if (text === undefined || rest.length > 0 || text.trim() === '') return usage();
  const line = text.trim();
  if (!line.startsWith('/')) return runPrompt(text);
  if (line === '/setup') return refuseSyntax(panelRefusal('/setup'));
  if (line === '/clear' && process.stdout.isTTY !== true) return refuseSyntax(panelRefusal('/clear'));
  return runCommand(parseLineRequest(line));
}

/** `neptunia <words...>`: a word of the table is a command, read as argv gives it; any other opens no connection. */
async function runDirect(words: ReadonlyArray<string>): Promise<never> {
  if (!COMMAND_NAMES.includes(words[0] ?? '')) return usage();
  if (words.length === 1 && words[0] === 'clear' && process.stdout.isTTY !== true)
    return refuseSyntax(panelRefusal('clear'));
  return runCommand(parseRequest(words));
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
 * The chat in a terminal (cli/): the same link, commands and handlers as the plain chat, only another presentation. It
 * asks the core `status.brief` for its status line, which reads what the core knows and calls no provider.
 */
/** Interface names offered by setup, including persona-authored packages. */
function interfaceNames(dataDir: string): Array<string> {
  const names = new Set<string>();
  for (const dir of [path.join(ROOT_DIR, 'interfaces'), path.join(dataDir, 'interfaces')]) {
    if (!fs.existsSync(dir)) continue;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory() && fs.existsSync(path.join(dir, entry.name, 'setup.json'))) names.add(entry.name);
    }
  }
  return [...names].sort();
}

async function runInkChat(where: { privateDir: string }, firstLine = ''): Promise<void> {
  const { runInteractive, reducedMotion } = await import('../cli/index.ts');
  let entry: (one: { who: 'owner' | 'her' | 'system'; text: string }) => void = () => {};
  let question: (asked: { question: string; secret: boolean; answer: (text: string) => void }) => void = () => {};
  let linked: (connected: boolean) => void = () => {};
  const say = (text: string): void => entry({ who: 'her', text });
  let link: CliLink;
  try {
    link = await openCliLink(say);
  } catch (err) {
    die(`no core listens (${(err as NodeJS.ErrnoException).code ?? 'error'}); start it with neptunia service start`);
  }
  void link.closed.then(() => linked(false));
  const answers: Answers = {
    ask: (asked, secret) =>
      new Promise((resolve) => {
        question({ question: asked, secret, answer: resolve });
      }),
    take: () => false,
    secretWaiting: () => false,
  };
  const historyFile = path.join(where.privateDir, 'cli', 'history');
  const run = (parsed: Command): Promise<Answer> =>
    LOCAL_COMMANDS.has(parsed.name) ? runLocal(parsed, (asked) => link.ask(asked)) : link.ask(parsed, answers);
  await runInteractive({
    title: 'Project Neptunia',
    initialInput: firstLine,
    commands: [
      { name: 'setup', help: 'Connect services, interfaces and skills' },
      ...COMMANDS.flatMap((command) => [
        { name: command.name, help: command.help },
        ...command.subcommands.map((sub) => ({
          name: `${command.name} ${sub.name.replaceAll('.', ' ')}`,
          help: sub.help,
        })),
      ]),
    ],
    history: readHistory(historyFile),
    still: reducedMotion(process.env),
    now: () => Date.now(),
    subscribe(listeners) {
      entry = listeners.entry;
      question = listeners.question;
      linked = listeners.connected;
    },
    saveHistory(lines) {
      fs.mkdirSync(path.dirname(historyFile), { recursive: true, mode: 0o700 });
      fs.writeFileSync(historyFile, `${[...lines].reverse().join('\n')}\n`, { mode: 0o600 });
    },
    status: async () => {
      const answer = await link.ask({ name: 'status.brief', args: {} });
      return answer.status === 'ok' ? (JSON.parse(answer.text) as StatusBrief | null) : null;
    },
    panelOf: (line) => chatPanel(line, run, interfaceNames(where.privateDir)),
    send(line) {
      const text = line.trim();
      if (!text.startsWith('/')) {
        void link.say(line).then((status) => {
          if (status !== 'ok') entry({ who: 'system', text: `the core did not take the line (${status})` });
        });
        return;
      }
      const parsed = parseCommandLine(text);
      if (!parsed.ok) entry({ who: 'system', text: parsed.reason });
      else void run(parsed).then((answer) => entry({ who: 'system', text: answer.text }));
    },
  });
  link.close();
  process.exit(0);
}

/**
 * The chat. With `firstLine` (`neptunia setup` hands it `/keys core add`) that line is typed first, and the chat
 * returns to its caller when the input ends instead of ending the process.
 */
async function runChat(firstLine?: string): Promise<void> {
  const where = paths();
  const terminal = process.stdin.isTTY === true && process.stdout.isTTY === true;
  if (terminal && process.env.NEPTUNIA_PLAIN_CHAT !== '1') return runInkChat(where, firstLine);
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
  return { name: 'env-keys', status: 'fail', detail: 'no keys.json: run neptunia setup, then /keys core add' };
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
    names = new Set();
  } catch {
    return { name: 'roles', status: 'warn', detail: 'not checked: the config does not read' };
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
  const live = argv.includes('--live') || argv.includes('live');
  if (argv.some((arg) => arg !== '--json' && arg !== '--live' && arg !== 'live')) usage();
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
  if (process.stdin.isTTY === true && process.stdout.isTTY === true && process.env.TERM !== 'dumb') {
    const { askQuestion } = await import('../cli/question.ts');
    const choices =
      offered === 'on' || offered === 'off'
        ? ['on', 'off']
        : question.includes('(yes or no)')
          ? ['yes', 'no']
          : undefined;
    return askQuestion(question, offered, { ...options, choices });
  }
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

/** `setup subharness <backend> --rollback` or `--version <version>`: the owner's explicit change of a pinned version. */
async function changeSubharnessVersion(backend: BackendName, flag: string, value: string | undefined): Promise<void> {
  const { privateDir } = paths();
  if ((flag === '--rollback') !== (value === undefined)) usage();
  const outcome =
    value === undefined
      ? rollbackSubharness(privateDir, backend)
      : await updateSubharness({ privateDir, backend, hostEnv: process.env, version: value }, installRun);
  console.log(`${outcome.state.padEnd(8)}  subharness ${backend}  ${outcome.detail}`);
  if (outcome.state === 'failed') process.exitCode = 1;
}

/** The `--help` of the binary `login` starts, empty when it did not run. */
function installedHelp(login: LoginCommand): string {
  const run = spawnSync(login.command, ['--help'], {
    env: { PATH: process.env.PATH ?? '', HOME: os.homedir(), ...login.env },
    encoding: 'utf8',
    timeout: 30_000,
  });
  return run.error === undefined ? run.stdout : '';
}

/**
 * `setup subharness <backend> [--from <path>]`: the backend installed into the private layer, then the login line the
 * owner types at this terminal. opencode is copied from `--from`, else from `errands.opencodePath`.
 */
async function runSubharnessSetup(argv: ReadonlyArray<string>): Promise<void> {
  const [name, flag, value, ...extra] = argv;
  const backend = BACKEND_NAMES.find((known) => known === name);
  if (backend === undefined || extra.length > 0) usage();
  if (flag === '--rollback' || flag === '--version') return changeSubharnessVersion(backend, flag, value);
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
  // The login subcommand of claude differs between releases: the installed binary's help names the one it has. A help
  // that names none, or a binary that did not run, throws here and `fault` prints the diagnostic with exit 1.
  const help = backend === 'claude' ? installedHelp(plain) : undefined;
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
    // A chat over pipes is asked for by name: nobody may be writing to them, and Ink cannot draw on them.
    if ((process.stdin.isTTY !== true || process.stdout.isTTY !== true) && process.env.NEPTUNIA_PLAIN_CHAT !== '1')
      refuseSyntax(panelRefusal('the chat'));
    logToStderr();
    await runChat().catch(fault);
    break;
  case '-p':
    logToStderr();
    await runPrint(rest).catch(fault);
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
    // `interface run` is the runner a unit starts; the other forms are the table's management family.
    if (rest[0] === 'run') {
      await runInterface(rest).catch(fault);
    } else {
      logToStderr();
      await runDirect([group, ...rest]).catch(fault);
    }
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
    logToStderr();
    await runDirect([group, ...rest]).catch(fault);
}
