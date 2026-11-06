#!/usr/bin/env node
// The `neptunia` command (package.json `bin`): the owner's chat with the persona, one command for a script, the checks
// of an installation, the errand runner and the interface runner that the systemd units start, and the units
// themselves.
//
//   neptunia                                     the chat, at a terminal
//   neptunia <command> [args]                    one command of the chat's table, its words kept as argv gives them
//   neptunia -p "/<command> [args]"              one command as a typed line
//   neptunia -p "<text>" [--attach <file>]...    one turn with the persona, with images; her reply on stdout
//   neptunia doctor [live] [--live] [--json]     the checks of the installation, with the core up or down
//   neptunia doctor server|core|memory           one read of the running core, which answers it
//   neptunia errand-runner --profile <name>      the errand runner of one agent (deploy/neptunia-agent-<name>.service)
//   neptunia interface run <name> [--interfaces-dir <dir>]   one interface (deploy/neptunia-interface@.service)
//   neptunia services list                       the four scheduled mechanics (src/service/commands.ts)
//   neptunia services <name> setup|enable|disable|status   one of them
//   neptunia services watcher trigger|cancel     the operations of one watcher run
//   neptunia services watcher evidence [--from <iso>] [--cursor <c>]  what the services asked and answered, as JSON
//   neptunia services watcher select --sql <statement>  one read-only statement over the memory database, as JSON
//   neptunia services start|stop|restart|status [<unit> ...]   the units, through the scope's systemctl
//   neptunia logs [errors] [follow] [since <when>]   the core's journal, in the scope of the units
//   neptunia logs watcher [<date or run>]        the watcher's saved report, with no core
//   neptunia setup [--system] [--node <path>]    the install of one user, one flow: folders, keys file, her subharness
//                                                backends, the repository of her self-development, her mechanics,
//                                                the watcher, units, linger, the core. A name of a step is refused.
//   neptunia subharness <backend> login|status|logout   its account, with no core (src/subharness/account.ts)
//   neptunia tasks <command> [options]           the task board's command line (bin/neptunia-task.ts)
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
// `/logs` (journalctl of the core's unit in the units' scope, src/service/journal.ts), `/logs watcher` (the saved reports) and `/services`
// (bin/neptunia-service.ts) run here and ask the core nothing, but `/doctor live` asks it for the probes of the model roles. A line typed before the link is up waits in the input until it is. The chat opens with the core's
// header and, above it, the picture in `<private>/cli/picture.txt` when that file exists. In a terminal the command
// history is kept in `<private>/cli/history` (bin/cli-history.ts). The end of the input ends the chat with exit 0, once the answers of the
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
// A chat launch reads its readiness first (src/setup/readiness.ts). At a terminal a gap enters the one setup flow there
// (src/setup/flow.ts), and over pipes it prints `setup-required` with the repairs and exits 1. Every other command stays
// reachable, and `doctor` reports the same readiness as a check.
//
// `worker` names what a unit starts, and the usage leaves it out: `worker watcher` (deploy/neptunia-watcher.service) ends
// at once while `watcher.enabled` is false, and otherwise runs one inspection under one run identity
// (bin/neptunia-watcher.ts, docs/watcher.md).
//
// `worker development` (deploy/neptunia-development.service) is the long-lived development worker (bin/development.ts,
// docs/selfimprovement.md) as the client `development`: a filed task starts a thinker, and a finished one a pull request.
// `worker development held` lists the tasks older than its boundary. It exits 1 when the board is not reachable.
//
// `doctor` writes nothing and asks no model without `--live`: it checks Node, the binaries the engine runs, config.json and
// config.local.json, the local layer, the key store's keys of the enabled roles, the client tokens, the features (the
// subharness and the simulation, a warning while either is off), the memory database (read only, with no lock) and the socket. `runtime` is the core's reading of the server, itself and the memory
// (`/doctor server`, `core` and `memory` read one each), `skipped` when no core answers in time. `--live` adds `providers` in its place, the core's probes of the model roles, which is
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
import { createAgentEngine } from '../src/agent-runner/backend.ts';
import { agentSettings, profileOf } from '../src/agent-runner/profiles.ts';
import type { RunnerTask } from '../src/agent-runner/protocol.ts';
import { startSweeper } from '../src/agent-runner/sweep.ts';
import { spawnGh } from '../src/selfimprovement/repository.ts';
import { spawnRun } from '../src/setup/install.ts';
import type { RunResult } from '../src/setup/install.ts';
import { installGhOfficially } from '../src/setup/development.ts';
import { runSetupFlow, setupFlowSteps } from '../src/setup/flow.ts';
import { decideLaunch, evaluateReadiness, gatherHealth, readinessText } from '../src/setup/readiness.ts';
import type { HealthLink, ReadinessHealth } from '../src/setup/readiness.ts';
import { followsJournal, journalCall, readJournal } from '../src/service/journal.ts';
import { unitFolder, unitScope } from '../src/service/manager.ts';
import { accountCommand } from '../src/subharness/account.ts';
import type { InstallRun } from '../src/subharness/install.ts';
import { SetupUsageError, nodeOf, parseSetupArgs, runSetup } from '../src/setup/run.ts';
import type { SetupDeps, SetupOptions, SetupReport } from '../src/setup/run.ts';
import { accountRequest } from '../src/interface/commands/subharness.ts';
import { featureRows } from '../src/subharness/summary.ts';
import { defaultDenyDir } from '../src/subharness/run.ts';
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
import { COMMANDS, isRetiredCommand, parseCommandLine } from '../src/interface/commands/table.ts';
import type { ChatAttachment, ChatEntry, KeyBinding, PasteLimits, Question, StatusBrief } from '../cli/index.ts';
import { chatPanel } from './chat-panels.ts';
import { CLIENTS_FILE, loadPrincipals } from '../src/interface/principals.ts';
import { coreSocketPath } from '../src/interface/socket.ts';
import { BASE_ROLES, MEMORY_ROLE } from '../src/llm/roles.ts';
import { createKeyStore, keysFileExists } from '../src/keys/store.ts';
import { ROLE_KEY_NAME, STRICT_KEY_ROLES } from '../src/llm/openrouter.ts';
import { log, logToStderr } from '../src/log.ts';
import { resolvePaths } from '../src/paths.ts';
import type { InterfaceHost, RunningInterface } from '../src/protocol/host.ts';
import { chatImages, draftEditor, keepReceived, receivedActions, stageForPrompt } from './chat-images.ts';
import { addToHistory, readHistory, writeHistory } from './cli-history.ts';
import type { HistoryRecord } from './cli-history.ts';
import { CLI_CLIENT, openLinkOver } from './cli-link.ts';
import type { Answer, CliLink, Command, LineImage, LinkAnswers } from './cli-link.ts';
import { runDevelopment } from './development.ts';
import { readTurnEvent } from '../src/protocol/turn-control.ts';
import type { TurnEvent } from '../src/protocol/turn-control.ts';
import type { MessageEvent as ChatLine } from '../src/protocol/adapter.ts';
import { runTask } from './neptunia-task.ts';
import { runWatcherWorker } from './neptunia-watcher.ts';
import {
  askSetup,
  isServiceRequest,
  prefersCore,
  retiredSetupStep,
  runServiceHere,
  runUnitVerbs,
  watcherLogsHere,
} from './neptunia-service.ts';
import {
  COMMANDS_LINE,
  COMMAND_NAMES,
  panelRefusal,
  parseLineRequest,
  parseRequest,
  secretFromStdin,
} from './neptunia-request.ts';
import type { Request } from './neptunia-request.ts';
import { createAnswers, mutableOutput } from './secret-prompt.ts';
import type { Answers } from './secret-prompt.ts';
import { MAX_FRAME_BYTES, connectSocket } from '../src/protocol/wire.ts';
import type { Transport } from '../src/protocol/wire.ts';
import type { Attachment } from '../src/protocol/actions.ts';
import { stagingDir } from '../src/media/staging.ts';

const USAGE = [
  'usage: neptunia                      the chat, at a terminal',
  '       neptunia <command> [args]     one command, its answer on stdout',
  '       neptunia -p "/<command> [args]"   the same as a typed line',
  '       neptunia -p "<text>" [--attach <file>]...   one turn with the persona, her reply on stdout',
  '       neptunia doctor [live] [--live] [--json]',
  '       neptunia doctor server|core|memory',
  '       neptunia errand-runner --profile <name>',
  '       neptunia interface run <name> [--interfaces-dir <dir>]',
  '       neptunia services list',
  '       neptunia services <name> setup|enable|disable|status   (heartbeat, selfreflection, selfimprovement, watcher)',
  '       neptunia services watcher trigger|cancel',
  '       neptunia services watcher evidence [--from <iso>] [--cursor <c>]',
  '       neptunia services watcher select --sql <statement>',
  '       neptunia services start|stop|restart|status [<unit> ...]',
  '       neptunia logs watcher [<date or run>]',
  '       neptunia setup [--system] [--node <path>]',
  '       neptunia subharness codex|claude login|status|logout',
  '       neptunia subharness opencode login --key <name>|status|logout',
  '       neptunia tasks <command> [options]   (neptunia tasks help)',
  COMMANDS_LINE,
].join('\n');

/** The first wait before a new connection, and the longest. */
const BACKOFF_FIRST_MS = 250;
const BACKOFF_MAX_MS = 30_000;
/** A link that stayed up this long was healthy: the backoff starts over after it. */
const STABLE_MS = 30_000;

/** An interface name as scripts/client-token.ts accepts a client name. */
const NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;

type Settings = Record<string, unknown>;
type InterfacePackage = { start(host: InterfaceHost): Promise<RunningInterface> };

/** How long an exit waits for a reader that holds a pipe open and does not read. */
const FLUSH_LIMIT_MS = 30_000;

/** The exit code of a process whose reader went away, as a shell reports a broken pipe. */
const BROKEN_PIPE_EXIT = 141;

/**
 * A reader that closes the pipe (`| head -1`) is an ordinary end, not a fault: the write error is swallowed and the
 * process ends with the shell's broken-pipe code instead of a stack trace.
 */
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EPIPE') process.exit(BROKEN_PIPE_EXIT);
    throw err;
  });
}

/**
 * Ends the process once stdout and stderr have handed every byte to the pipe. `process.exit` drops what a pipe has not
 * taken yet, so a large answer piped to `jq` would arrive cut at the pipe size with exit 0. A reader that went away
 * ends the wait at once, and a reader that never reads ends it after `FLUSH_LIMIT_MS`.
 */
async function exitAfterFlush(code: number): Promise<never> {
  const drained = [process.stdout, process.stderr].map(
    (stream) =>
      new Promise<void>((resolve) => {
        if (stream.destroyed || stream.writableLength === 0) return resolve();
        stream.write('', () => resolve());
        stream.once('error', () => resolve());
      })
  );
  const limit = new Promise<void>((resolve) => setTimeout(resolve, FLUSH_LIMIT_MS));
  await Promise.race([Promise.all(drained), limit]);
  return process.exit(code);
}

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

/** Connects as the `cli` client; rejects when no core listens. `print` takes her replies, null for none. */
async function openCliLink(
  print: ((text: string) => void) | null,
  deliver?: (file: Attachment) => Promise<void>,
  chat: { onTurnEvent: (event: TurnEvent) => void; transcript: Array<ChatLine> } | null = null
): Promise<CliLink> {
  const where = paths();
  const token = readToken(where.privateDir, CLI_CLIENT);
  const transport = await connectSocket({ path: coreSocketPath(where.dataDir), maxFrameBytes: MAX_FRAME_BYTES });
  return openLinkOver(transport, { token, print, deliver: deliver ?? printedFile(print), ...(chat ?? {}) });
}

/** A file she sends to a chat with no screen of its own: kept in the staging folder, and one printed line says where. */
function printedFile(print: ((text: string) => void) | null): ((file: Attachment) => Promise<void>) | null {
  if (print === null) return null;
  const { dataDir } = paths();
  return async (file) => {
    const kept = await keepReceived(dataDir, file);
    print(
      'note' in kept
        ? kept.note
        : `[image ${kept.attachment.name}] ${path.join(stagingDir(dataDir), kept.attachment.id)}`
    );
  };
}

/** The commands the command line runs itself: the doctor, the journal, the saved reports, the screen and the service family. */
const LOCAL_COMMANDS = new Set(['doctor', 'doctor.live', 'logs', 'logs.watcher', 'clear']);
const runsHere = (name: string): boolean => LOCAL_COMMANDS.has(name) || isServiceRequest(name);

// A journal read in full can be long; the runner's default buffer would cut it.
const JOURNAL_BUFFER_BYTES = 64 * 1024 * 1024;

/** The runner of `/logs`: rejects with the code when journalctl cannot start. */
function runJournal(command: string, args: ReadonlyArray<string>): Promise<RunResult> {
  const run = spawnSync(command, [...args], { encoding: 'utf8', maxBuffer: JOURNAL_BUFFER_BYTES });
  if (run.error !== undefined) return Promise.reject(run.error);
  return Promise.resolve({ code: run.status ?? 1, stdout: run.stdout, stderr: run.stderr });
}

/** `/logs ... follow` in the chat: journalctl's lines printed as they come, until the chat ends. */
function followJournal(options: string, print: (text: string) => void): Promise<unknown> {
  const [command, args] = journalCall(process.env, options);
  const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
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

/** A command the command line runs itself; `ask` reaches the core for the probes of `doctor.live`, null when down. */
async function runLocal(command: Command, ask: ((command: Command) => Promise<Answer>) | null): Promise<Answer> {
  if (command.name === 'clear') return { text: '', status: 'ok' };
  if (command.name === 'logs')
    return readJournal(process.env, typeof command.args.options === 'string' ? command.args.options : '', runJournal);
  const color = process.stdout.isTTY && !process.env.NO_COLOR;
  if (command.name === 'logs.watcher') return watcherLogsHere(command.args, paths(), color);
  if (isServiceRequest(command.name)) {
    if (ask !== null && prefersCore(command.name)) return ask(command);
    return runServiceHere(command, paths(), color);
  }
  const checks = await doctorChecks(paths(), { ask, live: command.name === 'doctor.live' });
  return { text: checkLines(checks), status: checks.some((check) => check.status === 'fail') ? 'failed' : 'ok' };
}

/** Ends the process with a line the table refused or a request that needs a terminal: exit 2, the reason on stderr. */
function refuseSyntax(reason: string): never {
  console.error(`neptunia: ${reason}`);
  process.exit(2);
}

/** Ends the process with one answer: `ok` on stdout and exit 0, anything else on stderr and exit 1. */
async function finish(answer: Answer): Promise<never> {
  if (answer.status === 'ok') {
    if (answer.text !== '') printBlock(answer.text);
    return exitAfterFlush(0);
  }
  console.error(`neptunia: ${answer.text === '' ? answer.status : answer.text}`);
  return exitAfterFlush(1);
}

/** The `cli` client's link for one request; no core listening ends the process with exit 1. */
async function requireCliLink(print: ((text: string) => void) | null): Promise<CliLink> {
  try {
    return await openCliLink(print);
  } catch (err) {
    return die(
      `no core listens (${(err as NodeJS.ErrnoException).code ?? 'error'}); start it with neptunia services start`
    );
  }
}

/** One parsed command to its answer: the direct form and `-p` with a slash. */
async function runCommand({ parsed, secretStdin }: Request): Promise<never> {
  if (!parsed.ok) return refuseSyntax(parsed.reason);
  const named = { name: parsed.name, args: parsed.args };
  const account = accountRequest(named.name);
  if (account !== null) return finish(await runAccount(account, named.args));
  if (runsHere(named.name)) {
    const isBareSetup =
      named.name.endsWith('.setup') && isServiceRequest(named.name) && Object.keys(named.args).length === 0;
    const command = isBareSetup && process.stdin.isTTY === true ? await askSetup(named, askAtTerminal) : named;
    const link = command.name.startsWith('doctor') || prefersCore(command.name) ? await tryCliLink() : null;
    const answer = await runLocal(command, link === null ? null : (asked) => link.ask(asked));
    link?.close();
    if (isServiceRequest(command.name) && answer.status === 'invalid') return refuseSyntax(answer.text);
    // The doctor's lines are its result even when a check failed, as `neptunia doctor` prints them; the exit code says so.
    if (command.name.startsWith('doctor') && answer.status !== 'ok') {
      printBlock(answer.text);
      return exitAfterFlush(1);
    }
    return finish(answer);
  }
  const command = named;
  const link = await requireCliLink(null);
  // A command that asks a question (a key value) reads the answer from the terminal when there is one.
  const questions = !secretStdin && process.stdin.isTTY === true ? openQuestions() : null;
  const answers = secretStdin ? secretFromStdin(process.stdin) : questions?.answers;
  const answer = await link.ask(command, answers);
  questions?.close();
  link.close();
  return finish(answer);
}

/** `neptunia subharness <backend> login|status|logout`: runs here with no core, so a broken core can be repaired from a shell. */
async function runAccount(
  request: NonNullable<ReturnType<typeof accountRequest>>,
  args: Command['args']
): Promise<Answer> {
  const where = paths();
  const config = readConfig(where.rootDir, { privateDir: where.privateDir });
  const errands = isObject(config.errands) ? config.errands : {};
  const key = typeof args.key === 'string' ? args.key : undefined;
  return accountCommand(
    {
      privateDir: where.privateDir,
      hostEnv: process.env,
      install: installRun,
      ask: process.stdin.isTTY === true ? (question) => askAtTerminal(question, null) : null,
      opencodeSource: typeof errands.opencodePath === 'string' ? errands.opencodePath : DEFAULT_OPENCODE_PATH,
    },
    request.backend,
    request.action,
    key === undefined ? {} : { key }
  );
}

/** The longest `-p` waits for the end of a turn (ms), so a line that never gets a turn still ends; decided 2026-11-04. */
const TURN_WAIT_MS = 15 * 60 * 1000;

/** `-p` with text: one line in the chat, her reply on stdout once the turn over it ended. Silence is an empty reply. */
async function runPrompt(text: string, images: ReadonlyArray<LineImage>): Promise<never> {
  const said: Array<string> = [];
  const link = await requireCliLink((part) => said.push(part));
  const late = new Promise<Answer>((resolve) => {
    setTimeout(
      () => resolve({ text: `no end of her turn in ${TURN_WAIT_MS / 60_000} minutes`, status: 'failed' }),
      TURN_WAIT_MS
    );
  });
  const answer = await Promise.race([link.turn(text, images), late]);
  link.close();
  return finish(answer.status === 'ok' ? { text: said.join('\n'), status: 'ok' } : answer);
}

/** The words after `-p`: the text first, then each `--attach <file>`. Null for anything else. */
function parsePrint(argv: ReadonlyArray<string>): { text: string; files: Array<string> } | null {
  const [text, ...rest] = argv;
  if (text === undefined || text.trim() === '' || rest.length % 2 !== 0) return null;
  const files: Array<string> = [];
  for (let at = 0; at < rest.length; at += 2) {
    const file = rest[at + 1];
    if (rest[at] !== '--attach' || file === undefined) return null;
    files.push(file);
  }
  return { text, files };
}

/** `-p "<text>"`: a leading slash is a command, anything else is one turn with her. An image is staged before any connection. */
async function runPrint(argv: ReadonlyArray<string>): Promise<never> {
  const parsed = parsePrint(argv);
  if (parsed === null) return usage();
  const { text, files } = parsed;
  const line = text.trim();
  if (!line.startsWith('/')) {
    const prepared = await stageForPrompt(paths().dataDir, files);
    if (!prepared.ok) return die(prepared.reason);
    return runPrompt(text, prepared.staged);
  }
  if (files.length > 0) return usage();
  if (line === '/setup') return refuseSyntax(panelRefusal('/setup'));
  if (line === '/clear' && process.stdout.isTTY !== true) return refuseSyntax(panelRefusal('/clear'));
  return runCommand(parseLineRequest(line));
}

/** `neptunia <words...>`: a word of the table is a command, read as argv gives it; any other opens no connection. */
async function runDirect(words: ReadonlyArray<string>): Promise<never> {
  if (!COMMAND_NAMES.includes(words[0] ?? '') && !isRetiredCommand(words[0] ?? '')) return usage();
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

/** How many drafts the history file keeps, as readline's `historySize` of the plain chat. */
const HISTORY_SIZE = 1000;

/** The plain chat's history, as readline keeps it: lines, newest first. A line it adds is a record of that line alone. */
function saveLines(file: string, lines: ReadonlyArray<string>, now: number): void {
  const known = new Map(readHistory(file).records.map((one) => [one.text, one]));
  writeHistory(
    file,
    lines.map((text) => known.get(text) ?? { version: 1, text, attachments: [], at: now })
  );
}

/** A history record's images as draft parts. They hold no staging of their own to free: a new id belongs to no staged file. */
const recalledImages = (record: HistoryRecord): Array<ChatAttachment> =>
  record.attachments.map((one, index) => ({ ...one, id: `history-${record.at}-${index}` }));

/** The settings of the chat's input, read when they are used. */
function pasteLimits(where: { rootDir: string; privateDir: string }): PasteLimits {
  const config = readConfig(where.rootDir, { privateDir: where.privateDir }) as {
    cli?: { paste?: Partial<PasteLimits> };
  };
  const paste = config.cli?.paste;
  return { collapseLines: paste?.collapseLines ?? 10, collapseChars: paste?.collapseChars ?? 2000 };
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

/** How often the chat tries the core again after a lost link. Decided 2026-11-05: short, and a local socket costs nothing. */
const RECONNECT_MS = 2000;

async function runInkChat(
  where: { rootDir: string; privateDir: string; dataDir: string },
  firstLine = ''
): Promise<void> {
  const { mouseAvailable, runInteractive, reducedMotion } = await import('../cli/index.ts');
  const settings = readConfig(where.rootDir, { privateDir: where.privateDir }) as {
    cli?: { mouse?: boolean; bindings?: Array<KeyBinding> };
  };
  const linear = process.env.NEPTUNIA_LINEAR === '1';
  let entry: (one: ChatEntry) => void = () => {};
  let question: (asked: Question) => void = () => {};
  let linked: (connected: boolean) => void = () => {};
  let turnEvent: (event: TurnEvent) => void = () => {};
  let coreRestarted: () => void = () => {};
  let showView: (entries: ReadonlyArray<ChatEntry>) => void = () => {};
  const say = (text: string): void => entry({ who: 'her', text });
  const transcript: Array<ChatLine> = [];
  let lastSeq = 0;
  let coreInstance: string | null = null;
  const onTurnEvent = (event: TurnEvent): void => {
    lastSeq = Math.max(lastSeq, event.seq);
    turnEvent(event);
  };
  const openChatLink = (): Promise<CliLink> =>
    openCliLink(
      say,
      async (file) => {
        const kept = await keepReceived(where.dataDir, file);
        entry(
          'note' in kept ? { who: 'system', text: kept.note } : { who: 'her', text: '', attachments: [kept.attachment] }
        );
      },
      { onTurnEvent, transcript }
    );
  let link: CliLink;
  try {
    link = await openChatLink();
  } catch (err) {
    die(`no core listens (${(err as NodeJS.ErrnoException).code ?? 'error'}); start it with neptunia services start`);
  }
  /** Subscribes this link to the turn events and takes what the last link missed. Another core held none of the old turns. */
  async function followTurns(): Promise<void> {
    const answer = await link.ask({ name: 'turn.replay', args: { after: lastSeq } });
    if (answer.status !== 'ok') return;
    const { instance, events } = JSON.parse(answer.text) as { instance: string; events: Array<unknown> };
    if (coreInstance !== null && coreInstance !== instance) {
      lastSeq = 0;
      coreRestarted();
    }
    coreInstance = instance;
    for (const one of events) {
      const read = readTurnEvent(one);
      if (read.ok) onTurnEvent(read.event);
    }
  }
  /** When `current` closes: the chat says so, tries again until a core answers, and then takes the turns back up. */
  function watchLink(current: CliLink): void {
    void current.closed.then(async () => {
      linked(false);
      for (;;) {
        await new Promise((resolve) => setTimeout(resolve, RECONNECT_MS));
        try {
          link = await openChatLink();
          break;
        } catch {
          // No core listens yet: the next try.
        }
      }
      linked(true);
      watchLink(link);
      await followTurns();
    });
  }
  watchLink(link);
  const answers: LinkAnswers = {
    ask: (asked, secret, choices) =>
      new Promise((resolve) => {
        question({ question: asked, secret, choices, answer: resolve });
      }),
  };
  const historyFile = path.join(where.privateDir, 'cli', 'history');
  let records: ReadonlyArray<HistoryRecord> = readHistory(historyFile).records;
  const run = (parsed: Command): Promise<Answer> =>
    runsHere(parsed.name) ? runLocal(parsed, (asked) => link.ask(asked)) : link.ask(parsed, answers);
  await runInteractive({
    title: 'Project Neptunia',
    initialInput: firstLine,
    commands: [
      { name: 'setup', help: 'Connect services, interfaces and skills' },
      { name: 'attach', help: 'Attach an image file from this machine to the next message' },
      { name: 'attach open', help: 'Open the newest image she sent' },
      { name: 'attach save', help: 'Save the newest image she sent to a file' },
      { name: 'queue', help: 'Cancel the turn over a line that still waits' },
      { name: 'sessions', help: 'List stored conversations and resume one' },
      { name: 'branch', help: 'Continue this conversation from an earlier line' },
      { name: 'checkpoints', help: "Preview and restore a development task's files" },
      { name: 'approvals', help: 'Approve or reject what waits on the task board' },
      { name: 'context', help: 'The route, the model and the request limit of her turns' },
      { name: 'agents', help: 'Agents and what each may do' },
      { name: 'plugins', help: 'Plugins, which no operation installs yet' },
      ...COMMANDS.flatMap((command) => [
        { name: command.name, help: command.help },
        ...command.subcommands.map((sub) => ({
          name: `${command.name} ${sub.name.replaceAll('.', ' ')}`,
          help: sub.help,
        })),
      ]),
    ],
    history: records.map((one) => one.text),
    recalled: new Map(records.map((one) => [one.text, recalledImages(one)])),
    images: chatImages(where.dataDir),
    received: receivedActions(where.dataDir),
    get composer() {
      return pasteLimits(where);
    },
    still: reducedMotion(process.env),
    linear,
    bindings: settings.cli?.bindings ?? [],
    mouse:
      settings.cli?.mouse === true && mouseAvailable({ tty: true, term: process.env.TERM ?? '', linear, plain: false }),
    editDraft: draftEditor(process.env),
    now: () => Date.now(),
    subscribe(listeners) {
      entry = listeners.entry;
      question = listeners.question;
      linked = listeners.connected;
      turnEvent = listeners.turn;
      coreRestarted = listeners.coreRestarted;
      showView = listeners.view;
      void followTurns();
      // The conversation starts as its root: a new process holds no branch's lines.
      void link.ask({ name: 'session.open', args: {} });
    },
    saveHistory(_lines, added) {
      if (added === undefined) return;
      records = addToHistory(records, added, { now: Date.now(), limit: HISTORY_SIZE });
      try {
        writeHistory(historyFile, records);
      } catch (err) {
        entry({ who: 'system', text: `the history was not saved (${(err as NodeJS.ErrnoException).code ?? 'error'})` });
      }
    },
    status: async () => {
      const answer = await link.ask({ name: 'status.brief', args: {} });
      return answer.status === 'ok' ? (JSON.parse(answer.text) as StatusBrief | null) : null;
    },
    panelOf: (line) =>
      chatPanel(line, run, interfaceNames(where.privateDir), {
        showLines(lines) {
          link.showLines(lines);
          showView(lines.map((one) => ({ who: one.who === 'her' ? 'her' : 'owner', text: one.text })));
        },
      }),
    cancelTurn(turnId) {
      void link.ask({ name: 'turn.cancel', args: { turnId } }).then((answer) => {
        if (answer.status !== 'ok')
          entry({ who: 'system', text: `the cancel did not reach the core (${answer.status})` });
      });
    },
    send(line, attachments = []) {
      const text = line.trim();
      if (!text.startsWith('/')) {
        void link.say(line, attachments).then((status) => {
          if (status !== 'ok' && status !== 'duplicate')
            entry({ who: 'system', text: `the core did not take the line (${status})` });
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

/** The longest a launch waits for the core's health: a core that hangs reads as down, and the chat does not hang on it. */
const READINESS_WAIT_MS = 5000;

/** The link a health read goes through, closed by `done`. */
async function healthLink(where: { dataDir: string }): Promise<{ link: HealthLink; done: () => void }> {
  const opened = await tryCliLink();
  if (opened === null) {
    const socket = await checkSocket(where);
    return { link: { kind: socket.status === 'ok' ? 'listening' : 'down' }, done: () => {} };
  }
  const ask = async (command: Command): Promise<Answer> => {
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<Answer>((resolve) => {
      timer = setTimeout(() => resolve({ text: '', status: 'late' }), READINESS_WAIT_MS);
    });
    const answer = await Promise.race([opened.ask(command), late]);
    clearTimeout(timer);
    return answer;
  };
  return { link: { kind: 'up', ask }, done: () => opened.close() };
}

/** The health of this installation now, over a link of its own. */
async function readHealth(where: { privateDir: string; dataDir: string }): Promise<ReadinessHealth> {
  const { link, done } = await healthLink(where);
  try {
    return await gatherHealth({
      privateDir: where.privateDir,
      dataDir: where.dataDir,
      unitDir: unitFolder(process.env),
      link: () => Promise.resolve(link),
    });
  } finally {
    done();
  }
}

/** One command of the setup flow, with its questions at the terminal; the core's refusal when it could not connect. */
async function askCoreAtTerminal(command: Command): Promise<Answer> {
  const link = await tryCliLink();
  if (link === null) return { text: 'no core listens: start it with neptunia services start', status: 'failed' };
  const questions = openQuestions();
  try {
    return await link.ask(command, questions.answers);
  } finally {
    questions.close();
    link.close();
  }
}

/** A chat launch: the chat when nothing is missing, else the setup flow at the gap, or `setup-required` over pipes. */
async function launchChat(): Promise<void> {
  const where = paths();
  const terminal = process.stdin.isTTY === true && process.stdout.isTTY === true;
  const decision = decideLaunch({ terminal, readiness: evaluateReadiness(await readHealth(where)) });
  switch (decision.kind) {
    case 'chat':
      return runChat();
    case 'setup-required':
      console.error(`neptunia: ${decision.text}`);
      process.exit(1);
      break;
    case 'setup': {
      const options = setupOptions({ system: unitScope(process.env) === 'system' });
      const outcome = await runSetupFlow({
        dataDir: where.dataDir,
        health: () => readHealth(where),
        steps: setupFlowSteps(options, { ...setupDeps(), askCore: askCoreAtTerminal }),
        ask: askAtTerminal,
      });
      if (outcome.status === 'ready') return runChat();
      die(
        `setup ${outcome.status} at ${outcome.at ?? 'the start'}${outcome.detail === '' ? '' : `: ${outcome.detail}`}`
      );
    }
  }
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
    die(`no core listens (${(err as NodeJS.ErrnoException).code ?? 'error'}); start it with neptunia services start`);
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
    history: terminal ? readHistory(historyFile).records.map((one) => one.text) : [],
    historySize: HISTORY_SIZE,
  });
  const answers = createAnswers({ rl: input, input: process.stdin, output, target: process.stdout });
  if (terminal) {
    input.on('history', (lines: Array<string>) => {
      // A secret answer is neither kept in the file nor in the list: it is taken out of both.
      if (answers.secretWaiting()) return;
      saveLines(historyFile, lines, Date.now());
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
      else if (parsed.name === 'logs' && typeof parsed.args.options === 'string' && followsJournal(parsed.args.options))
        track(followJournal(parsed.args.options, printBlock));
      else if (runsHere(parsed.name))
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

/** The longest the doctor waits for a core to answer `runtime`: a core that hangs is what the owner came to find. */
const RUNTIME_WAIT_MS = 5000;

/** The core's reading of the server, itself and the memory (the console's `doctor`), `skipped` when none answers in time. */
async function checkRuntime(ask: ((command: Command) => Promise<Answer>) | null): Promise<Check> {
  const skipped: Check = { name: 'runtime', status: 'skipped', detail: 'no core answers: its reads need it' };
  if (ask === null) return skipped;
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), RUNTIME_WAIT_MS);
  });
  try {
    const answer = await Promise.race([ask({ name: 'doctor', args: {} }), late]);
    if (answer === null) return skipped;
    return { name: 'runtime', status: answer.status === 'ok' ? 'ok' : 'fail', detail: answer.text };
  } finally {
    clearTimeout(timer);
  }
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

/** What a chat launch would find: `fail` with the repairs while it would not open. Reads with no model request. */
async function checkReadiness(where: { privateDir: string; dataDir: string }): Promise<Check> {
  const readiness = evaluateReadiness(await readHealth(where));
  return readiness.ready
    ? { name: 'readiness', status: 'ok', detail: 'a chat opens' }
    : { name: 'readiness', status: 'fail', detail: readinessText(readiness) };
}

/** Every check of the installation, then the core's reading of itself; with `live`, the providers probed through it instead. */
async function doctorChecks(
  where: { rootDir: string; privateDir: string; dataDir: string },
  { ask, live }: { ask: ((command: Command) => Promise<Answer>) | null; live: boolean }
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
  // `live` is the providers' own read; the plain doctor says whether a chat would open.
  if (!live) checks.push(await checkReadiness(where));
  checks.push(live ? await checkProviders(ask) : await checkRuntime(ask));
  return checks;
}

async function runDoctor(argv: ReadonlyArray<string>): Promise<void> {
  const json = argv.includes('--json');
  const live = argv.includes('--live') || argv.includes('live');
  if (argv.some((arg) => arg !== '--json' && arg !== '--live' && arg !== 'live')) usage();
  const where = paths();
  const link = await tryCliLink();
  const checks = await doctorChecks(where, { ask: link === null ? null : (command) => link.ask(command), live });
  link?.close();
  if (json) process.stdout.write(`${JSON.stringify({ checks })}\n`);
  else
    for (const check of checks)
      process.stdout.write(
        `${check.status.padEnd(7)}  ${check.name.padEnd(11)}  ${check.detail.replaceAll('\n', '; ')}\n`
      );
  return exitAfterFlush(checks.some((check) => check.status === 'fail') ? 1 : 0);
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

/** Who and where this process installs. */
function setupOptions({ system, node }: { system: boolean; node?: string }): SetupOptions {
  const where = paths();
  return {
    system,
    user: os.userInfo().username,
    group: groupName(),
    home: os.homedir(),
    rootDir: where.rootDir,
    privateDir: where.privateDir,
    dataDir: where.dataDir,
    node: nodeOf({ given: node, argv0: process.argv0, execPath: process.execPath, pathEnv: process.env.PATH }),
    ...(process.env.XDG_CONFIG_HOME ? { xdgConfigHome: process.env.XDG_CONFIG_HOME } : {}),
  };
}

/** What setup reaches from this process; the questions and the chat only at a terminal, where someone can answer. */
function setupDeps(): SetupDeps {
  const terminal = process.stdin.isTTY === true;
  return {
    run: spawnRun,
    openChat: (firstLine) => (terminal ? runChat(firstLine) : Promise.resolve()),
    report: printSetup,
    ...(terminal
      ? {
          ask: askAtTerminal,
          gh: spawnGh(process.env),
          install: installRun,
          hostEnv: process.env,
          installGh: () => installGhOfficially(spawnRun, process.getuid?.() === 0),
        }
      : {}),
  };
}

async function runSetupCommand(argv: ReadonlyArray<string>): Promise<void> {
  const retired = retiredSetupStep(argv);
  if (retired !== null) refuseSyntax(retired);
  let parsed: ReturnType<typeof parseSetupArgs>;
  try {
    parsed = parseSetupArgs(argv);
  } catch (err) {
    if (err instanceof SetupUsageError) refuseSyntax(err.message);
    throw err;
  }
  const report = await runSetup(setupOptions(parsed), setupDeps());
  process.exit(report.ok ? 0 : 1);
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

const [group, ...rest] = process.argv.slice(2);
const fault = (err: unknown): never => die(err instanceof Error ? err.message : String(err));
switch (group) {
  case undefined:
    // A chat over pipes is asked for by name: nobody may be writing to them, and Ink cannot draw on them.
    if ((process.stdin.isTTY !== true || process.stdout.isTTY !== true) && process.env.NEPTUNIA_PLAIN_CHAT !== '1')
      refuseSyntax(panelRefusal('the chat'));
    logToStderr();
    await launchChat().catch(fault);
    break;
  case '-p':
    logToStderr();
    await runPrint(rest).catch(fault);
    break;
  case 'doctor':
    logToStderr();
    if (rest[0] === 'server' || rest[0] === 'core' || rest[0] === 'memory')
      await runDirect([group, ...rest]).catch(fault);
    else await runDoctor(rest).catch(fault);
    break;
  case 'errand-runner':
    await runErrandRunner(rest).catch(fault);
    break;
  case 'services':
    runUnitVerbs(rest, refuseSyntax);
    logToStderr();
    await runDirect([group, ...rest]).catch(fault);
    break;
  case 'setup':
    await runSetupCommand(rest).catch(fault);
    break;
  case 'interface':
    // `interface run` is the runner a unit starts; the table refuses the other forms and names `interfaces`.
    if (rest[0] === 'run') {
      await runInterface(rest).catch(fault);
    } else {
      logToStderr();
      await runDirect([group, ...rest]).catch(fault);
    }
    break;
  case 'tasks':
    await exitAfterFlush(await runTask(rest).catch(fault));
    break;
  case 'worker':
    if (rest[0] === 'development' && (rest.length === 1 || (rest.length === 2 && rest[1] === 'held')))
      await exitAfterFlush(await runDevelopment(rest.slice(1)).catch(fault));
    if (rest.length !== 1 || rest[0] !== 'watcher') usage();
    await exitAfterFlush(await runWatcherWorker(paths()).catch(fault));
    break;
  default:
    logToStderr();
    await runDirect([group, ...rest]).catch(fault);
}
