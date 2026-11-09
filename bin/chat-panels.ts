// Builds the owner chat's panels from the command table and settings schema. Every action delegates to the same
// command handler as a typed command. Opening setup does no installation, authentication or provider probe.
import { CONFIG_SCHEMA, schemaDefaults } from '../src/config/schema.ts';
import { deepMerge } from '../src/config.ts';
import { COMMANDS, parseCommandLine } from '../src/interface/commands/table.ts';
import type { Panel, PanelResult, PanelRow } from '../cli/panel.ts';
import { approvalPanel } from '../cli/approval-view.ts';
import type { GateView } from '../cli/approval-view.ts';
import { contextLine } from '../cli/context-line.ts';
import type { ContextFacts } from '../cli/context-line.ts';
import { boundaryPanel, checkpointPanel, sessionsPanel } from '../cli/session-picker.ts';
import type { CheckpointPoint, SessionClient, SessionLineView, SessionRowView } from '../cli/session-picker.ts';
import type { PickerEnv } from '../cli/model-picker.ts';
import { modelRoleRegistry } from '../src/subharness/model-capabilities.ts';
import type { RoleSources } from '../src/subharness/model-capabilities.ts';
import { settingPresentation } from './setting-presentation.ts';

type Run = (command: { name: string; args: Record<string, unknown> }) => Promise<PanelResult>;
const object = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

function settingsRows(config: Record<string, unknown>, run: Run, prefix = ''): Array<PanelRow> {
  return Object.entries(config).flatMap(([key, value]) => {
    const id = prefix === '' ? key : `${prefix}.${key}`;
    if (typeof value === 'object' && value !== null && !Array.isArray(value))
      return settingsRows(object(value), run, id);
    const schema = CONFIG_SCHEMA.find((entry) => entry.key === id);
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    return [
      {
        id,
        ...settingPresentation(id, schema?.text ?? 'A personal setting for this feature.'),
        value: text,
        edit: { kind: typeof value === 'boolean' ? ('boolean' as const) : ('text' as const), value: text },
        apply: (next: string) => run({ name: 'config.set', args: { path: id, value: next } }),
      },
    ];
  });
}

function action(
  run: Run,
  id: string,
  label: string,
  detail: string,
  name: string,
  args: Record<string, unknown>,
  group: string
): PanelRow {
  return { id, label, detail, group, apply: () => run({ name, args }) };
}

function named(run: Run, id: string, label: string, detail: string, name: string, group: string): PanelRow {
  return {
    id,
    label,
    detail,
    group,
    edit: { kind: 'text', value: '' },
    apply: (value) => {
      const next = value.trim();
      return next === ''
        ? Promise.resolve({ status: 'invalid', text: 'Enter a name.' })
        : run({ name, args: { name: next } });
    },
  };
}

function setupRows(run: Run, interfaces: ReadonlyArray<string>): Array<PanelRow> {
  return [
    named(
      run,
      'core-key',
      'Add core key',
      'Name this OpenRouter key; the next dialog asks for its secret and models.',
      'keys.core.add',
      'Keys'
    ),
    named(
      run,
      'extra-key',
      'Add extra key',
      'A named key for an independent model or service binding.',
      'keys.extra.add',
      'Keys'
    ),
    ...['youtube', 'brave', 'exa', 'proxy'].map((name) =>
      action(
        run,
        `service:${name}`,
        name,
        'Configure an optional service credential in a masked dialog.',
        'keys.service.set',
        { name },
        'Keys'
      )
    ),
    ...interfaces.map((name) =>
      action(
        run,
        `interface:${name}`,
        `Set up ${name}`,
        'Answer the interface’s own setup questions.',
        'interfaces.setup',
        { name },
        'Interfaces'
      )
    ),
    ...interfaces.flatMap((name) => [
      action(
        run,
        `enable:${name}`,
        `Enable ${name}`,
        'Enable this interface in the persona settings.',
        'interfaces.enable',
        { name },
        'Interfaces'
      ),
      action(
        run,
        `disable:${name}`,
        `Disable ${name}`,
        'Keep its settings and stored memories.',
        'interfaces.disable',
        { name },
        'Interfaces'
      ),
    ]),
    named(
      run,
      'skill',
      'Set up a skill',
      'Enter the name of a skill already in data/skills/.',
      'skills.setup',
      'Skills'
    ),
    {
      id: 'models',
      label: 'Choose a model',
      detail: 'Open the selector: category, role, source, model and effort, saved after one checked reply.',
      group: 'Models',
      prefill: '/model',
    },
    {
      id: 'binding',
      label: 'Bind an extra key',
      detail: 'Choose the role and the name of an existing extra key.',
      group: 'Models',
      prefill: '/keys bind ',
    },
    ...['claude', 'codex', 'opencode'].map((backend): PanelRow => ({
      id: `backend:${backend}`,
      label: `Log in to ${backend}`,
      detail: 'Run this in a shell as neptunia subharness; it offers to install the backend first.',
      group: 'Models',
      prefill: `/subharness ${backend} login${backend === 'opencode' ? ' --key ' : ''}`,
    })),
    ...['openrouter', 'brave', 'exa'].map((name) =>
      action(
        run,
        `search:${name}`,
        `Use ${name}`,
        'Choose the quick-search engine; configure its key separately.',
        'search.engine',
        { name },
        'Search'
      )
    ),
    action(
      run,
      'search:on',
      'Enable quick search',
      'Make quick search available to the persona.',
      'search.enable',
      {},
      'Search'
    ),
    action(
      run,
      'search:off',
      'Disable quick search',
      'Deep search and page reading retain their own availability.',
      'search.disable',
      {},
      'Search'
    ),
    {
      id: 'search:model',
      label: 'Search model',
      detail: 'Set the model independently from the analyzer.',
      group: 'Search',
      prefill: '/search model ',
    },
  ];
}

/**
 * The model selector over the ordinary commands: its read is `/model sources`, its commit the checked `model.set`, and a
 * setup detour is the typed command it lists. Opening runs nothing.
 */
function modelPicker(run: Run): PickerEnv {
  return {
    registry: modelRoleRegistry(),
    async read(role) {
      const answer = await run({ name: 'model.sources', args: { role } });
      if (answer.status !== 'ok') throw new Error(answer.text);
      // The console's own JSON.stringify of a RoleSources, one link away.
      return JSON.parse(answer.text) as RoleSources;
    },
    commit: (command) => run(command),
    async setup(command) {
      const parsed = parseCommandLine(command);
      if (!parsed.ok) return { ok: false, text: parsed.reason };
      const answer = await run(parsed);
      return { ok: answer.status === 'ok', text: answer.text };
    },
  };
}

/**
 * The lines that wait for their turns. Each one is already said and in memory, so a row takes back its turn and leaves the
 * line. Its text cannot be edited: she may read it in the next turn's history whatever a row says.
 */
async function queuePanel(run: Run): Promise<Panel> {
  const answer = await run({ name: 'turn.queue', args: {} });
  if (answer.status !== 'ok') return { title: 'Queue', lines: [answer.text] };
  const queued = JSON.parse(answer.text) as Array<{ turnId: string; text: string }>;
  const rows = queued.map((one, index): PanelRow => ({
    id: one.turnId,
    label: `${index + 1}. ${one.text.split('\n')[0] ?? ''}`,
    detail: 'Enter cancels the turn over this line. The line stays said: memory holds it, and she can read it.',
    group: 'Queue',
    value: one.text,
    apply: () => run({ name: 'turn.remove', args: { turnId: one.turnId } }),
  }));
  return { title: 'Queue', lines: rows.length === 0 ? ['No line waits.'] : [], rows };
}

/** What a session command changes in the chat: the transcript it shows and the lines the core's history reads get. */
export type ChatView = {
  showLines: (lines: ReadonlyArray<SessionLineView & { nativeId?: string; number?: number }>) => void;
};

/** The sessions over the core's `session.*` commands. A resume or a branch shows its lines at once. */
function sessionClient(run: Run, view: ChatView): SessionClient {
  async function shown(answer: PanelResult, say: (name: string, count: number) => string): Promise<PanelResult> {
    if (answer.status !== 'ok') return answer;
    const { session, lines } = JSON.parse(answer.text) as {
      session: { name: string };
      lines: Array<SessionLineView & { nativeId?: string; number?: number }>;
    };
    view.showLines(lines);
    return Promise.resolve({ status: 'ok', text: say(session.name, lines.length) });
  }
  return {
    async list() {
      const answer = await run({ name: 'session.list', args: {} });
      if (answer.status !== 'ok') throw new Error(answer.text);
      return JSON.parse(answer.text) as Array<SessionRowView>;
    },
    async inspect(id) {
      const answer = await run({ name: 'session.inspect', args: { id } });
      if (answer.status !== 'ok') throw new Error(answer.text);
      return JSON.parse(answer.text) as Awaited<ReturnType<SessionClient['inspect']>>;
    },
    resume: async (id) =>
      shown(await run({ name: 'session.resume', args: { id } }), (name, count) => `Resumed ${name}: ${count} lines.`),
    branch: async (id, boundary) =>
      shown(
        await run({ name: 'session.branch', args: { from: id, boundary } }),
        (name, count) => `Branched ${name} at ${count} lines. Memory stays as it is.`
      ),
  };
}

/** `/checkpoints`, or `/checkpoints take <task>` for a checkpoint of a development task's worktree. */
async function checkpointsPanel(line: string, run: Run): Promise<Panel> {
  const [, word, task] = line.split(/\s+/);
  if (word === 'take') {
    const taken = await run({ name: 'checkpoint.take', args: { task: task ?? '' } });
    return { title: 'Checkpoints', lines: [taken.text] };
  }
  const answer = await run({ name: 'checkpoint.list', args: {} });
  if (answer.status !== 'ok') return { title: 'Checkpoints', lines: [answer.text], rows: [] };
  const { capability, points } = JSON.parse(answer.text) as {
    capability: Parameters<typeof checkpointPanel>[0];
    points: Array<Omit<CheckpointPoint, 'restore'> & { taskId: string }>;
  };
  return checkpointPanel(
    capability,
    points.map((point) => ({
      ...point,
      restore: (id) => run({ name: 'checkpoint.restore', args: { task: point.taskId, id, revision: point.revision } }),
    }))
  );
}

/** The session `/branch` cuts: the one it names, else the one the chat is in. */
async function branchPanel(line: string, client: SessionClient, run: Run): Promise<Panel> {
  const named = line.split(/\s+/)[1];
  if (named !== undefined) return boundaryPanel(client, named);
  const current = await run({ name: 'session.current', args: {} });
  const session = current.status === 'ok' ? (JSON.parse(current.text) as { id: string } | null) : null;
  return session === null
    ? { title: 'Branch', lines: ['No chat is stored yet.'], rows: [] }
    : boundaryPanel(client, session.id);
}

/** `/approvals`: the gate it names or the one that waits, or a row per gate when several wait. */
async function approvalsPanel(line: string, run: Run): Promise<Panel> {
  const answer = await run({ name: 'approval.list', args: {} });
  if (answer.status !== 'ok') return { title: 'Approvals', lines: [answer.text], rows: [] };
  const gates = JSON.parse(answer.text) as Array<GateView>;
  const named = line.split(/\s+/)[1];
  const chosen = named === undefined && gates.length === 1 ? gates[0] : gates.find((one) => one.taskId === named);
  if (chosen !== undefined)
    return approvalPanel(chosen, { respond: (given) => run({ name: 'approval.answer', args: given }) });
  if (named !== undefined) return { title: 'Approvals', lines: [`No gate waits on ${named}.`], rows: [] };
  if (gates.length === 0) return { title: 'Approvals', lines: ['Nothing waits for your approval.'], rows: [] };
  const rows = gates.map((gate): PanelRow => ({
    id: gate.taskId,
    label: `${gate.scope} ${gate.taskId}`,
    detail: gate.title,
    group: 'Gates',
    prefill: `/approvals ${gate.taskId}`,
  }));
  return { title: 'Approvals', lines: [], rows };
}

/** What each menu reads and which command its actions belong to. A family with no operation has neither. */
const CAPABILITY_MENUS = {
  tools: { title: 'Tools', command: 'tools', list: 'tools.list' },
  skills: { title: 'Skills', command: 'skills', list: 'skills.list' },
  interfaces: { title: 'Interfaces', command: 'interfaces', list: 'interfaces.list' },
  agent: { title: 'Agents', command: 'agent', list: null },
  plugins: { title: 'Plugins', command: null, list: null },
} as const;

/**
 * A menu over the command table: its text is the family's own list operation and its rows are the table's subcommands, each
 * prefilling its typed command. Opening one runs that read alone, and no row acts by itself.
 */
export async function capabilityPanel(kind: keyof typeof CAPABILITY_MENUS, run: Run): Promise<Panel> {
  const { title, command, list } = CAPABILITY_MENUS[kind];
  if (command === null)
    return {
      title,
      lines: ['No operation installs or activates a plugin, so this menu has nothing to act on.'],
      rows: [],
    };
  const read = list === null ? null : await run({ name: list, args: {} });
  if (read !== null && read.status !== 'ok') return { title, lines: read.text.split('\n'), rows: [] };
  const found = COMMANDS.find((one) => one.name === command);
  const rows = (found?.subcommands ?? [])
    .filter((one) => one.name !== 'list')
    .map((one): PanelRow => {
      const words = one.name.replaceAll('.', ' ');
      return { id: one.name, label: words, detail: one.help, group: title, prefill: `/${command} ${words} ` };
    });
  return { title, lines: read === null ? [found?.help ?? title] : read.text.split('\n'), rows };
}

/** The last line of `/status full`: the numbers the core holds of a request, an absent one named as unknown. */
async function contextOf(run: Run): Promise<string> {
  const answer = await run({ name: 'context.read', args: {} });
  return answer.status === 'ok' ? contextLine(JSON.parse(answer.text) as ContextFacts) : answer.text;
}

/** A row of a memory panel: what it names, and the command that opens it. */
const memoryRow = (id: string, label: string, detail: string, prefill: string): PanelRow => ({
  id,
  label,
  detail,
  group: 'Memory',
  prefill,
});

/** The command that opens one row of `table` by its id, for what has no detail of its own. */
const rowById = (table: string, id: string): string =>
  `/memory inspect rows ${table} --filters ${JSON.stringify([{ column: 'id', value: { kind: 'text', value: id } }])}`;

type MemoryPage = { items: Array<Record<string, unknown>>; total: number | null };
const countLine = ({ items, total }: MemoryPage): string =>
  total !== null && total > items.length ? `${items.length} of ${total}` : `${items.length}`;
const asText = (value: unknown): string => (typeof value === 'string' ? value : '');
const namesOf = (value: unknown): string => (Array.isArray(value) ? value.map(asText).join(', ') : '');

function userRow(item: Record<string, unknown>): PanelRow {
  const id = asText(item.id);
  if (item.kind === 'person') return memoryRow(id, id, `person: ${namesOf(item.names)}`, `/memory users show ${id}`);
  if (item.kind === 'account')
    return memoryRow(id, id, `unlinked account: ${namesOf(item.names)}`, rowById('accounts', id));
  return memoryRow(id, id, `anonymous participant: ${asText(item.display)}`, rowById('participants', id));
}

const placeRow = (item: Record<string, unknown>): PanelRow => {
  const id = asText(item.id);
  return memoryRow(
    id,
    id,
    `${asText(item.name)}, ${String(item.childCount)} directly under it`,
    `/memory places tree ${id}`
  );
};

const entityRow = (item: Record<string, unknown>): PanelRow => {
  const id = asText(item.id);
  const names = Array.isArray(item.names)
    ? item.names.map((one: unknown) =>
        one !== null && typeof one === 'object' && 'text' in one ? asText(one.text) : ''
      )
    : [];
  return memoryRow(id, id, `${asText(item.kind)}: ${names.join(', ')}`, `/memory entities show ${id}`);
};

/** The bare memory browsers: one panel over the reads a script gets, each row prefilling the command that opens it. */
const MEMORY_PANELS: Readonly<Record<string, (run: Run) => Promise<Panel>>> = {
  '/memory users': (run) => memoryPagePanel(run, 'People', 'memory.users.list', {}, userRow),
  '/memory places': (run) => memoryPagePanel(run, 'Places', 'memory.places.list', { roots: 'true' }, placeRow),
  '/memory entities': (run) => memoryPagePanel(run, 'Entities', 'memory.entities.list', {}, entityRow),
  '/memory graph': async (run) => {
    const answer = await run({ name: 'memory.graph.kinds', args: {} });
    if (answer.status !== 'ok') return { title: 'Graph', lines: [answer.text] };
    const { kinds } = JSON.parse(answer.text) as {
      kinds: Array<{ kind: string; state: string; reason: string | null; nodes: number }>;
    };
    return {
      title: 'Graph',
      lines: ['/memory graph edges, node, neighbors, walk and path read on from a node.'],
      rows: kinds.map((one) =>
        memoryRow(
          one.kind,
          one.kind,
          one.state === 'deferred' ? `deferred: ${one.reason ?? ''}` : `${one.nodes} nodes`,
          `/memory graph nodes --kinds ${one.kind}`
        )
      ),
    };
  },
  '/memory inspect': async (run) => {
    const answer = await run({ name: 'memory.inspect.tables', args: {} });
    if (answer.status !== 'ok') return { title: 'Storage', lines: [answer.text] };
    const { snapshot, catalog } = JSON.parse(answer.text) as {
      snapshot: string;
      catalog: { tables: Array<{ name: string; kind: string; storageClass: string }> };
    };
    return {
      title: 'Storage',
      lines: [`Snapshot ${snapshot}: ${catalog.tables.length} tables, one moment.`],
      rows: catalog.tables.map((table) =>
        memoryRow(
          table.name,
          table.name,
          `${table.storageClass}, ${table.kind}`,
          `/memory inspect rows ${table.name} --snapshot ${snapshot}`
        )
      ),
    };
  },
};

async function memoryPagePanel(
  run: Run,
  title: string,
  name: string,
  args: Record<string, unknown>,
  rowOf: (item: Record<string, unknown>) => PanelRow
): Promise<Panel> {
  const answer = await run({ name, args });
  if (answer.status !== 'ok') return { title, lines: [answer.text] };
  const page = JSON.parse(answer.text) as MemoryPage;
  return {
    title,
    lines: [`${countLine(page)} on this page; ${name.replaceAll('.', ' ')} --cursor reads on.`],
    rows: page.items.map(rowOf),
  };
}

/** The panel of a line of the chat's own, or null for any other line. */
async function localPanel(line: string, run: Run, view: ChatView): Promise<Panel | null> {
  const word = line.split(/\s+/)[0];
  const client = sessionClient(run, view);
  if (line === '/sessions') return sessionsPanel(client);
  if (line.startsWith('/sessions resume ')) {
    const answer = await client.resume(line.slice('/sessions resume '.length).trim());
    return { title: 'Sessions', lines: [answer.text] };
  }
  if (word === '/branch') return branchPanel(line, client, run);
  if (word === '/checkpoints') return checkpointsPanel(line, run);
  if (word === '/approvals') return approvalsPanel(line, run);
  const memory = MEMORY_PANELS[line];
  if (memory !== undefined) return memory(run);
  if (line === '/tools' || line === '/skills' || line === '/interfaces' || line === '/agent' || line === '/plugins')
    return capabilityPanel(line.slice(1) as keyof typeof CAPABILITY_MENUS, run);
  return null;
}

/** A local presentation for a supported command, or null so the caller uses the normal command path. */
export async function chatPanel(
  line: string,
  run: Run,
  interfaces: ReadonlyArray<string> = ['discord'],
  view: ChatView = { showLines: () => {} }
): Promise<Panel | null> {
  const local = await localPanel(line, run, view);
  if (local !== null) return local;
  if (line === '/setup') return { title: 'Setup', lines: [], rows: setupRows(run, interfaces) };
  // Only the bare line: `/model show` and `/model set ...` stay commands, and the same word in a shell stays `show`.
  if (line === '/model') return { title: 'Model', lines: [], picker: modelPicker(run) };
  if (line === '/queue') return queuePanel(run);
  const parsed = parseCommandLine(line);
  if (!parsed.ok) return null;
  if (parsed.name === 'config.show') {
    const result = await run(parsed);
    if (result.status !== 'ok') return { title: 'Config', lines: [result.text] };
    let overrides: Record<string, unknown> = {};
    if (result.text.trim().startsWith('{')) overrides = object(JSON.parse(result.text));
    const config = object(deepMerge(schemaDefaults(CONFIG_SCHEMA), overrides));
    return { title: 'Config', lines: [], rows: settingsRows(config, run) };
  }
  if (parsed.name === 'help') {
    const rows = COMMANDS.map((command): PanelRow => ({
      id: command.name,
      label: `/${command.name}`,
      detail: command.help,
      group: 'Commands',
      prefill: `/${command.name} `,
    }));
    return {
      title: 'Help',
      lines: [],
      rows: [
        {
          id: 'setup',
          label: '/setup',
          detail: 'Connect services, interfaces and skills.',
          group: 'Commands',
          prefill: '/setup',
        },
        ...rows,
      ],
    };
  }
  if (parsed.name === 'status' || parsed.name === 'status.full') {
    const result = await run(parsed);
    const lines = result.text.split('\n');
    return { title: 'Status', lines: parsed.name === 'status.full' ? [...lines, '', await contextOf(run)] : lines };
  }
  return null;
}
