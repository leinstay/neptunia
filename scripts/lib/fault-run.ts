// The effect ledger and the live-core rig of the fault run of `scripts/harness.ts faults` (tests/scripts/lib/fault-run.test.ts).
//
// `createLedger` counts every side effect by its effect key. A key names one thing that must happen once, whatever the
// number of events, retries, restarts and reconnects around it: `send:<chat>:<text>` for a message the persona posts,
// `react:<chat>/<message>/<emoji>` for a reaction, `wake:<id>` for a wake that ran, `delivery:<key>` for the
// post a completed wake left, `board:<title>` for a task on the board, `failed:send:<chat>:<text>` for a send the
// interface refused, which posted nothing. A run passes when no key repeats and each
// expected key happened once. `edit:<chat>:<text>` counts an edit of theirs, `ack:<step>:<status>` the core's answer to
// one event of the door scenario and `ingest:<event id>` an event the core committed. The scenarios that read the
// memory database count what they read: `turn:<step>:<outcome>` a turn's end, `requests:<step>:<count>` the requests
// that reached the provider by then, `rows:<table>:<count>` a table's rows, `intention:<fields>` a stored intention,
// `line:<fields>` a stored line and `shown:<text>:<yes|no>` whether their latest request carries a text. The errand
// scenarios count `agent:<goal>` for a run the fake agent got, `board:<fields>` for the board's rows and
// `lease:<name>:<token>` for a lease. The mirror scenario counts `publication:<fields>` for a diary entry's publication
// to one mirror, and the command-line scenario `command:<words>:<status>:<text>` for the answer of an owner's
// command. The Discord scenario counts the calls that reached its fake platform, a page of history read as
// `platform:read:<chat>:<query>`, and the terminal scenario `printed:<text>` for a line of the persona's that the
// command line printed and `screen:<row>` for a row of the chat's last frame. The video scenario counts `tool:<run>`
// for a run of a stand-in of yt-dlp or ffmpeg and `watch:<clip>` for a video request, and the web scenario
// `result:<step>:<text>` for what a tool call gave the model. The ledger also lists every key in the order it happened,
// which a scenario whose effects have an order records. `observe` hangs the ledger on a fake adapter, so every call
// that reaches the interface is counted at the place a platform would see it, below the link's
// own dedupe by idempotency key. A send or an edit the adapter refuses is counted as `failed`.
//
// `withLiveCore` starts the real core (`startCore`, src/core.ts) over temporary folders in the layout of a deployment
// (`config.local/config.json`), a scripted model and a fake interface over one fake adapter that survives a restart of
// the core. The model never sees a provider: `scripted` answers each request from the directive `do:<verb>:<word>` in
// its newest line, so a message in the chat is the script of what the persona does about it. Nothing here reads a real
// `data/`, `.env` or local layer, and no key leaves the process.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startCore } from '../../src/core.ts';
import { createRunnerServer } from '../../src/agent-runner/server.ts';
import type { RunnerTask, RunOutcome } from '../../src/agent-runner/protocol.ts';
import { readConfig } from '../../src/config.ts';
import { createLlm } from '../../src/llm/openrouter.ts';
import { createCalibrator } from '../../src/llm/tokens.ts';
import { DEFAULT_CAPACITY } from '../../src/interface/door.ts';
import { createFakeAdapter } from './fake.ts';
import { openMemoryDb } from '../../src/memory/db/open.ts';
import { createMemoryDb } from '../../src/memory/db/service.ts';
import { insertRows } from '../../src/memory/db/rows.ts';
import { channelPlaceId } from '../../src/memory/db/ids.ts';
import { createMirrors } from '../../src/behavior/mirror.ts';
import { start as startFake } from './fake-interface.ts';
import type { FakeInterface } from './fake-interface.ts';
import { start as startCli } from '../../interfaces/cli/link.ts';
import type { CliHost, RunningCli } from '../../interfaces/cli/link.ts';
import { runInteractive } from '../../interfaces/cli/index.ts';
import type { ChatEntry, ChatEnv } from '../../interfaces/cli/index.ts';
import { parseCommandLine, parseCommandWords } from '../../src/interface/commands/table.ts';
import { coreSocketPath } from '../../src/interface/socket.ts';
import { MAX_FRAME_BYTES, connectSocket } from '../../src/protocol/wire.ts';
import type { ChatInfo, MessageEvent } from '../../src/protocol/adapter.ts';
import type { InterfaceHost, RunningInterface } from '../../src/protocol/host.ts';
import { apiNameOf } from '../../src/tools/definitions.ts';
import { videoUrlCacheKey } from '../../src/media/video-sites.ts';
import { createPageFetcher } from '../../src/web/fetch-page.ts';
import type { PageFetcher } from '../../src/web/fetch-page.ts';
import { dbOf } from '../../src/memory/db/types.ts';
import { quietLog } from './turn-wiring.ts';
import { errandDoneEvent } from '../../src/errands/turns.ts';
import type { ErrandRecord } from '../../src/errands/types.ts';
import { deliveryOf } from '../../src/protocol/adapter.ts';
import { effectsLookup, loadFixtures, weekOf } from './inner-week.ts';
import { createFakeDiscord, createFakeTerminal, createFakeVideoSite } from './fault-platforms.ts';
import { start as startDiscord } from '../../interfaces/discord/session.ts';

/** Where an effect shows: the kinds the ledger counts. */
type EffectKind =
  | 'send'
  | 'edit'
  | 'react'
  | 'wake'
  | 'delivery'
  | 'board'
  | 'errand'
  | 'failed'
  | 'ack'
  | 'ingest'
  | 'turn'
  | 'requests'
  | 'rows'
  | 'intention'
  | 'line'
  | 'shown'
  | 'agent'
  | 'lease'
  | 'publication'
  | 'command'
  | 'platform'
  | 'printed'
  | 'screen'
  | 'tool'
  | 'watch'
  | 'result';

/** The count of every effect key seen, and what is wrong with it. */
export type Ledger = {
  /** One effect happened under `key` of `kind`. */
  record(kind: EffectKind, key: string): void;
  /** Every key with how many times it happened, oldest first. */
  counts(): ReadonlyMap<string, number>;
  /** The keys that happened more than once, with their counts. */
  repeats(): Array<[string, number]>;
  /** The keys of `expected` that did not happen exactly once. */
  missing(expected: ReadonlyArray<string>): Array<string>;
  /** Every key in the order it happened, each repeat included. */
  order(): Array<string>;
};

export function createLedger(): Ledger {
  const seen = new Map<string, number>();
  const sequence: Array<string> = [];
  return {
    record(kind, key) {
      seen.set(`${kind}:${key}`, (seen.get(`${kind}:${key}`) ?? 0) + 1);
      sequence.push(`${kind}:${key}`);
    },
    counts: () => seen,
    repeats: () => [...seen].filter(([, count]) => count > 1),
    missing: (expected) => expected.filter((key) => seen.get(key) !== 1),
    order: () => [...sequence],
  };
}

type Adapter = ReturnType<typeof createFakeAdapter>;

/**
 * Counts what reaches `adapter`: each send under `send:<chat>:<text>`, with ` [files: <n>]` when it carries files, each
 * edit under `edit:<chat>:<text>`, and each reaction under its message. A send or an edit the adapter refuses is counted
 * under `failed:` with the same key. The adapter keeps working as before.
 */
export function observe(adapter: Adapter, ledger: Ledger): void {
  const send = adapter.send.bind(adapter);
  adapter.send = async (chat, content, options) => {
    const files = content.attachments?.length ?? 0;
    const key = `${chat.chatId}:${content.text ?? ''}${files > 0 ? ` [files: ${files}]` : ''}`;
    const delivery = await send(chat, content, options);
    if (delivery.status === 'failed') ledger.record('failed', `send:${key}`);
    else ledger.record('send', key);
    return delivery;
  };
  const edit = adapter.edit.bind(adapter);
  adapter.edit = async (ref, content) => {
    const key = `${ref.chatId}:${content.text ?? ''}`;
    const result = await edit(ref, content);
    if (result.status === 'ok') ledger.record('edit', key);
    else ledger.record('failed', `edit:${key}`);
    return result;
  };
  const react = adapter.react.bind(adapter);
  adapter.react = (ref, emoji) => {
    ledger.record('react', `${ref.chatId}/${ref.messageId}/${emoji}`);
    return react(ref, emoji);
  };
}

// ---- the live core ------------------------------------------------------------------------------------------------

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SELF = { id: 'self-id', name: 'Nova' };
const SERVED_ROOT = { id: 'g1', name: 'Alpha' };
/** The member who writes in the chats of the run. */
const MEMBER = { id: 'u1', name: 'Eleni' };
/** The chat of the run. */
const ROOM = 'c1';
/** The second chat, where an errand's result is an interjection. */
const OTHER_ROOM = 'c2';

type Settings = Record<string, unknown>;

type ToolCall = { id: null; name: string; arguments: string; parsed: Record<string, unknown>; parseError: null };

/** A tool call of the model: the dotted skill name with its arguments, as the native transport hands it over. */
function toolCall(name: string, args: Record<string, unknown>): ToolCall {
  return { id: null, name: apiNameOf(name) ?? name, arguments: JSON.stringify(args), parsed: args, parseError: null };
}

/** What the scripted model answers: a speech-only text, or text with tool calls. */
type Answer = string | { text: string; toolCalls: Array<ToolCall> };

/** What a message or a wake asks of the persona: `do:<verb>:<word>`. */
type Directive = { verb: string; word: string; line: number | null };

/**
 * One request the model got: its text, how many came before it, its purpose, and the directive it carries. A request
 * carries one when it is the first step of a turn (no tool result yet, no reminder of an open intention) and the line
 * that woke the persona names one: the newest chat line, or the intention a wake says is due.
 */
type ModelRequest = { text: string; count: number; directive: Directive | null; purpose: string | null };

/** The directive `do:<verb>:<word>` in `line`, else null. */
function directiveIn(line: string, number: number | null): Directive | null {
  const found = /do:([a-z]+):([\w-]+)/.exec(line);
  return found?.[1] === undefined || found[2] === undefined ? null : { verb: found[1], word: found[2], line: number };
}

/** The directive of a request's text (the JSON of its messages), see ModelRequest. */
export function directiveOf(json: string, afterTools: boolean): Directive | null {
  const text = json.replaceAll('\\n', '\n');
  if (afterTools || text.includes('that you have not changed yet')) return null;
  const woke = /is due: (.*)/.exec(text)?.[1];
  if (woke !== undefined) return directiveIn(woke, null);
  const chat = [...text.matchAll(/^#(\d+) \[[^\]\n]*\] [^:\n]*: (.*)$/gm)].at(-1);
  return chat?.[1] === undefined || chat[2] === undefined ? null : directiveIn(chat[2], Number(chat[1]));
}

/** A chat as the fake reports it: a public channel the persona may read, post in and react in. */
function chatInfo(id: string): ChatInfo {
  return {
    id,
    kind: 'channel',
    rootId: SERVED_ROOT.id,
    name: `room-${id}`,
    topic: null,
    iface: 'fake',
    permissions: { read: true, send: true, attach: true, react: true },
    owner: null,
    lastMessageAt: null,
    voice: false,
    public: true,
    audience: {
      everyone: true,
      groups: [],
      groupAllow: [],
      groupDeny: [],
      memberAllow: [],
      memberDeny: [],
      memberGroups: {},
    },
  };
}

/**
 * A member's message in `ROOM`, or in the chat `chat`, as an interface delivers it: new, or `edit`ed, or `deleted`.
 * With `picture` it is the persona's own message carrying that one file, as the platform echoes a post of theirs.
 */
function messageEvent(
  id: string,
  text: string,
  at: number,
  how: {
    mention?: boolean;
    edit?: boolean;
    deleted?: boolean;
    picture?: object;
    chat?: string;
    links?: Array<object>;
  } = {}
): MessageEvent {
  const mention = how.mention !== false && how.picture === undefined;
  const chat = how.chat ?? ROOM;
  return {
    kind: 'message.received',
    iface: 'fake',
    at,
    id: `fake:message:${id}${how.edit === true ? `:edit:${at}` : how.deleted === true ? ':deleted' : ''}`,
    chat: { id: chat, kind: 'channel', rootId: SERVED_ROOT.id, name: `room-${chat}` },
    ...(how.edit === true ? { edit: true } : {}),
    ...(how.deleted === true ? { deleted: true } : {}),
    message: {
      id,
      author:
        how.picture === undefined
          ? { id: 'u1', name: 'Eleni', self: false, bot: false }
          : { id: SELF.id, name: SELF.name, self: true, bot: true },
      content: text,
      sourceText: text,
      system: false,
      at,
      replyToId: null,
      replyPingAccountId: null,
      forwardedFrom: null,
      attachments: how.picture === undefined ? [] : [how.picture],
      links: how.links ?? [],
      forwarded: [],
      stickers: [],
      emojis: [],
      reactions: [],
    },
    addressing: {
      mentioned: mention,
      replyToSelf: false,
      mentionedAccountIds: mention ? [SELF.id] : [],
      mentionedChatIds: [],
    },
  };
}

const BASE_CONFIG: Settings = {
  bot: { timezone: 'UTC', owners: [], placeId: SERVED_ROOT.id },
  // No video role, so the start sends no canary probe to YouTube.
  models: { base: { video: false } },
  pace: { settleMs: 0, settleMaxMs: 0 },
  typing: { reactionDelayMs: [0, 0], betweenMessagesMs: [0, 0], minMs: 0, maxMs: 0 },
  gifs: { backfillMessages: 0 },
};

const isRecord = (value: unknown): value is Settings =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

function merged(base: Settings, extra: Settings): Settings {
  const out: Settings = { ...base };
  for (const [key, value] of Object.entries(extra)) {
    const old = out[key];
    out[key] = isRecord(old) && isRecord(value) ? merged(old, value) : value;
  }
  return out;
}

/** The access grant of a tool to the persona's own account. */
const grantOf = (name: string): [string, Settings] => [name, { everyone: false, roles: [], users: [SELF.id] }];

type LiveOptions = {
  /** Settings of the private layer, merged over the base. */
  config?: Settings;
  /** The model: what it answers to each request. */
  scripted: (request: ModelRequest) => Answer | Promise<Answer>;
  /** The ledger the interface's calls are counted in; a fresh one when absent. */
  ledger?: Ledger;
  /** The limits of a message the fake adapter offers, over its defaults. */
  capabilities?: { maxChars: number; maxFiles: number };
  /**
   * Whether the requests go through the real provider client (src/llm/openrouter.ts) with its rails, over a fake
   * `fetch` that answers in the provider's format. Without it the scripted model stands in for the client.
   */
  client?: boolean;
  /**
   * The agent of the unit `code`: what a run of an errand comes back with. With it the real runner server
   * (src/agent-runner/server.ts) listens on the unit's socket under the run's folders, with this function as its engine
   * in place of a harness, and survives a restart of the core.
   */
  agent?: (task: RunnerTask) => Promise<RunOutcome>;
  /**
   * Whether the owner's command line runs beside the fake interface: the real `cli` interface (interfaces/cli/link.ts)
   * over the core's socket under a `cli` client of the private layer's `clients.json`, so `ask` reaches the core's
   * command desk as `neptunia <words>` does. The core starts one interface in its process, the fake one.
   */
  commands?: boolean;
  /**
   * The interface the core starts in place of the fake one, as `src/index.ts` starts an interface package in its
   * process. The fake adapter then stays unconnected, and `deliver` and `iface` have nothing to reach.
   */
  platform?: { name: string; start(host: InterfaceHost): Promise<RunningInterface> };
  /**
   * The provider's answer to a request body of the real client (`client`), in the provider's format, or null for the
   * scripted answer.
   */
  provider?: (body: { messages: unknown; plugins?: unknown }) => object | null;
  /** The fetcher of the pages `web.read` reads, in place of the one that goes to the network. */
  pageFetcher?: PageFetcher;
};

type Door = Awaited<ReturnType<typeof startCore>>['door'];

type Live = {
  ledger: Ledger;
  adapter: Adapter;
  /** The running interface of the current start of the core. */
  iface(): FakeInterface;
  /** The persona's texts in `ROOM`, in the order they were posted. */
  posted(): Array<string>;
  /** The text of every model request so far. */
  requests: Array<string>;
  /** How many requests reached the provider's fake `fetch` so far, the address classifier's included. */
  sent(): number;
  /** Puts the message in the chat and emits its event: the core's ack status. */
  deliver(event: MessageEvent): Promise<string>;
  /** The event door of the running core. */
  door(): Door;
  /** Hands the core's event door the end of `errand`, as the errand service does when an agent finishes. */
  finish(errand: ErrandRecord): Promise<unknown>;
  /** The rows a query of the memory database returns, read through a second, read-only connection. */
  rows(sql: string): Array<Record<string, unknown>>;
  /** Stops the core and starts a new one over the same folders and the same chat. */
  restart(): Promise<void>;
  /** The owner's command `words` through the command line, as `neptunia <words>` sends it: its answer. */
  ask(words: ReadonlyArray<string>): Promise<{ text: string; status: string; code?: string }>;
  /** A command line of its own over the core's socket, as the owner's chat opens one; closed when the run ends. */
  openLine(chat: Pick<CliHost, 'print'>): Promise<RunningCli>;
};

/** Waits until `check` holds, or throws after `ms`. */
async function until(check: () => boolean, what: string, ms = 8000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}

/** Waits until `check` holds or `ms` pass, whichever comes first: what the scenario then reads is what it records. */
async function settled(check: () => boolean, ms = 8000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check() && Date.now() <= deadline) await new Promise((resolve) => setTimeout(resolve, 15));
}

/** The real core over a scripted model and one fake adapter, in temporary folders removed when `body` ends. */
async function withLiveCore<T>(options: LiveOptions, body: (live: Live) => Promise<T>): Promise<T> {
  // Short folders: a Unix socket path is limited to 108 bytes.
  const root = mkdtempSync(join(tmpdir(), 'fr-'));
  const dataDir = join(root, 'd');
  const privateDir = dataDir;
  mkdirSync(join(privateDir, 'config'), { recursive: true });
  writeFileSync(join(privateDir, 'config', 'config.json'), JSON.stringify(merged(BASE_CONFIG, options.config ?? {})));
  const ledger = options.ledger ?? createLedger();
  // The units' sockets as a user unit finds them (src/agent-runner/profiles.ts#unitPaths), under the run's folders.
  const unitEnv = { NEPTUNIA_UNIT_SCOPE: 'user', XDG_RUNTIME_DIR: join(root, 'r'), XDG_STATE_HOME: join(root, 's') };
  const runner =
    options.agent === undefined
      ? null
      : createRunnerServer({
          unit: 'code',
          runner: { run: options.agent },
          socketPath: join(root, 'r', 'neptunia-agent-code', 'sock'),
        });
  if (runner !== null) {
    mkdirSync(join(root, 'r', 'neptunia-agent-code'), { recursive: true });
    await runner.start();
  }
  const adapter = createFakeAdapter({ selfId: SELF.id, capabilities: options.capabilities ?? {} });
  adapter.seedChat(chatInfo(ROOM));
  observe(adapter, ledger);
  const requests: Array<string> = [];
  /** What the model answers to `messages`, a request of `purpose`. */
  const answer = async (
    messages: unknown,
    purpose: unknown
  ): Promise<{ text: string; toolCalls?: Array<ToolCall> }> => {
    // The door asks the address classifier about every flagged line first: a call to the persona, so `yes`, never scripted, in
    // the JSON object the classifier asks for (src/behavior/mention.ts#parseAddressAnswer).
    if (purpose === 'address') return { text: '{"answer":"yes"}' };
    const text = JSON.stringify(messages);
    const afterTools = Array.isArray(messages) && messages.some((one) => isRecord(one) && one.role === 'tool');
    requests.push(text);
    const given = await options.scripted({
      text,
      count: requests.length,
      directive: directiveOf(text, afterTools),
      purpose: typeof purpose === 'string' ? purpose : null,
    });
    return typeof given === 'string' ? { text: given } : given;
  };
  let fetched = 0;
  /** The provider's chat completion endpoint, answered by `answer`; the classifier's request names its schema. */
  const providerFetch = async (input: unknown, init?: { body?: unknown }): Promise<Response> => {
    if (!String(input).endsWith('/chat/completions')) throw new Error(`fault-run: no fake for ${String(input)}`);
    fetched += 1;
    const body = JSON.parse(String(init?.body)) as {
      messages: unknown;
      plugins?: unknown;
      response_format?: { json_schema?: { name?: unknown } };
    };
    const given = options.provider?.(body) ?? null;
    if (given !== null) return new Response(JSON.stringify(given), { status: 200 });
    const schema = body.response_format?.json_schema;
    const said = await answer(body.messages, schema?.name);
    const toolCalls = (said.toolCalls ?? []).map((call, index) => ({
      id: `call-${index}`,
      type: 'function',
      function: { name: call.name, arguments: call.arguments },
    }));
    const message = {
      role: 'assistant',
      content: said.text,
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    };
    const usage = { prompt_tokens: 10, completion_tokens: 10 };
    return new Response(JSON.stringify({ choices: [{ message, finish_reason: 'stop' }], usage }), { status: 200 });
  };
  const llm =
    options.client === true
      ? createLlm({
          apiKey: 'test-key',
          getConfig: () => readConfig(ROOT, { privateDir }) as ReturnType<Parameters<typeof createLlm>[0]['getConfig']>,
          calibrator: createCalibrator(),
          state: { data: {}, markDirty: () => {} },
          fetchImpl: providerFetch,
        })
      : {
          complete: async (
            messages: unknown,
            given?: unknown
          ): Promise<{
            text: string;
            toolCalls?: Array<unknown>;
            usage: object;
            estimated: number;
            finishReason?: string;
          }> => {
            const purpose = (given as { purpose?: unknown } | undefined)?.purpose;
            const said = await answer(messages, purpose);
            return said.toolCalls === undefined
              ? { text: said.text, usage: {}, estimated: purpose === 'address' ? 1 : 10 }
              : { text: said.text, toolCalls: said.toolCalls, usage: {}, estimated: 10, finishReason: 'stop' };
          },
        };
  let running: FakeInterface | null = null;
  // Held in an object: the closures below set it, and a plain `let` would read as never set where the run ends.
  const line: { cli: RunningCli | null; chats: Array<RunningCli> } = { cli: null, chats: [] };
  // The owner's command line as a client of the private layer (src/interface/principals.ts), its token synthetic.
  const cliToken = 'fault-run-cli-token';
  if (options.commands === true) {
    mkdirSync(join(privateDir, 'clients'), { recursive: true });
    writeFileSync(join(privateDir, 'clients', 'cli.token'), cliToken, { mode: 0o600 });
    const clients = { cli: { kind: 'cli', tokenFile: 'clients/cli.token', permissions: [] } };
    writeFileSync(join(privateDir, 'clients.json'), JSON.stringify(clients));
  }
  const started: { core: Awaited<ReturnType<typeof startCore>> | null } = { core: null };
  const boot = async (): Promise<void> => {
    started.core = await startCore({
      paths: { rootDir: ROOT, privateDir, dataDir },
      env: { OPENROUTER_CORE_KEY: 'test-key', ...unitEnv },
      interfaces: [
        options.platform ?? {
          name: 'fake',
          start: async (host) => {
            running = await startFake(host, { adapter, self: SELF, root: SERVED_ROOT });
            return running;
          },
        },
      ],
      llm,
      embedder: { embed: () => Promise.resolve([]) },
      ...(options.pageFetcher === undefined ? {} : { pageFetcher: options.pageFetcher }),
    });
  };
  await boot();
  const live: Live = {
    ledger,
    adapter,
    iface() {
      if (running === null) throw new Error('the core never started the fake interface');
      return running;
    },
    posted: () =>
      adapter
        .messagesIn(ROOM)
        .filter((message) => message.authorId === SELF.id)
        .map((message) => message.text),
    requests,
    sent: () => fetched,
    deliver(event) {
      adapter.seedEvent(event);
      return live.iface().emit(event);
    },
    door() {
      const { core } = started;
      if (core === null) throw new Error('the core never started');
      return core.door;
    },
    finish(errand) {
      return live.door().submit({ ...errandDoneEvent(errand), id: `errand-done:${errand.id}` });
    },
    rows(sql) {
      const handle = openMemoryDb(join(dataDir, 'memory.db'), { readOnly: true });
      try {
        const db = handle.db as { prepare(text: string): { all(): Array<Record<string, unknown>> } };
        return db
          .prepare(sql)
          .all()
          .map((row) => ({ ...row }));
      } finally {
        handle.close();
      }
    },
    async restart() {
      line.cli?.close();
      line.cli = null;
      await started.core?.stop();
      await boot();
    },
    async ask(words) {
      const parsed = parseCommandWords(words);
      if (!parsed.ok) throw new Error(`fault-run: the command ${words.join(' ')} does not parse`);
      if (options.commands !== true) throw new Error('fault-run: the command line runs only with the option commands');
      line.cli ??= await startCli({
        connect: () => connectSocket({ path: coreSocketPath(dataDir), maxFrameBytes: MAX_FRAME_BYTES }),
        token: cliToken,
        print: null,
      });
      return line.cli.ask({ name: parsed.name, args: parsed.args });
    },
    async openLine(chat) {
      if (options.commands !== true) throw new Error('fault-run: the command line runs only with the option commands');
      const opened = await startCli({
        connect: () => connectSocket({ path: coreSocketPath(dataDir), maxFrameBytes: MAX_FRAME_BYTES }),
        token: cliToken,
        ...chat,
      });
      line.chats.push(opened);
      return opened;
    },
  };
  try {
    return await body(live);
  } finally {
    line.cli?.close();
    for (const chat of line.chats) chat.close();
    await started.core?.stop();
    await runner?.stop();
    rmSync(root, { recursive: true, force: true });
  }
}

// ---- the scenarios of the live core -------------------------------------------------------------------------------

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

type Latch = { promise: Promise<void>; open(): void };

/** A promise another part of the run settles. */
function latch(): Latch {
  const gate = Promise.withResolvers<void>();
  return { promise: gate.promise, open: () => gate.resolve() };
}

/** How long a skill call may run in the live rig before its outcome is `unknown` (ms). */
const CALL_TIMEOUT_MS = 150;
/** How long the fake interface sits on a reaction, so that a call times out under it (ms). */
const SLOW_REACT_MS = 600;

/** A finished errand of the agent `code`, asked in `chatId` by the message `messageId`, its result naming `word`. */
function finishedErrand(id: string, chatId: string, messageId: string | null, word: string): ErrandRecord {
  const at = Date.now();
  return {
    id,
    agent: 'code',
    goal: `look into ${word}`,
    requester: { accountId: 'u1', kind: 'member' },
    origin: { placeId: chatId, messageId },
    scope: 'group',
    state: 'done',
    createdAt: at,
    startedAt: at,
    endedAt: at,
    usage: null,
    result: { text: `errand-done:${word}`, sources: [], files: [] },
    error: null,
    seen: false,
    readAt: null,
    resolvedAt: null,
    opId: `op-${id}`,
  };
}

/** The interface's refusal of a send: `retryable` says whether the platform asks to try again. */
function refusedSend(retryable: boolean): ReturnType<typeof deliveryOf> {
  const error = { code: retryable ? 'rate-limited' : 'send-failed', retryable, retryAfterMs: retryable ? 50 : null };
  return deliveryOf([{ status: 'failed', error }], 'fault-run-refused');
}

/**
 * The scenarios of one round over one live core. Each message carries a directive the scripted model follows:
 * `do:say:<word>` answers with that word, `do:react:<word>` reacts to the message, `do:hold:<word>` waits for the
 * latch of that word and then answers, `do:two:<word>` answers with two messages. A request that carries an errand's
 * result `errand-done:<word>` answers `said <word>`. Words are unique per round, so a key never meets another round's.
 * Counts into `ledger` and returns the keys that must have happened once.
 */
async function liveRound(round: number, ledger: Ledger, repeats: number): Promise<Array<string>> {
  const word = (name: string): string => `r${round}-${name}`;
  const gates = new Map<string, Latch>();
  const gateOf = (name: string): Latch => {
    const found = gates.get(name) ?? latch();
    gates.set(name, found);
    return found;
  };
  const reached = (name: string): Latch => gateOf(`reached-${name}`);
  const said = (name: string): string => `send:${ROOM}:said ${word(name)}`;
  const expected: Array<string> = [];
  await withLiveCore(
    {
      ledger,
      config: {
        bot: { access: Object.fromEntries(['message.create'].map(grantOf)) },
        tools: { callTimeoutMs: CALL_TIMEOUT_MS },
      },
      scripted: async ({ text, directive }) => {
        const finished = /errand-done:([\w-]+)/.exec(text)?.[1];
        if (finished !== undefined) return `<msg>said ${finished}</msg>`;
        if (directive === null) return '<skip/>';
        if (directive.verb === 'two') return `<msg>first ${directive.word}</msg><msg>second ${directive.word}</msg>`;
        if (directive.verb === 'hold') {
          reached(directive.word).open();
          await gateOf(directive.word).promise;
        }
        if (directive.verb === 'react') {
          return {
            text: '',
            toolCalls: [toolCall('message.react.add', { message: `#${directive.line ?? 1}`, emoji: '👍' })],
          };
        }
        return `<msg>said ${directive.word}</msg>`;
      },
    },
    async (live) => {
      const answered = (name: string): Promise<void> =>
        until(() => live.posted().includes(`said ${word(name)}`), `the answer ${word(name)}`);

      // Repeated events: one event id many times at once and one after another, then again after a reconnect.
      const first = messageEvent('m1', `do:say:${word('one')}`, Date.now());
      await Promise.all(Array.from({ length: repeats }, () => live.deliver(first)));
      await answered('one');
      for (let again = 0; again < repeats; again += 1) await live.deliver(first);
      await live.iface().reconnect();
      await live.deliver(first);
      expected.push(said('one'));

      // An event emitted while the link is down arrives once after the reconnect, as history: the no-catch-up
      // policy starts no turn over a backlog, so nothing is said.
      await live.iface().drop();
      const waiting = live.deliver(messageEvent('m2', `do:say:${word('two')}`, Date.now()));
      await sleep(80);
      await live.iface().reconnect();
      await waiting;

      // Conflicting corrections: an edit and a delete of the message reach the core while its turn waits on the model.
      await live.deliver(messageEvent('m3', `do:hold:${word('three')}`, Date.now()));
      await reached(word('three')).promise;
      await live.deliver(messageEvent('m3', `do:say:${word('three')}-fixed`, Date.now(), { edit: true }));
      await live.deliver(messageEvent('m3', '', Date.now(), { deleted: true }));
      gateOf(word('three')).open();
      await answered('three');
      expected.push(said('three'));

      // A turn cut off mid-call: the persona's reaction takes longer than the call may, so the turn goes on without its result
      // while the reaction still lands. It lands once, and the turn does not make it again.
      const { adapter } = live;
      const react = adapter.react.bind(adapter);
      adapter.react = async (ref, emoji) => {
        await sleep(SLOW_REACT_MS);
        return react(ref, emoji);
      };
      await live.deliver(messageEvent('m4', `do:react:${word('four')}`, Date.now()));
      await until(() => adapter.calls.some((call) => call.op === 'react'), 'the reaction');
      await sleep(SLOW_REACT_MS + 400);
      expected.push(`react:${ROOM}/m4/👍`);
      adapter.react = react;

      // Refused sends, wrapped outside the ledger's count, so a refusal is a `failed` effect and posts nothing: the
      // second message of a turn refused after the first went out, and a send the platform refuses as retryable.
      const send = adapter.send.bind(adapter);
      const refusals = new Map([
        [`second ${word('six')}`, false],
        [`said ${word('seven')}`, true],
      ]);
      adapter.send = (chat, content, options) => {
        const retryable = refusals.get(content.text ?? '');
        if (retryable === undefined) return send(chat, content, options);
        ledger.record('failed', `send:${chat.chatId}:${content.text ?? ''}`);
        return Promise.resolve(refusedSend(retryable));
      };
      await live.deliver(messageEvent('m6', `do:two:${word('six')}`, Date.now()));
      await until(() => live.posted().includes(`first ${word('six')}`), `the first part ${word('six')}`);
      await live.deliver(messageEvent('m7', `do:say:${word('seven')}`, Date.now()));
      await until(() => ledger.counts().has(`failed:send:${ROOM}:said ${word('seven')}`), 'the refused send');
      await sleep(300);
      adapter.send = send;
      expected.push(
        `send:${ROOM}:first ${word('six')}`,
        `failed:send:${ROOM}:second ${word('six')}`,
        `failed:send:${ROOM}:said ${word('seven')}`
      );

      // An errand's result: a reply to the message that asked for it, and an interjection in a second chat where the
      // asking message is gone.
      adapter.seedEvent(messageEvent('m8', `asks ${word('eight')}`, Date.now()));
      await live.finish(finishedErrand(word('eight'), ROOM, 'm8', word('eight')));
      await answered('eight');
      adapter.seedChat(chatInfo(OTHER_ROOM));
      await live.finish(finishedErrand(word('nine'), OTHER_ROOM, 'gone', word('nine')));
      await until(
        () => adapter.messagesIn(OTHER_ROOM).some((message) => message.text === `said ${word('nine')}`),
        `the interjection ${word('nine')}`
      );
      expected.push(said('eight'), `send:${OTHER_ROOM}:said ${word('nine')}`);

      // The core stopped while a turn waits on the model: the stopped core posts nothing, and the new one at most one
      // answer. A message acknowledged before the stop is not owed an answer after it, so none is expected.
      await live.deliver(messageEvent('m5', `do:hold:${word('five')}`, Date.now()));
      await reached(word('five')).promise;
      await live.restart();
      gateOf(word('five')).open();
      await sleep(300);
    }
  );
  return expected;
}

// ---- the edge scenarios ------------------------------------------------------------------------------------------

/**
 * The adapter's limits in the message-limit scenario: a short text keeps the scenario's sends small, and one file is
 * the most a post of the persona carries (message.create takes one attachment).
 */
const EDGE_LIMITS = { maxChars: 40, maxFiles: 1 };
/** One pixel of PNG, as a data address the persona's re-post downloads with no network. */
const PIXEL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

/** `text` filled with dots to exactly the adapter's `maxChars` code points. */
const atLimit = (text: string): string => text.padEnd(EDGE_LIMITS.maxChars, '.');

/**
 * The adapter's limits, met exactly, over an adapter that offers `EDGE_LIMITS`: the persona answers with a text of `maxChars`,
 * edits it to another text of `maxChars`, and posts again a picture of theirs, one file being `maxFiles`. Each is posted;
 * a refusal shows as a `failed` key. Returns the keys that must have happened once.
 */
async function limitsEdge(ledger: Ledger): Promise<Array<string>> {
  const picture = { id: 'edge-file', name: 'pixel.png', url: PIXEL, contentType: 'image/png', size: 68 };
  await withLiveCore(
    {
      ledger,
      capabilities: EDGE_LIMITS,
      config: { bot: { access: Object.fromEntries(['message.create', 'message.edit'].map(grantOf)) } },
      scripted: ({ directive }) => {
        if (directive === null) return '<skip/>';
        // The persona's line is the one just before the message that asks.
        const personaLine = `#${(directive.line ?? 2) - 1}`;
        if (directive.verb === 'edit') {
          return {
            text: '',
            toolCalls: [toolCall('message.edit', { message: personaLine, text: atLimit('fixed edge') })],
          };
        }
        if (directive.verb === 'repost') {
          return { text: '', toolCalls: [toolCall('message.create', { text: 'again edge', media: personaLine })] };
        }
        return `<msg>${atLimit('said edge')}</msg>`;
      },
    },
    async (live) => {
      const { adapter } = live;
      await live.deliver(messageEvent('edge-m1', 'do:say:edge-long', Date.now()));
      await until(() => live.posted().includes(atLimit('said edge')), 'the answer at the limit');
      await live.deliver(messageEvent('edge-m2', 'do:edit:edge-long', Date.now()));
      await until(() => adapter.calls.some((call) => call.op === 'edit'), 'the edit at the limit');
      await live.deliver(messageEvent('edge-m3', '', Date.now(), { picture }));
      await live.deliver(messageEvent('edge-m4', 'do:repost:edge-file', Date.now()));
      await until(() => adapter.calls.filter((call) => call.op === 'send').length >= 2, 'the post of one file');
      await sleep(300);
    }
  );
  return [
    `send:${ROOM}:${atLimit('said edge')}`,
    `edit:${ROOM}:${atLimit('fixed edge')}`,
    `send:${ROOM}:again edge [files: 1]`,
  ];
}

/**
 * Three events emitted while the link is down wait in the fake interface's outbox. The core restarts, the interface
 * opens its outbox again from its folder and replays them, and the core commits them in that order: the ledger counts
 * each as `ingest:<event id>` in the order of the ingestion record, and the row keeps that order. Returns the keys
 * that must have happened once.
 */
async function replayEdge(ledger: Ledger): Promise<Array<string>> {
  const ids = ['edge-q1', 'edge-q2', 'edge-q3'];
  const query = `SELECT event_id FROM ingest WHERE event_id LIKE 'fake:message:edge-q%' ORDER BY rowid`;
  await withLiveCore({ ledger, scripted: () => '<skip/>' }, async (live) => {
    await live.iface().drop();
    for (const id of ids) await live.deliver(messageEvent(id, `queued ${id}`, Date.now(), { mention: false }));
    await live.restart();
    await until(() => live.rows(query).length === ids.length, 'the replayed events');
    for (const row of live.rows(query)) ledger.record('ingest', String(row.event_id));
  });
  return ids.map((id) => `ingest:fake:message:${id}`);
}

/** A presence event of the member `u1` under the id `edge-presence-<n>`. */
const presenceEvent = (n: number): object => ({
  kind: 'presence.changed',
  iface: 'fake',
  at: Date.now(),
  id: `edge-presence-${n}`,
  accountId: 'u1',
  name: 'Eleni',
  status: 'online',
  activities: [],
});

/**
 * The door's memory of event ids at its edge (`DEFAULT_CAPACITY`, src/interface/door.ts). The first event goes in,
 * then as many others as fill the door to its capacity, and the first comes again: a duplicate. One more event pushes
 * the first out, and the first comes again: the door handles it as new. The ledger counts the core's answer to each
 * repeat as `ack:<step>:<status>`. The events go to the core's door in process, as the core's own events do, so ten
 * thousand of them take a moment. The core's own events share the door's memory: a scheduler tick or a wake the core
 * submits meanwhile takes the place of one event of the scenario, so the door holds exactly its capacity whenever one
 * comes. Returns the keys that must have happened once.
 */
async function doorEdge(ledger: Ledger): Promise<Array<string>> {
  await withLiveCore({ ledger, scripted: () => '<skip/>' }, async (live) => {
    const door = live.door();
    const submit = door.submit.bind(door);
    let others = 0;
    door.submit = (event, from) => {
      others += 1;
      return submit(event, from);
    };
    const status = async (n: number): Promise<string> => (await submit(presenceEvent(n))).status;
    ledger.record('ack', `first:${await status(1)}`);
    let next = 2;
    while (next - 1 + others < DEFAULT_CAPACITY) {
      await status(next);
      next += 1;
    }
    const full = others;
    ledger.record('ack', `at-capacity:${await status(1)}`);
    if (others === full) await status(next);
    ledger.record('ack', `past-capacity:${await status(1)}`);
  });
  return ['ack:first:ok', 'ack:at-capacity:duplicate', 'ack:past-capacity:ok'];
}

/** The day cap of the request-limit scenario: the requests one answered message takes, so the next finds none. */
const LIMIT_DAY_CAP = 2;
/** The token cap of the request-limit scenario: below the address classifier's request and every turn's fixed part. */
const LIMIT_TOKEN_CAP = 1000;

/** The turn records of the journal in `live`'s memory database, oldest first: what each turn ended in and why. */
const TURN_ENDS = `SELECT outcome, reason FROM day WHERE what = 'turn' ORDER BY rowid`;

/**
 * The request rails (`llm.maxRequestsPerDay`, `llm.maxRequestTokens`) through the real provider client, over a fake
 * `fetch`. With a day cap of the requests one answer takes, the first message is answered and the second finds the cap
 * spent: its classifier request and its turn's request are refused before anything is sent, the turn ends `refused`
 * with the reason `daily-cap`, and the persona posts the notice of the spent cap instead of an answer. With a token cap below
 * the classifier's request, the classifier is refused and the flagged line opens anyway. The turn's request budget is
 * the same cap, so the turn is refused while it fits its required sections, before the client's rail could refuse it:
 * it ends `refused` with the reason `token-limit`, and the persona posts the notice of the token cap. The ledger counts each turn's end as `turn:<step>:<outcome>:<reason>` and the
 * requests that reached the provider after each step as `requests:<step>:<count>`. Returns the keys that must have
 * happened once.
 */
async function requestLimitsEdge(ledger: Ledger): Promise<Array<string>> {
  const scripted = ({ directive }: ModelRequest): Answer =>
    directive === null ? '<skip/>' : `<msg>said ${directive.word}</msg>`;
  const ends = (live: Live, step: string, from: number): void => {
    for (const row of live.rows(TURN_ENDS).slice(from))
      ledger.record('turn', `${step}:${String(row.outcome)}:${String(row.reason)}`);
    ledger.record('requests', `${step}:${live.sent()}`);
  };
  await withLiveCore(
    { ledger, client: true, config: { llm: { maxRequestsPerDay: LIMIT_DAY_CAP } }, scripted },
    async (live) => {
      await live.deliver(messageEvent('cap-m1', 'do:say:cap-one', Date.now()));
      await until(() => live.rows(TURN_ENDS).length === 1, 'the answered turn');
      ends(live, 'day-cap-first', 0);
      await live.deliver(messageEvent('cap-m2', 'do:say:cap-two', Date.now()));
      await until(() => live.rows(TURN_ENDS).length === 2, 'the refused turn');
      await sleep(200);
      ends(live, 'day-cap-second', 1);
    }
  );
  await withLiveCore(
    { ledger, client: true, config: { llm: { maxRequestTokens: LIMIT_TOKEN_CAP } }, scripted },
    async (live) => {
      await live.deliver(messageEvent('cap-m3', 'do:say:cap-three', Date.now()));
      await until(() => live.rows(TURN_ENDS).length === 1, 'the refused turn');
      await sleep(200);
      ends(live, 'token-cap', 0);
    }
  );
  return [
    `send:${ROOM}:said cap-one`,
    'turn:day-cap-first:spoke:null',
    `requests:day-cap-first:${LIMIT_DAY_CAP}`,
    'turn:day-cap-second:refused:daily-cap',
    `requests:day-cap-second:${LIMIT_DAY_CAP}`,
    'turn:token-cap:refused:token-limit',
    'requests:token-cap:0',
  ];
}

/** The tables of the memory database whose rows the memory-write scenario counts: no FTS shadow table, no lease. */
const COUNTED_TABLES = `SELECT name FROM sqlite_master WHERE type = 'table' AND sql NOT LIKE 'CREATE VIRTUAL%'
  AND name NOT LIKE 'sqlite_%' AND name <> 'leases' ORDER BY name`;

/**
 * A turn's writes through the memory writer. One message asks the persona to set an intention, which they do with the write
 * tool `intention.set` due in two hours, and a second message is answered. The ledger counts the rows of every table
 * that holds any as `rows:<table>:<count>`, each stored intention as
 * `intention:<status>:<due after creation, minutes>:<scope>:<archived>:<position>` and each turn's end as
 * `turn:<n>:<outcome>`. Returns the keys that must have happened once.
 */
async function memoryWritesEdge(ledger: Ledger): Promise<Array<string>> {
  await withLiveCore(
    {
      ledger,
      config: { bot: { access: Object.fromEntries(['message.create', 'intention.set'].map(grantOf)) } },
      scripted: ({ directive }) => {
        if (directive === null) return '<skip/>';
        if (directive.verb === 'intend')
          return { text: '', toolCalls: [toolCall('intention.set', { text: `check ${directive.word}`, due: '2h' })] };
        return `<msg>said ${directive.word}</msg>`;
      },
    },
    async (live) => {
      await live.deliver(messageEvent('mw-m1', 'do:intend:mw-one', Date.now()));
      await until(() => live.rows(TURN_ENDS).length === 1, 'the turn that sets an intention');
      await live.deliver(messageEvent('mw-m2', 'do:say:mw-two', Date.now()));
      await until(() => live.rows(TURN_ENDS).length === 2, 'the answered turn');
      // The intention store hands its list to the writer after the turn: a missing row is counted, not waited out.
      await settled(() => live.rows('SELECT id FROM intentions').length > 0);
      await sleep(300);
      live.rows(TURN_ENDS).forEach((row, index) => ledger.record('turn', `${index + 1}:${String(row.outcome)}`));
      const intentions = live.rows(
        `SELECT status, CAST(round((due_ms - created_ms) / 60000.0) AS INTEGER) AS due, scope_kind, archived, position
          FROM intentions ORDER BY position`
      );
      for (const row of intentions) {
        const fields = [row.status, row.due, row.scope_kind, row.archived, row.position].map(String);
        ledger.record('intention', fields.join(':'));
      }
      for (const { name } of live.rows(COUNTED_TABLES)) {
        const count = live.rows(`SELECT count(*) AS n FROM "${String(name)}"`)[0]?.n;
        if (count !== 0 && !/_(fts|tri)(_|$)/.test(String(name)))
          ledger.record('rows', `${String(name)}:${String(count)}`);
      }
    }
  );
  return [
    'turn:1:spoke',
    'turn:2:spoke',
    `send:${ROOM}:said mw-two`,
    'intention:pending:120:group:0:0',
    'rows:intentions:1',
  ];
}

/**
 * Corrections of quiet lines, as events with no turn: a member's line edited twice, and another line deleted. Memory
 * keeps each revision of the edited line as a line of its own and the deletion as a line of the kind `deleted`, and the
 * deleted line's text stays. A message after them is answered, and the persona's request shows the newest revision. The ledger
 * counts each stored line of the scenario as `line:<message>:<kind>:<revision>:<text>:<retired>` and what their
 * request carries as `shown:<text>:<yes|no>`. Returns the keys that must have happened once.
 */
async function messageEditsEdge(ledger: Ledger): Promise<Array<string>> {
  const texts = ['edit base', 'edit second', 'edit third', 'gone soon'];
  await withLiveCore(
    {
      ledger,
      config: { bot: { access: Object.fromEntries(['message.create'].map(grantOf)) } },
      scripted: ({ directive }) => (directive === null ? '<skip/>' : `<msg>said ${directive.word}</msg>`),
    },
    async (live) => {
      const at = Date.now();
      const quiet = { mention: false };
      await live.deliver(messageEvent('ed-m1', 'edit base', at, quiet));
      await live.deliver(messageEvent('ed-m2', 'gone soon', at + 1, quiet));
      await live.deliver(messageEvent('ed-m1', 'edit second', at + 2, { ...quiet, edit: true }));
      await live.deliver(messageEvent('ed-m1', 'edit third', at + 3, { ...quiet, edit: true }));
      await live.deliver(messageEvent('ed-m2', '', at + 4, { ...quiet, deleted: true }));
      await live.deliver(messageEvent('ed-m3', 'do:say:ed-look', at + 5));
      await until(() => live.posted().includes('said ed-look'), 'the answer after the corrections');
      const lines = live.rows(
        `SELECT json_extract(extra, '$."$messageLocator".messageId') AS message, kind, revision, text,
          retired_at IS NOT NULL AS retired FROM sources WHERE message IN ('ed-m1', 'ed-m2') ORDER BY rowid`
      );
      for (const row of lines) {
        const fields = [row.message, row.kind, row.revision, row.text, row.retired].map(String);
        ledger.record('line', fields.join(':'));
      }
      const request = live.requests.at(-1) ?? '';
      for (const text of texts) ledger.record('shown', `${text}:${request.includes(text) ? 'yes' : 'no'}`);
    }
  );
  return [
    'line:ed-m1:seen:1:edit base:0',
    'line:ed-m1:seen:2:edit second:0',
    'line:ed-m1:seen:3:edit third:0',
    'line:ed-m2:seen:1:gone soon:0',
    'line:ed-m2:deleted:null:null:0',
    'shown:edit third:yes',
    `send:${ROOM}:said ed-look`,
  ];
}

/** The settings of a scenario with errands: the agent `code` on, its tool granted, a held result turn soon retried. */
const ERRAND_CONFIG: Settings = {
  agents: { code: { enabled: true } },
  errands: { resultRetrySeconds: 1 },
  bot: { access: Object.fromEntries(['message.create', 'errand.code'].map(grantOf)) },
};

/**
 * The model of a scenario with errands. A message `do:errand:<word>` files an errand of the agent `code` with the goal
 * `write <word>`. A result turn answers `said <word>` for a result naming `errand-done:<word>`, else `result failed`.
 * `do:hold:<word>` waits for `held` and then answers `said <word>`, and the rest answers its word.
 */
function errandModel(held?: { reached: Latch; gate: Latch }): (request: ModelRequest) => Promise<Answer> {
  return async ({ text, directive }) => {
    if (text.includes('<errand_result>')) {
      const word = /errand-done:([\w-]+)/.exec(text)?.[1];
      return word === undefined ? '<msg>result failed</msg>' : `<msg>said ${word}</msg>`;
    }
    if (directive === null) return '<skip/>';
    if (directive.verb === 'errand')
      return { text: '', toolCalls: [toolCall('errand.code', { goal: `write ${directive.word}` })] };
    if (directive.verb === 'hold' && held !== undefined) {
      held.reached.open();
      await held.gate.promise;
    }
    return `<msg>said ${directive.word}</msg>`;
  };
}

/** The board as the ledger counts it: each move of a task, its end and why, its result and its handoff to the persona. */
function countBoard(live: Live, ledger: Ledger): void {
  const moves = live.rows(
    `SELECT t.title, e.old, e.new FROM board_events e JOIN board_tasks t ON t.id = e.task_id ORDER BY e.seq`
  );
  for (const row of moves) ledger.record('board', `${String(row.title)}:${String(row.old)}->${String(row.new)}`);
  const tasks = live.rows(
    `SELECT title, status, close_reason, json_extract(metadata, '$.errand.readAt') IS NOT NULL AS read FROM board_tasks
      ORDER BY created_at, title`
  );
  for (const row of tasks) {
    const fields = [row.title, row.status, row.close_reason, row.read === 1 ? 'read' : 'unread'].map(String);
    ledger.record('board', fields.join(':'));
  }
  const kept = live.rows(
    `SELECT t.title, r.kind FROM board_results r JOIN board_tasks t ON t.id = r.task_id
      UNION ALL SELECT t.title,
        'outbox ' || o.kind || (CASE WHEN o.delivered_at IS NULL THEN ' waiting' ELSE ' delivered' END)
      FROM board_outbox o JOIN board_tasks t ON t.id = o.task_id ORDER BY 1, 2`
  );
  for (const row of kept) ledger.record('board', `${String(row.title)}:${String(row.kind)}`);
}

/**
 * Errands through the real runner server, with a fake agent in place of a harness. One errand comes back done with a
 * result, another, asked in a second chat, fails at the agent. Each is filed on the board, moved through its states,
 * handed back to the persona in a result turn, and marked read. The ledger counts each run the agent got as `agent:<goal>`, and
 * the board as countBoard does under `board:`. Returns the keys that must have happened once.
 */
async function errandsEdge(ledger: Ledger): Promise<Array<string>> {
  await withLiveCore(
    {
      ledger,
      config: ERRAND_CONFIG,
      agent: (task) => {
        ledger.record('agent', task.goal);
        return Promise.resolve(
          task.goal === 'write er-two'
            ? { status: 'failed', error: 'agent-failed' }
            : { status: 'done', result: { text: `errand-done:${task.goal.slice('write '.length)}` } }
        );
      },
      scripted: errandModel(),
    },
    async (live) => {
      await live.deliver(messageEvent('er-m1', 'do:errand:er-one', Date.now()));
      // The second ask waits for the journal row of the result turn, as the Discord scenario explains: the chat lane is
      // one for every chat.
      await until(
        () => live.posted().includes('said er-one') && live.rows(TURN_ENDS).length === 2,
        'the result of the done errand'
      );
      // A second result turn in one chat waits out a cooldown of a minute, so the second errand is asked elsewhere.
      live.adapter.seedChat(chatInfo(OTHER_ROOM));
      await live.deliver(messageEvent('er-m2', 'do:errand:er-two', Date.now(), { chat: OTHER_ROOM }));
      await until(
        () => live.adapter.messagesIn(OTHER_ROOM).some((message) => message.text === 'result failed'),
        'the result of the failed errand'
      );
      await settled(() => live.rows(`SELECT id FROM board_tasks WHERE metadata LIKE '%"readAt":null%'`).length === 0);
      await sleep(300);
      countBoard(live, ledger);
    }
  );
  return [
    'agent:write er-one',
    'agent:write er-two',
    `send:${ROOM}:said er-one`,
    `send:${OTHER_ROOM}:result failed`,
    'board:write er-one:in_progress->done',
    'board:write er-one:done:null:read',
    'board:write er-two:in_progress->failed',
  ];
}

/**
 * The core restarted while an errand runs at its agent and a turn waits on the model. The errand's connection to its
 * runner closes with the core, so the errand fails `disconnected`, and the new core reopens the result turn the persona never
 * had. The stopped core's turn goes on after the restart over its closed link and posts nothing. When the agent then
 * finishes, its end has no connection to come back on. The ledger counts each run the agent got as `agent:<goal>`,
 * the board as countBoard does, and each lease as `lease:<name>:<token>`. Returns the keys that must have happened
 * once.
 */
async function recoveryEdge(ledger: Ledger): Promise<Array<string>> {
  const agentGate = latch();
  const held = { reached: latch(), gate: latch() };
  await withLiveCore(
    {
      ledger,
      config: ERRAND_CONFIG,
      agent: async (task) => {
        ledger.record('agent', task.goal);
        await agentGate.promise;
        return { status: 'done', result: { text: `errand-done:${task.goal.slice('write '.length)}` } };
      },
      scripted: errandModel(held),
    },
    async (live) => {
      await live.deliver(messageEvent('rc-m1', 'do:errand:rc-one', Date.now()));
      await until(
        () => live.rows(`SELECT id FROM board_tasks WHERE status = 'in_progress'`).length === 1,
        'the running errand'
      );
      await live.deliver(messageEvent('rc-m2', 'do:hold:rc-two', Date.now()));
      await held.reached.promise;
      await live.restart();
      held.gate.open();
      await settled(() => live.posted().includes('result failed'));
      agentGate.open();
      await sleep(500);
      countBoard(live, ledger);
      for (const row of live.rows('SELECT name, token FROM leases ORDER BY name'))
        ledger.record('lease', `${String(row.name)}:${String(row.token)}`);
    }
  );
  return [
    'agent:write rc-one',
    `send:${ROOM}:result failed`,
    'board:write rc-one:in_progress->failed',
    'board:write rc-one:failed:disconnected:read',
  ];
}

/** The clock of the mirror scenario: fixed, moved by the scenario alone. */
const MIRROR_T0 = Date.UTC(2026, 10, 1, 12, 0, 0);

/**
 * A diary entry of two messages published to two mirrors, `ROOM` and `OTHER_ROOM`, by the publisher of
 * src/behavior/mirror.ts over a real memory service in a temporary folder and the fake adapter. The platform refuses
 * the entry's second message in `OTHER_ROOM` once, as retryable, after its first went out. A drain a minute later
 * sends what is left. The ledger counts the sends in the order they happened, and each publication after the publish
 * and after the drain as `publication:<stage>:<chat>:<status>:<retryable>:<segment statuses>`. Returns the keys that
 * must have happened once.
 */
async function mirrorsEdge(ledger: Ledger): Promise<Array<string>> {
  const root = mkdtempSync(join(tmpdir(), 'fm-'));
  let at = MIRROR_T0;
  const now = (): number => at;
  const hot = { config: { memoryDb: { session: { mode: 'off' } } }, prompts: {} };
  const memoryDb = createMemoryDb({ hot, dataDir: root, log: quietLog, now, worker: false, iface: () => 'fake' });
  try {
    await memoryDb.tick();
    const handle = memoryDb.readHandle();
    if (handle === null) throw new Error('fault-run: the memory database of the mirrors did not open');
    const db = dbOf(handle);
    const stamp = new Date(at).toISOString();
    const messages = ['part one', 'part two'];
    for (const chat of [ROOM, OTHER_ROOM]) {
      const placeId = channelPlaceId('fake', chat);
      const place = { id: placeId, iface: 'fake', kind: 'channel', native_id: chat, parent_id: null };
      insertRows(db, { places: [{ ...place, scope_kind: 'group', name: chat }] }, { at: stamp });
      db.prepare(
        `INSERT INTO mirrors (id, row_kind, place_id, enabled, created_at, created_by)
          VALUES (?, 'diary', ?, 1, ?, 'owner')`
      ).run(`mirror:${chat}`, placeId, stamp);
    }
    const extra = { publicationAudience: { kind: 'unrestricted' }, send: { messages, maxMessageBytes: 8_000_000 } };
    const entry = { id: 'e1', at_ms: at, kind: 'status', gist: 'entry', text: 'entry', position: 0 };
    const scope = { scope_kind: 'group', scope_iface: 'fake', scope_dm: null };
    insertRows(db, { diary: [{ ...entry, ...scope, extra: JSON.stringify(extra) }] }, { at: stamp });
    const adapter = createFakeAdapter({ selfId: SELF.id, now });
    adapter.seedChat(chatInfo(ROOM));
    adapter.seedChat(chatInfo(OTHER_ROOM));
    observe(adapter, ledger);
    let refusals = 1;
    const port = {
      iface: 'fake',
      capabilities: adapter.capabilities.bind(adapter),
      fetchMessages: adapter.fetchMessages.bind(adapter),
      send: (...args: Parameters<Adapter['send']>): ReturnType<Adapter['send']> => {
        const [chat, content] = args;
        if (chat.chatId !== OTHER_ROOM || content.text !== 'part two' || refusals === 0) return adapter.send(...args);
        refusals -= 1;
        ledger.record('failed', `send:${chat.chatId}:${content.text}`);
        return Promise.resolve(refusedSend(true));
      },
    };
    const mirrors = createMirrors({
      memoryDb,
      port: () => port,
      now,
      dataDir: root,
      config: () => ({ mirrors: { claimLeaseMs: 600_000, sendTimeoutMs: 600_000 } }),
    });
    const publications = (stage: string): void => {
      const rows = db
        .prepare(
          `SELECT destination_place_id AS place, status, retryable, delivery FROM publications
            WHERE row_kind = 'diary' ORDER BY destination_place_id`
        )
        .all();
      for (const row of rows) {
        const stored = typeof row.delivery === 'string' ? row.delivery : '{}';
        const delivery = JSON.parse(stored) as { segments?: Array<{ status?: unknown }> };
        const segments = (delivery.segments ?? []).map((one) => String(one.status)).join(',');
        const chat = String(row.place).split(':').at(-1);
        ledger.record('publication', `${stage}:${chat}:${String(row.status)}:${String(row.retryable)}:${segments}`);
      }
    };
    await mirrors.publishEntry({ id: 'e1', messages });
    publications('published');
    at += 60_000;
    await mirrors.drainQueued();
    publications('drained');
  } finally {
    await memoryDb.close();
    rmSync(root, { recursive: true, force: true });
  }
  return [
    `send:${ROOM}:part one`,
    `send:${ROOM}:part two`,
    `send:${OTHER_ROOM}:part one`,
    `failed:send:${OTHER_ROOM}:part two`,
    `send:${OTHER_ROOM}:part two`,
    `publication:published:${OTHER_ROOM}:failed:1:sent,failed`,
    `publication:drained:${ROOM}:sent:null:sent,sent`,
    `publication:drained:${OTHER_ROOM}:sent:null:sent,sent`,
  ];
}

/** The owner's commands the command-line scenario asks, as `neptunia <words>`. */
const OWNER_COMMANDS: ReadonlyArray<ReadonlyArray<string>> = [
  ['status'],
  ['status', 'full'],
  ['memory', 'conversation', ROOM],
  ['memory', 'graph', 'kinds'],
  ['memory', 'entities', 'list'],
];

/**
 * The full card with the parts the wall clock moves masked: the day of the record's lines, the process's uptime and
 * the reply times the speed field measured.
 */
function fullCardMasked(text: string): string {
  return text
    .replace(/\d{4}-\d{2}-\d{2}/g, '<day>')
    .replace(/uptime \S+/g, 'uptime <span>')
    .replace(/\d+ ms\b/g, '<n> ms');
}

/**
 * The short and the full status card and the memory browser through the owner's command line, the real `cli`
 * interface over the core's socket, after a conversation: one message asks the persona to set an intention, a second is
 * answered, and the requests go through the real provider client, so the cards count them. `status full` reaches
 * `status.show` (src/tools/operations/status.ts) with every field the console's card holds. The ledger counts each
 * command's answer as `command:<words>:<status>:<text>`, a time of the clock in it as `<minute> UTC` and the full
 * card's other wall-clock parts as fullCardMasked writes them. Returns the keys that must have happened once.
 */
async function commandLineEdge(ledger: Ledger): Promise<Array<string>> {
  await withLiveCore(
    {
      ledger,
      client: true,
      commands: true,
      config: { bot: { access: Object.fromEntries(['message.create', 'intention.set'].map(grantOf)) } },
      scripted: ({ directive }) => {
        if (directive === null) return '<skip/>';
        if (directive.verb === 'intend')
          return { text: '', toolCalls: [toolCall('intention.set', { text: `check ${directive.word}`, due: '2h' })] };
        return `<msg>said ${directive.word}</msg>`;
      },
    },
    async (live) => {
      await live.deliver(messageEvent('cl-m1', 'do:intend:cl-one', Date.now()));
      await until(() => live.rows(TURN_ENDS).length === 1, 'the turn that sets an intention');
      await live.deliver(messageEvent('cl-m2', 'do:say:cl-two', Date.now()));
      await until(() => live.rows(TURN_ENDS).length === 2, 'the answered turn');
      await settled(() => live.rows('SELECT id FROM intentions').length > 0);
      await sleep(300);
      for (const words of OWNER_COMMANDS) {
        const answer = await live.ask(words);
        // The card names the next wake by the wall clock, which moves from one run to the next.
        const timed = answer.text.replace(/\d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC/g, '<minute> UTC');
        const text = words.join(' ') === 'status full' ? fullCardMasked(timed) : timed;
        ledger.record('command', `${words.join(' ')}:${answer.status}:${text}`);
      }
    }
  );
  return [`send:${ROOM}:said cl-two`];
}

/**
 * The calls of a platform as the ledger counts them: each send and edit under its own key, as `observe` counts the
 * fake adapter's, so a repeat shows, and each distinct page of history once under `platform:read:`, because how often
 * the core reads depends on how many turns it starts. A fetch of one message and a typing indicator are not counted:
 * whether the core fetches a queued mention again depends on how its turns overlap.
 */
function countPlatform(calls: ReadonlyArray<string>, ledger: Ledger): void {
  const reads = new Set<string>();
  for (const call of calls) {
    const [op = '', ...rest] = call.split(':');
    if (op === 'send' || op === 'edit') ledger.record(op, rest.join(':'));
    else if (op === 'read') reads.add(call);
  }
  for (const read of reads) ledger.record('platform', read);
}

/**
 * The real Discord interface of interfaces/discord/ over a discord.js client with no gateway behind it
 * (scripts/lib/fault-platforms.ts), started by the core in its process as `src/index.ts` starts it, with a synthetic
 * token. The platform holds one line from before the start. A member asks in `ROOM` and the persona answers through
 * the adapter, then edits the answer with `message.edit`, a member edits a quiet line of theirs, and a second ask is
 * answered. The ledger counts the platform's calls as countPlatform does, and whether the persona's last request
 * carries a text as `shown:<text>:<yes|no>`: the line from before the start comes only through the adapter's history
 * read, the edits only through the gateway's update events. Returns the keys that must have happened once.
 */
async function discordEdge(ledger: Ledger): Promise<Array<string>> {
  const discord = createFakeDiscord({ self: SELF, root: SERVED_ROOT, chats: [ROOM], members: [MEMBER] });
  discord.seed(ROOM, 'older line');
  let last = '';
  await withLiveCore(
    {
      ledger,
      config: { bot: { access: Object.fromEntries(['message.create', 'message.edit'].map(grantOf)) } },
      platform: {
        name: 'discord',
        start: (host) =>
          startDiscord({ ...host, env: { DISCORD_TOKEN: 'fault-run-token' }, createClient: () => discord.client }),
      },
      scripted: ({ text, directive }) => {
        if (directive === null) return '<skip/>';
        if (directive.verb === 'edit') {
          const answer = `#${(directive.line ?? 2) - 1}`;
          return {
            text: '',
            toolCalls: [toolCall('message.edit', { message: answer, text: `fixed ${directive.word}` })],
          };
        }
        last = text;
        return `<msg>said ${directive.word}</msg>`;
      },
    },
    async (live) => {
      const has = (call: string): boolean => discord.calls.includes(call);
      // An ask that arrives while a turn holds the chat lane waits a switch pause of 2 to 9 s (src/pipeline/drain.ts).
      // A turn frees the lane before its journal row is written, so each ask waits for the row of the turn before it,
      // the quiet line's follow-up turn included.
      discord.write(ROOM, 'do:say:dc-one', true);
      await until(() => has(`send:${ROOM}:said dc-one`) && live.rows(TURN_ENDS).length === 1, 'the answer on Discord');
      discord.write(ROOM, 'do:edit:dc-one', true);
      await until(() => has(`edit:${ROOM}:fixed dc-one`) && live.rows(TURN_ENDS).length === 2, 'the edit on Discord');
      const quiet = discord.write(ROOM, 'typo here', false);
      discord.edit(ROOM, quiet, 'typo fixed');
      await until(() => live.rows(`SELECT id FROM sources WHERE text = 'typo fixed'`).length === 1, 'the stored edit');
      await until(() => live.rows(TURN_ENDS).length === 3, 'the follow-up turn of the quiet line');
      discord.write(ROOM, 'do:say:dc-two', true);
      await until(() => has(`send:${ROOM}:said dc-two`), 'the second answer on Discord');
      await sleep(300);
    }
  );
  countPlatform(discord.calls, ledger);
  for (const text of ['older line', 'fixed dc-one', 'typo here', 'typo fixed'])
    ledger.record('shown', `${text}:${last.includes(text) ? 'yes' : 'no'}`);
  return [
    `send:${ROOM}:said dc-one`,
    `edit:${ROOM}:fixed dc-one`,
    `send:${ROOM}:said dc-two`,
    'shown:older line:yes',
    'shown:fixed dc-one:yes',
    'shown:typo fixed:yes',
  ];
}

/** The moment every line of the terminal scenario is drawn at, so a time on the screen is the same in every run. */
const TERMINAL_NOW = Date.UTC(2026, 10, 1, 12, 0, 0);

/**
 * The owner's chat in a terminal: the real chat of interfaces/cli/index.ts drawn into a fake terminal of 80 by 24
 * cells, over its own command line to the core as `neptunia` opens one (bin/neptunia.ts, `runInkChat`), with a fixed
 * clock. The owner types a line and Enter, the persona's answer comes back over the link and is drawn, and then a slash
 * command typed in the chat is answered by the core in the command window. The ledger counts each persona line the link
 * printed as `printed:<text>`, the command's answer as `command:<words>:<status>:<text>` and the screen's rows that
 * show the conversation as `screen:<row>`. Returns the keys that must have happened once.
 */
async function terminalEdge(ledger: Ledger): Promise<Array<string>> {
  const term = createFakeTerminal(80, 24);
  await withLiveCore(
    {
      ledger,
      commands: true,
      scripted: ({ directive }) => (directive === null ? '<skip/>' : `<msg>said ${directive.word}</msg>`),
    },
    async (live) => {
      const listeners: { entry: (one: ChatEntry) => void } = { entry: () => {} };
      const link = await live.openLine({
        print: (text) => {
          ledger.record('printed', text);
          listeners.entry({ who: 'her', text });
        },
      });
      const answered: Array<string> = [];
      const env: ChatEnv = {
        title: 'Project Neptunia',
        commands: [{ name: 'intentions', help: 'What the persona means to do' }],
        history: [],
        still: true,
        send(text) {
          if (!text.trim().startsWith('/')) {
            void link.say(text);
            return undefined;
          }
          const parsed = parseCommandLine(text.trim());
          if (!parsed.ok) return Promise.resolve(parsed.reason);
          return link.ask({ name: parsed.name, args: parsed.args }).then((answer) => {
            ledger.record('command', `${text.trim()}:${answer.status}:${answer.text}`);
            answered.push(answer.text);
            return answer.text;
          });
        },
        panelOf: () => Promise.resolve(null),
        subscribe(given) {
          listeners.entry = given.entry;
        },
        status: () => Promise.resolve(null),
        saveHistory: () => {},
        now: () => TERMINAL_NOW,
        timeZone: 'UTC',
      };
      const shows = (text: string) => (): boolean => term.screen().some((row) => row.includes(text));
      const chat = runInteractive(env, { stdin: term.stdin as never, stdout: term.stdout as never });
      try {
        await until(() => term.screen().join('').trim() !== '', 'the first frame');
        term.type('do:say:tm-one');
        await until(shows('do:say:tm-one'), 'the typed line');
        term.type('\r');
        await until(shows('said tm-one'), 'the answer on the screen');
        term.type('/intentions');
        await until(shows('/intentions'), 'the typed command');
        term.type('\r');
        await until(() => answered.length === 1, 'the answer of the command');
        await sleep(200);
      } finally {
        term.type('\u0003');
        await chat;
      }
      for (const row of term.screen()) if (row.trim() !== '') ledger.record('screen', row);
    }
  );
  return [
    'printed:said tm-one',
    'command:/intentions:ok:no open intentions',
    'screen:[#1] do:say:tm-one',
    'screen:[#2] said tm-one',
    'screen:[2026-11-01 12:00] [#1] /intentions',
  ];
}

/**
 * A link to a video in a member's message, watched through the real video describer: src/media/video-sites.ts names
 * the link's site, src/media/fetch-video.ts probes it and downloads its clip with stand-ins of yt-dlp and ffmpeg over a
 * local file (scripts/lib/fault-platforms.ts), the video role's request is answered from the provider answers, and the
 * turn's request carries the description. The ledger counts each run of the tools as `tool:<run>`, the video request
 * as `watch:<whether it carries the local clip>` and whether the turn's request shows the description as
 * `shown:<text>:<yes|no>`. Returns the keys that must have happened once.
 */
/** The provider answers and the local page of the fault run. */
const FAULT_FIXTURES = join(ROOT, 'scripts', 'fixtures', 'fault-run');

async function videoEdge(ledger: Ledger): Promise<Array<string>> {
  const dir = mkdtempSync(join(tmpdir(), 'fv-'));
  const site = createFakeVideoSite(dir, 4);
  // The provider answers of the fault run, by request purpose.
  const answers = JSON.parse(readFileSync(join(FAULT_FIXTURES, 'answers.json'), 'utf8')) as { watch: string };
  const url = 'https://video.test/v/clip-one';
  const watched = `[watched: ${answers.watch}]`;
  let last = '';
  try {
    await withLiveCore(
      {
        ledger,
        config: {
          media: { video: { sites: ['video.test'], ytdlpPath: site.ytdlpPath, ffmpegPath: site.ffmpegPath } },
          models: { routes: { video: [{ via: 'api', key: 'core', model: 'google/gemini-3.8-flash' }] } },
        },
        scripted: ({ text, directive, purpose }) => {
          if (purpose === 'watch') {
            const carried = text.includes(`data:video/mp4;base64,${site.clip.toString('base64')}`);
            ledger.record('watch', carried ? 'local clip' : 'no clip');
            return answers.watch;
          }
          if (directive === null) return '<skip/>';
          last = text;
          return `<msg>said ${directive.word}</msg>`;
        },
      },
      async (live) => {
        const link = {
          id: videoUrlCacheKey(url),
          kind: 'link',
          site: 'video.test',
          title: '',
          text: '',
          thumbnailUrl: null,
          url,
        };
        await live.deliver(messageEvent('vd-m1', `do:say:vd-one ${url}`, Date.now(), { links: [link] }));
        await until(() => live.posted().includes('said vd-one'), 'the answer after the video');
        await sleep(300);
      }
    );
    for (const call of site.calls()) ledger.record('tool', call);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  ledger.record('shown', `${watched}:${last.includes(watched) ? 'yes' : 'no'}`);
  return [
    `tool:yt-dlp probe ${url}`,
    `tool:yt-dlp clip ${url}`,
    'watch:local clip',
    `shown:${watched}:yes`,
    `send:${ROOM}:said vd-one`,
  ];
}

/** What the web scenario searches for and reads. */
const WEB_QUERY = 'why cats push cups';
const WEB_PAGE = 'https://pets.test/why-cats-push-cups';

/** The tool results of a request after a tool step: the text parts of each `tool` message, in order. */
function toolResults(text: string): Array<string> {
  const messages = JSON.parse(text) as Array<{ role?: unknown; content?: Array<{ text?: string }> }>;
  return messages
    .filter((one) => one.role === 'tool')
    .map((one) => (one.content ?? []).map((part) => part.text ?? '').join('\n'));
}

/**
 * `web.search` and `web.read` in turns, through the real web lookup (src/web/lookup.ts) and its cache keys
 * (src/web/cache.ts). The search goes to the `openrouter` engine through the real provider client, whose fake `fetch`
 * answers the web plugin's request with the provider's answer of scripts/fixtures/fault-run/quick-search.json. The read
 * goes through the real page fetcher (src/web/fetch-page.ts) and reader (src/web/readable.ts), with a lookup that names
 * a public address and a request that answers the local page scripts/fixtures/fault-run/page.html. Each tool is called
 * twice, and the second call is answered from the cache. The ledger counts the result each tool call gave the model as
 * `result:<step>:<text>`, and the requests that reached the search and the page as `requests:<what>:<count>`. Returns
 * the keys that must have happened once.
 */
async function webEdge(ledger: Ledger): Promise<Array<string>> {
  const searchAnswer = JSON.parse(readFileSync(join(FAULT_FIXTURES, 'quick-search.json'), 'utf8')) as object;
  const page = readFileSync(join(FAULT_FIXTURES, 'page.html'));
  const asked = { search: 0, page: 0 };
  const pageFetcher = createPageFetcher({
    lookup: () => Promise.resolve([{ address: '203.0.113.10', family: 4 }]),
    requestImpl: () => {
      asked.page += 1;
      const headers = { 'content-type': 'text/html; charset=utf-8', 'content-length': String(page.length) };
      return Promise.resolve({ status: 200, headers, body: Readable.from([page]) });
    },
  });
  let step = '';
  await withLiveCore(
    {
      ledger,
      client: true,
      pageFetcher,
      provider: (body) => {
        if (body.plugins === undefined) return null;
        asked.search += 1;
        return searchAnswer;
      },
      config: {
        web: { quickSearch: { engine: 'openrouter' } },
        bot: { access: Object.fromEntries(['message.create', 'web.search', 'web.read'].map(grantOf)) },
      },
      scripted: ({ text, directive }) => {
        if (directive === null) {
          for (const result of toolResults(text)) ledger.record('result', `${step}:${result}`);
          return '<skip/>';
        }
        step = `${directive.verb} ${directive.word}`;
        if (directive.verb === 'search') return { text: '', toolCalls: [toolCall('web.search', { query: WEB_QUERY })] };
        return { text: '', toolCalls: [toolCall('web.read', { url: WEB_PAGE })] };
      },
    },
    async (live) => {
      const steps = ['do:search:wb-one', 'do:read:wb-one', 'do:search:wb-two', 'do:read:wb-two'];
      for (const [index, line] of steps.entries()) {
        await live.deliver(messageEvent(`wb-m${index + 1}`, line, Date.now()));
        await until(() => live.rows(TURN_ENDS).length === index + 1, `the turn of ${line}`);
      }
      await sleep(200);
    }
  );
  ledger.record('requests', `search:${asked.search}`);
  ledger.record('requests', `page:${asked.page}`);
  return ['requests:search:1', 'requests:page:1'];
}

// ---- the simulated weeks -----------------------------------------------------------------------------------------

const FIXTURES = join(ROOT, 'scripts', 'fixtures');

/**
 * One simulated week of the fixture `name` (scripts/fixtures/, scripts/lib/inner-week.ts): the production
 * scheduler and intention service over a fake clock, the turns answered by the stub voice. Each wake the journal says
 * ran is a `wake` effect under its id, and each errand end the week counted an `errand` effect. Returns the keys that
 * must have happened once.
 */
async function weekRound(name: string, ledger: Ledger): Promise<Array<string>> {
  const fixture = loadFixtures(FIXTURES).find((one: { name: string }) => one.name === name);
  if (fixture === undefined) throw new Error(`fault-run: no week fixture ${name}`);
  const run = await weekOf(fixture, effectsLookup());
  // A journal entry is a record of untyped fields; a `wake` entry carries the wake it ran.
  const entries = run.journal as Array<{ event: unknown; wake?: { id?: unknown } }>;
  for (const entry of entries) {
    const id = entry.wake?.id;
    if (entry.event === 'wake' && typeof id === 'string') ledger.record('wake', `${name}:${id}`);
  }
  const costs = run.errandCosts;
  for (const cost of costs) ledger.record('errand', `${name}:${cost.taskId}`);
  return costs.map((cost) => `errand:${name}:${cost.taskId}`);
}

// ---- the run -----------------------------------------------------------------------------------------------------

/** How much a run does. */
export type Plan = {
  /** Rounds of the live-core scenarios, each over a new core. */
  rounds: number;
  /** How many times each repeated event is delivered. */
  repeats: number;
  /** The week fixtures to play: their names, or every fixture of the folder. */
  weeks: ReadonlyArray<string> | 'all';
  /** The edge scenarios to run, by name (EDGES), or every one. */
  edges: ReadonlyArray<EdgeName> | 'all';
};

/** The edge scenarios in run order: each counts into its ledger and returns the keys that must have happened once. */
const EDGES = [
  { name: 'message limits', run: limitsEdge, ordered: false },
  { name: 'replay after a restart', run: replayEdge, ordered: true },
  { name: 'door capacity', run: doorEdge, ordered: false },
  { name: 'request limits', run: requestLimitsEdge, ordered: false },
  { name: 'memory writes', run: memoryWritesEdge, ordered: false },
  { name: 'message edits', run: messageEditsEdge, ordered: false },
  { name: 'recovery after a restart', run: recoveryEdge, ordered: false },
  { name: 'errands', run: errandsEdge, ordered: false },
  { name: 'partial mirror delivery', run: mirrorsEdge, ordered: true },
  { name: 'command line', run: commandLineEdge, ordered: false },
  { name: 'discord', run: discordEdge, ordered: false },
  { name: 'terminal', run: terminalEdge, ordered: true },
  { name: 'video', run: videoEdge, ordered: false },
  { name: 'web', run: webEdge, ordered: false },
] as const;

/** The name of an edge scenario. */
export type EdgeName = (typeof EDGES)[number]['name'];

/** The run of `scripts/harness.ts faults`: ten rounds, fifty repeats, every week, every edge scenario. */
export const LONG_PLAN: Plan = { rounds: 10, repeats: 50, weeks: 'all', edges: 'all' };

/** What one scenario counted and what is wrong with it. */
export type Row = {
  scenario: string;
  effects: number;
  /** Every effect key with its count, sorted. */
  keys: Array<[string, number]>;
  repeats: Array<[string, number]>;
  missing: Array<string>;
  /** Every effect key in the order it happened, for a scenario whose effects have an order; null for the others. */
  order: Array<string> | null;
};

export type Report = { rows: Array<Row>; ok: boolean; ms: number };

/** Runs `plan`: each scenario counts its effects in a ledger of its own, and a row says what repeated or never came. */
export async function faultRun(plan: Plan, onRow: (row: Row) => void = () => {}): Promise<Report> {
  const started = Date.now();
  const rows: Array<Row> = [];
  const finish = (scenario: string, ledger: Ledger, expected: Array<string>, isOrdered = false): void => {
    const row = {
      scenario,
      effects: ledger.counts().size,
      keys: [...ledger.counts()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
      repeats: ledger.repeats(),
      missing: ledger.missing(expected),
      order: isOrdered ? ledger.order() : null,
    };
    rows.push(row);
    onRow(row);
  };
  for (let round = 1; round <= plan.rounds; round += 1) {
    const ledger = createLedger();
    finish(`live core, round ${round}`, ledger, await liveRound(round, ledger, plan.repeats));
  }
  const names = plan.weeks === 'all' ? loadFixtures(FIXTURES).map((one: { name: string }) => one.name) : plan.weeks;
  for (const name of names) {
    const ledger = createLedger();
    finish(`week ${name}`, ledger, await weekRound(name, ledger));
  }
  for (const edge of EDGES) {
    if (plan.edges !== 'all' && !plan.edges.includes(edge.name)) continue;
    const ledger = createLedger();
    finish(`edge, ${edge.name}`, ledger, await edge.run(ledger), edge.ordered);
  }
  return {
    rows,
    ok: rows.every((row) => row.repeats.length === 0 && row.missing.length === 0),
    ms: Date.now() - started,
  };
}
