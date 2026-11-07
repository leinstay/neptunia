// The effect ledger and the live-core rig of the fault run (scripts/fault-run.ts, tests/fault-run.test.ts).
//
// `createLedger` counts every side effect by its effect key. A key names one thing that must happen once, whatever the
// number of events, retries, restarts and reconnects around it: `send:<conversation>:<text>` for a message she posts,
// `react:<conversation>/<message>/<emoji>` for a reaction, `wake:<id>` for a wake that ran, `delivery:<key>` for the
// post a completed wake left, `board:<title>` for a task on the board. A run passes when no key repeats and each
// expected key happened once. `observe` hangs the ledger on a fake adapter, so every call that reaches the interface is
// counted at the place a platform would see it, below the link's own dedupe by idempotency key.
//
// `withLiveCore` starts the real core (`startCore`, src/core.ts) over temporary folders in the layout of a deployment
// (`config.local/config.json`), a scripted model and a fake interface over one fake adapter that survives a restart of
// the core. The model never sees a provider: `scripted` answers each request from the directive `do:<verb>:<word>` in
// its newest line, so a message in the chat is the script of what she does about it. Nothing here reads a real
// `data/`, `.env` or local layer, and no key leaves the process.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startCore } from '../../src/core.ts';
import { createFakeAdapter } from '../../src/interface/fake.ts';
import { openMemoryDb } from '../../src/memory/db/open.ts';
import { start as startFake } from '../../src/interface/fake-interface.ts';
import type { FakeInterface } from '../../src/interface/fake-interface.ts';
import type { ConversationInfo, MessageEvent } from '../../src/protocol/adapter.ts';
import { apiNameOf } from '../../src/tools/definitions.ts';
import { effectsLookup, weekOf } from '../inner-week.ts';
import { loadFixtures } from './inner-week.ts';

/** Where an effect shows: the kinds the ledger counts. */
type EffectKind = 'send' | 'react' | 'wake' | 'delivery' | 'board' | 'errand';

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
};

export function createLedger(): Ledger {
  const seen = new Map<string, number>();
  return {
    record: (kind, key) => seen.set(`${kind}:${key}`, (seen.get(`${kind}:${key}`) ?? 0) + 1),
    counts: () => seen,
    repeats: () => [...seen].filter(([, count]) => count > 1),
    missing: (expected) => expected.filter((key) => seen.get(key) !== 1),
  };
}

type Adapter = ReturnType<typeof createFakeAdapter>;

/**
 * Counts what reaches `adapter`: each send under `send:<conversation>:<text>` and each reaction under its message.
 * The adapter keeps working as before.
 */
export function observe(adapter: Adapter, ledger: Ledger): void {
  const send = adapter.send.bind(adapter);
  adapter.send = (conversation, content, options) => {
    ledger.record('send', `${conversation.conversationId}:${content.text ?? ''}`);
    return send(conversation, content, options);
  };
  const react = adapter.react.bind(adapter);
  adapter.react = (ref, emoji) => {
    ledger.record('react', `${ref.conversationId}/${ref.messageId}/${emoji}`);
    return react(ref, emoji);
  };
}

// ---- the live core ------------------------------------------------------------------------------------------------

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SELF = { id: 'self-id', name: 'Nova' };
const COMMUNITY = { id: 'g1', name: 'Alpha' };
/** The conversation of the run. */
const ROOM = 'c1';

type Settings = Record<string, unknown>;

type ToolCall = { id: null; name: string; arguments: string; parsed: Record<string, unknown>; parseError: null };

/** A tool call of the model: the dotted skill name with its arguments, as the native transport hands it over. */
function toolCall(name: string, args: Record<string, unknown>): ToolCall {
  return { id: null, name: apiNameOf(name) ?? name, arguments: JSON.stringify(args), parsed: args, parseError: null };
}

/** What the scripted model answers: a speech-only text, or text with tool calls. */
type Answer = string | { text: string; toolCalls: Array<ToolCall> };

/** What a message or a wake asks of her: `do:<verb>:<word>`. */
type Directive = { verb: string; word: string; line: number | null };

/**
 * One request the model got: its text, how many came before it, and the directive it carries. A request carries one
 * when it is the first step of a turn (no tool result yet, no reminder of an open intention) and the line that woke her
 * names one: the newest chat line, or the intention a wake says is due.
 */
type ModelRequest = { text: string; count: number; directive: Directive | null };

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

/** A conversation as the fake reports it: a public channel she may read, post in and react in. */
function conversationInfo(id: string): ConversationInfo {
  return {
    id,
    kind: 'channel',
    rootId: COMMUNITY.id,
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

/** A member's message in `ROOM` as an interface delivers it: new, or `edit`ed, or `deleted`. */
function messageEvent(
  id: string,
  text: string,
  at: number,
  how: { mention?: boolean; edit?: boolean; deleted?: boolean } = {}
): MessageEvent {
  const mention = how.mention !== false;
  return {
    kind: 'message.received',
    iface: 'fake',
    at,
    id: `fake:message:${id}${how.edit === true ? `:edit:${at}` : how.deleted === true ? ':deleted' : ''}`,
    conversation: { id: ROOM, kind: 'channel', rootId: COMMUNITY.id, name: `room-${ROOM}` },
    ...(how.edit === true ? { edit: true } : {}),
    ...(how.deleted === true ? { deleted: true } : {}),
    message: {
      id,
      author: { id: 'u1', name: 'Eleni', self: false, bot: false },
      content: text,
      sourceText: text,
      system: false,
      at,
      replyToId: null,
      replyPingAccountId: null,
      forwardedFrom: null,
      attachments: [],
      links: [],
      forwarded: [],
      stickers: [],
      emojis: [],
      reactions: [],
    },
    addressing: {
      mentioned: mention,
      replyToSelf: false,
      mentionedAccountIds: mention ? [SELF.id] : [],
      mentionedConversationIds: [],
    },
  };
}

const BASE_CONFIG: Settings = {
  bot: { timezone: 'UTC', owners: [], placeId: COMMUNITY.id },
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
};

type Live = {
  ledger: Ledger;
  adapter: Adapter;
  /** The running interface of the current start of the core. */
  iface(): FakeInterface;
  /** Her texts in `ROOM`, in the order she posted them. */
  posted(): Array<string>;
  /** The text of every model request so far. */
  requests: Array<string>;
  /** Puts the message in the chat and emits its event: the core's ack status. */
  deliver(event: MessageEvent): Promise<string>;
  /** The rows a query of the memory database returns, read through a second, read-only connection. */
  rows(sql: string): Array<Record<string, unknown>>;
  /** Stops the core and starts a new one over the same folders and the same chat. */
  restart(): Promise<void>;
};

/** Waits until `check` holds, or throws after `ms`. */
async function until(check: () => boolean, what: string, ms = 8000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
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
  const adapter = createFakeAdapter({ selfId: SELF.id });
  adapter.seedConversation(conversationInfo(ROOM));
  observe(adapter, ledger);
  const requests: Array<string> = [];
  const llm = {
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
      // The door asks the address classifier about every flagged line first: a call to her, so `yes`, never scripted.
      if ((given as { purpose?: unknown } | undefined)?.purpose === 'address')
        return { text: 'yes', usage: {}, estimated: 1 };
      const text = JSON.stringify(messages);
      const afterTools = Array.isArray(messages) && messages.some((one) => isRecord(one) && one.role === 'tool');
      requests.push(text);
      const answer = await options.scripted({ text, count: requests.length, directive: directiveOf(text, afterTools) });
      return typeof answer === 'string'
        ? { text: answer, usage: {}, estimated: 10 }
        : { text: answer.text, toolCalls: answer.toolCalls, usage: {}, estimated: 10, finishReason: 'stop' };
    },
  };
  let running: FakeInterface | null = null;
  const started: { core: Awaited<ReturnType<typeof startCore>> | null } = { core: null };
  const boot = async (): Promise<void> => {
    started.core = await startCore({
      paths: { rootDir: ROOT, privateDir, dataDir },
      env: { OPENROUTER_CORE_KEY: 'test-key' },
      interfaces: [
        {
          name: 'fake',
          start: async (host) => {
            running = await startFake(host, { adapter, self: SELF, community: COMMUNITY });
            return running;
          },
        },
      ],
      llm,
      embedder: { embed: () => Promise.resolve([]) },
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
    deliver(event) {
      adapter.seedEvent(event);
      return live.iface().emit(event);
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
      await started.core?.stop();
      await boot();
    },
  };
  try {
    return await body(live);
  } finally {
    await started.core?.stop();
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

/**
 * The scenarios of one round over one live core. Each message carries a directive the scripted model follows:
 * `do:say:<word>` answers with that word, `do:react:<word>` reacts to the message, `do:hold:<word>` waits for the
 * latch of that word and then answers. Words are unique per round, so a key never meets another round's.
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
      scripted: async ({ directive }) => {
        if (directive === null) return '<skip/>';
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

      // An event emitted while the link is down arrives once after the reconnect, as history: the owner's no-catch-up
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

      // A turn cut off mid-call: her reaction takes longer than the call may, so the turn goes on without its result
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

// ---- the simulated weeks -----------------------------------------------------------------------------------------

const FIXTURES = join(ROOT, 'scripts', 'fixtures');
/** What the week's journal says of a wake it ran. */
type WakeEntry = { event: string; wake?: { id?: string } };

type PlayWeek = (
  fixture: unknown,
  options: { effectsOf: unknown }
) => Promise<{ run: { journal: Array<WakeEntry>; errandCosts: Array<{ taskId: string }> } }>;

// scripts/inner-week.ts is JavaScript whose JSDoc types its options as `{ keep }` only; `weekOf` passes the rest to the
// week runner, which reads `effectsOf`. The cast says what this file reads of its answer.
const playWeek = weekOf as unknown as PlayWeek;

/**
 * One simulated week of the fixture `name` (scripts/fixtures/, scripts/lib/inner-week.ts): the production
 * scheduler and intention service over a fake clock, the turns answered by the stub voice. Each wake the journal says
 * ran is a `wake` effect under its id, and each errand end the week counted an `errand` effect. Returns the keys that
 * must have happened once.
 */
async function weekRound(name: string, ledger: Ledger): Promise<Array<string>> {
  const fixture = loadFixtures(FIXTURES).find((one: { name: string }) => one.name === name);
  if (fixture === undefined) throw new Error(`fault-run: no week fixture ${name}`);
  const { run } = await playWeek(fixture, { effectsOf: effectsLookup() });
  for (const entry of run.journal) {
    if (entry.event === 'wake' && typeof entry.wake?.id === 'string') ledger.record('wake', `${name}:${entry.wake.id}`);
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
};

/** The run the suite makes. */
export const SHORT_PLAN: Plan = {
  rounds: 1,
  repeats: 5,
  weeks: ['hour-errand', 'restart', 'recurring', 'stalled-errand'],
};
/** The run behind `scripts/fault-run.ts`: more rounds, more repeats, every week. */
export const LONG_PLAN: Plan = { rounds: 10, repeats: 50, weeks: 'all' };

/** What one scenario counted and what is wrong with it. */
export type Row = { scenario: string; effects: number; repeats: Array<[string, number]>; missing: Array<string> };

export type Report = { rows: Array<Row>; ok: boolean; ms: number };

/** Runs `plan`: each scenario counts its effects in a ledger of its own, and a row says what repeated or never came. */
export async function faultRun(plan: Plan, onRow: (row: Row) => void = () => {}): Promise<Report> {
  const started = Date.now();
  const rows: Array<Row> = [];
  const finish = (scenario: string, ledger: Ledger, expected: Array<string>): void => {
    const row = {
      scenario,
      effects: ledger.counts().size,
      repeats: ledger.repeats(),
      missing: ledger.missing(expected),
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
  return {
    rows,
    ok: rows.every((row) => row.repeats.length === 0 && row.missing.length === 0),
    ms: Date.now() - started,
  };
}

/** The report as a table, one row per scenario, and a last line that says whether the run passed. */
export function tableOf(report: Report): string {
  const lines = ['| Scenario | Effects | Repeated keys | Missing keys |', '|---|---|---|---|'];
  for (const row of report.rows) {
    const repeated = row.repeats.map(([key, count]) => `${key} x${count}`).join(', ') || '-';
    lines.push(`| ${row.scenario} | ${row.effects} | ${repeated} | ${row.missing.join(', ') || '-'} |`);
  }
  lines.push(
    '',
    `${report.ok ? 'passed' : 'FAILED'}: ${report.rows.length} scenarios in ${Math.round(report.ms / 100) / 10} s`
  );
  return `${lines.join('\n')}\n`;
}
