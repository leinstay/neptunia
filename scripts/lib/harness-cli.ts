// The command line edge of scripts/harness.ts `cli`. `runCliEdge` opens a writable data copy with the core's own
// builders: the memory service (src/memory/db/service.ts) writable on this thread with a fixed clock, counter ids and
// no worker, the store (src/memory/store.ts), the owner's operations (src/admin.ts), the console
// (src/interface/commands/console.ts) and the command desk (src/interface/neptunia-cli.ts) the core answers the
// command line with. Each line of a fixed list is parsed as `neptunia -p` parses it (src/interface/commands/table.ts)
// and answered by the desk as the owner. The reads need no live core; the writes change the copy and are each undone
// by the next. Every command writes `<out>/cli/<nn>-<name>.txt` with the line, the status, the code and the text it
// answered, and after a write the sha256 of each file under `config/` and the hash of every table (scripts/lib/
// harness-db.ts). `<out>/cli/unrecorded.txt` names every command of the table the list leaves out, with why. A record
// holds what the command printed and nothing else of the copy: THE RECORDS ARE PRIVATE, like the copy.

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createAdmin } from '../../src/admin.ts';
import { createConsole } from '../../src/interface/commands/console.ts';
import { COMMANDS, parseCommandLine } from '../../src/interface/commands/table.ts';
import { createCommandDesk } from '../../src/interface/neptunia-cli.ts';
import { createMemoryDb } from '../../src/memory/db/service.ts';
import { errandRecentLines } from '../../src/memory/db/chat-lines.ts';
import { dbOf } from '../../src/memory/db/types.ts';
import type { Db } from '../../src/memory/db/types.ts';
import { placeOfChat } from '../../src/memory/addresses.ts';
import { createStore } from '../../src/memory/store.ts';
import { expandPersonaGrant } from '../../src/tools/operations/access.ts';
import { tableHashes } from './harness-db.ts';
import { counterIds } from './turn-archive.ts';
import { homeIdentity, quietLog } from './turn-wiring.ts';
import { hotOf } from './turn-run.ts';

/** The clock of every command: a fixed moment, so two runs over one copy answer alike. */
export const CLI_NOW = Date.parse('2026-11-22T00:00:00Z');

/** The setting the writes change and restore: a spread of the heartbeat, which no command of the list reads. */
const HARMLESS = { path: 'heartbeat.jitterMinutes', value: '47' };

/** The rule the writes add and remove. */
const HARNESS_RULE = 'harness rule, added and removed by the command line edge';

/** Why a command of the table is left out of the list: by its full name, else by its first word. */
const UNRECORDED_WHY: Readonly<Record<string, string>> = {
  status: 'reads the running core: its pause, spend, interfaces, wakes and errands',
  usage: 'reads the usage accumulator of the running core and each key limit over the network',
  pause: 'changes the pause of the running core and waits for its turns',
  resume: 'changes the pause of the running core and hands back what it held',
  doctor: 'probes the machine: its services, disk and memory',
  'doctor.server': 'probes the machine: its services, disk and memory',
  'doctor.live': 'sends a request to every model role',
  logs: 'reads the journal of the machine',
  services: 'reads and changes the units of the machine and the wakes of the running core',
  errands: 'reads and changes the errand board of the running core and starts agents',
  intentions: 'reads and changes the intentions of the running core',
  interfaces: 'reads and changes the interface links of the running core and their credentials',
  keys: 'reads and changes the key store and checks a key with a request',
  model: 'checks a route with a model request before it saves',
  agent: 'checks an agent with a run of its backend',
  agents: 'reads the agents and their backends on the machine',
  subharness: 'reads and runs the backends of the machine',
  humanizer: 'reads the routes of the running core and checks them with a request',
  search: 'reads the search engine and checks it over the network',
  proxy: 'probes the proxy of the running core over the network',
  skills: 'reads and changes the skills through the running core',
  mirror: 'reads and changes the mirrors of the running core',
};
/** The reason of every other command left out: the list of the spec is fixed and holds only its reads and writes. */
const OUTSIDE_LIST = 'outside the fixed list of reads and writes';

/** One command of the list: its record name, its line, and whether it writes. */
type Step = { name: string; line: () => string; write: boolean };

type Answer = { text: string; status: string; code?: string };

/** The leaf names of the command table, as the desk receives them. */
function tableNames(): Array<string> {
  const names: Array<string> = [];
  for (const command of COMMANDS) {
    // A command with no subcommand, or one answered bare, is a name of its own.
    if (
      command.subcommands.length === 0 ||
      (command.needsSubcommand !== true && command.defaultSubcommand === undefined)
    )
      names.push(command.name);
    for (const one of command.subcommands) names.push(`${command.name}.${one.name}`);
  }
  return names;
}

/** The sha256 of every file under `<dataDir>/config/`, by its path there. */
function configShas(dataDir: string): Array<string> {
  const dir = path.join(dataDir, 'config');
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(entry.parentPath, entry.name))
    .sort()
    .map(
      (file) =>
        `${path.relative(dir, file).split(path.sep).join('/')} ${createHash('sha256').update(fs.readFileSync(file)).digest('hex')}`
    );
}

/** The record of one command: its line, its answer and, after a write, the config files and the tables. */
function recordText(
  line: string,
  answer: Answer,
  after: { config: Array<string>; tables: Record<string, { rows: number; hash: string }> } | null
): string {
  const parts = [
    `$ neptunia ${line}`,
    `status: ${answer.status}`,
    `code: ${answer.code ?? '-'}`,
    '--- text',
    answer.text,
  ];
  if (after !== null) {
    parts.push('--- config', ...after.config, '--- tables');
    for (const [table, sum] of Object.entries(after.tables)) parts.push(`${table} ${sum.rows} ${sum.hash}`);
  }
  return `${parts.join('\n')}\n`;
}

/** The list of commands, over facts of the copy read before the first: its top-level settings and its first tool. */
function stepsOf(facts: {
  topKeys: ReadonlyArray<string>;
  conversation: string;
  place: string;
  tool: () => string;
  ruleNumber: () => string;
}): Array<Step> {
  const read = (name: string, line: string): Step => ({ name, line: () => line, write: false });
  return [
    read('help', 'help'),
    read('config-show', 'config show'),
    read('config-check', 'config check'),
    ...facts.topKeys.map((key) => read(`config-get-${key}`, `config get ${key}`)),
    read('rules', 'rules'),
    read('tools', 'tools'),
    read('memory-conversation', `memory conversation ${facts.conversation}`),
    read('memory-lessons', `memory lessons.list --place ${facts.place}`),
    read('doctor-core', 'doctor core'),
    read('doctor-memory', 'doctor memory'),
    read('routes', 'routes'),
    read('model-show', 'model show'),
    { name: 'config-set', line: () => `config set ${HARMLESS.path} ${HARMLESS.value}`, write: true },
    { name: 'config-unset', line: () => `config unset ${HARMLESS.path}`, write: true },
    { name: 'rule-add', line: () => `rules add ${HARNESS_RULE}`, write: true },
    { name: 'rule-remove', line: () => `rules remove ${facts.ruleNumber()}`, write: true },
    { name: 'tools-grant', line: () => `tools grant ${facts.tool()}`, write: true },
    { name: 'tools-revoke', line: () => `tools revoke ${facts.tool()}`, write: true },
  ];
}

/** The names the list answers, so `unrecorded.txt` names the rest. */
function recordedNames(steps: ReadonlyArray<Step>): Set<string> {
  const names = new Set<string>();
  for (const step of steps) {
    const parsed = parseCommandLine(step.line());
    if (parsed.ok) names.add(parsed.name);
  }
  return names;
}

/** The first channel of the copy's home interface by its native id, the chat `memory conversation` reads. */
function firstChannel(db: Db, iface: string): string {
  const row = db
    .prepare(
      "SELECT native_id FROM places WHERE kind = 'channel' AND iface = ? AND native_id IS NOT NULL ORDER BY native_id LIMIT 1"
    )
    .get(iface);
  return typeof row?.native_id === 'string' ? row.native_id : 'none';
}

/** Counts of one run of the edge. */
export type CliEdgeCounts = { recorded: number; unrecorded: number };

/**
 * The command line edge over the writable copy `dataDir` (see the head of this file), its records under `<out>/cli/`.
 * The copy is changed by the writes.
 */
export async function runCliEdge(options: { root: string; dataDir: string; out: string }): Promise<CliEdgeCounts> {
  const { dataDir } = options;
  const now = (): number => CLI_NOW;
  const newId = counterIds();
  const deferred: Array<() => unknown> = [];
  // Who the persona is on the copy's home interface, read once the database is open.
  let home = { iface: 'cli', selfId: '', selfName: '' };
  const { hot, close: closeHot } = hotOf(options.root, dataDir, null);
  const memoryDb = createMemoryDb({
    hot,
    dataDir,
    log: quietLog,
    now,
    worker: false,
    defer: (fn) => deferred.push(fn),
    iface: () => home.iface,
    newId,
  });
  const dir = path.join(options.out, 'cli');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    await memoryDb.open();
    const handle = memoryDb.readHandle();
    if (handle === null) throw new Error('harness cli: the memory database of the copy did not open');
    home = homeIdentity(dbOf(handle), dataDir);
    const store = createStore({ dataDir, memoryDb, newId });
    const admin = createAdmin({
      hot,
      store,
      memoryDb,
      selfId: () => home.selfId,
      now,
      dataDir,
    });
    const selfId = (): string | null => home.selfId || null;
    const desk = createCommandDesk({
      console: createConsole({
        runOp: (op, args, context) => admin.runSkillOp(op, args, context),
        ownerReads: admin.ownerReads,
        places: () => store.topPlaces(),
        selfId,
        hot,
        privateDir: dataDir,
        dataDir,
        memoryDb,
        usage: null,
        metrics: null,
        chatLines: (chatId, count) => {
          const db = memoryDb.database();
          const placeId = db === null ? '' : placeOfChat(store, { id: chatId }, home.iface);
          if (db === null || placeId === '') return [];
          const labels = (hot.prompts as { labels?: unknown }).labels;
          return errandRecentLines(db, placeId, count, { selfName: home.selfName, labels });
        },
        now,
      }),
      interfaces: {
        list: () => [],
        enable: () => {},
        disable: () => Promise.resolve({ drained: 0, unknown: 0 }),
        installed: () => [],
      },
      facts: () => {
        throw new Error('the command line edge records no command that reads the running core');
      },
    });
    const settle = async (): Promise<void> => {
      await store.flushSettled({ final: false, timeoutMs: 10_000 });
      while (deferred.length > 0) await deferred.shift()?.();
    };
    const config = (hot as { config: Record<string, unknown> }).config;
    let tool: string | null = null;
    const steps = stepsOf({
      topKeys: Object.keys(config).sort(),
      conversation: firstChannel(dbOf(handle), home.iface),
      // The copy serves no root, so the command names its first top place as the owner would.
      place: [...store.topPlaces()].sort()[0] ?? 'none',
      // The first tool the persona does not hold, so the grant and the revoke leave their grants as they were.
      tool: () => tool ?? 'none',
      ruleNumber: () => String(store.liveRules().findIndex((rule) => rule.text === HARNESS_RULE) + 1),
    });
    const requester = { id: 'cli:owner', roles: [] };
    for (const [index, step] of steps.entries()) {
      const line = step.line();
      const parsed = parseCommandLine(line);
      const answer: Answer = parsed.ok
        ? await desk.run(
            { name: parsed.name, args: parsed.args, chat: { id: 'cli:dm:owner' }, requester },
            { kind: 'cli', name: 'owner' }
          )
        : { text: parsed.reason, status: 'invalid' };
      if (step.name === 'tools')
        tool =
          answer.text
            .split('\n')
            .filter((row) => row.endsWith('  -'))
            .map((row) => row.split(/\s+/)[0] ?? '')
            .find((name) => expandPersonaGrant(name)?.refused.length === 0) ?? null;
      let after = null;
      if (step.write) {
        await settle();
        after = { config: configShas(dataDir), tables: tableHashes(dbOf(handle), { measured: true }) };
      }
      const file = `${String(index + 1).padStart(2, '0')}-${step.name}.txt`;
      fs.writeFileSync(path.join(dir, file), recordText(line, answer, after), { mode: 0o600 });
    }
    const recorded = recordedNames(steps);
    const left = tableNames().filter((name) => !recorded.has(name));
    fs.writeFileSync(
      path.join(dir, 'unrecorded.txt'),
      left
        .map((name) => `${name}  ${UNRECORDED_WHY[name] ?? UNRECORDED_WHY[name.split('.')[0] ?? ''] ?? OUTSIDE_LIST}\n`)
        .join(''),
      { mode: 0o600 }
    );
    return { recorded: steps.length, unrecorded: left.length };
  } finally {
    await memoryDb.close();
    closeHot();
  }
}
