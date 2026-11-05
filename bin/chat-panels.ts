// Builds the owner chat's panels from the command table and settings schema. Every action delegates to the same
// command handler as a typed command. Opening setup does no installation, authentication or provider probe.
import { CONFIG_SCHEMA, schemaDefaults } from '../src/config/schema.ts';
import { deepMerge } from '../src/config.ts';
import { COMMANDS, parseCommandLine } from '../src/interface/commands/table.ts';
import type { Panel, PanelResult, PanelRow } from '../cli/panel.ts';
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
    ...['youtube', 'brave', 'exa', 'videoProxy'].map((name) =>
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

/** The lines that wait behind her running turn: a row edits its line, and an empty line takes it out. */
async function queuePanel(run: Run): Promise<Panel> {
  const answer = await run({ name: 'turn.queue', args: {} });
  if (answer.status !== 'ok') return { title: 'Queue', lines: [answer.text] };
  const queued = JSON.parse(answer.text) as Array<{ turnId: string; text: string }>;
  const rows = queued.map((one, index): PanelRow => ({
    id: one.turnId,
    label: `${index + 1}. ${one.text.split('\n')[0] ?? ''}`,
    detail: 'Enter edits this line before its turn starts. An empty line takes it out of the queue.',
    group: 'Queue',
    value: one.text,
    edit: { kind: 'text', value: one.text },
    apply: (next) =>
      next.trim() === ''
        ? run({ name: 'turn.remove', args: { turnId: one.turnId } })
        : run({ name: 'turn.edit', args: { turnId: one.turnId, text: next } }),
  }));
  return { title: 'Queue', lines: rows.length === 0 ? ['No line waits.'] : [], rows };
}

/** What a session command changes in the chat: the transcript it shows and the lines the core's history reads get. */
export type ChatView = { showLines: (lines: ReadonlyArray<SessionLineView & { nativeId?: string }>) => void };

/** The sessions over the core's `session.*` commands. A resume or a branch shows its lines at once. */
function sessionClient(run: Run, view: ChatView): SessionClient {
  async function shown(answer: PanelResult, say: (name: string, count: number) => string): Promise<PanelResult> {
    if (answer.status !== 'ok') return answer;
    const { session, lines } = JSON.parse(answer.text) as {
      session: { name: string };
      lines: Array<SessionLineView & { nativeId?: string }>;
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
    ? { title: 'Branch', lines: ['No conversation is stored yet.'], rows: [] }
    : boundaryPanel(client, session.id);
}

/** The panel of a line of the chat's own, or null for any other line. */
async function localPanel(line: string, run: Run, view: ChatView): Promise<Panel | null> {
  const word = line.split(/\s+/)[0];
  const client = sessionClient(run, view);
  if (line === '/sessions') return sessionsPanel(client);
  if (word === '/branch') return branchPanel(line, client, run);
  if (word === '/checkpoints') return checkpointsPanel(line, run);
  // Bare `/resume` stays the command that ends a pause: only a session's id makes this one.
  if (word === '/resume' && line !== word) {
    const answer = await client.resume(line.slice(word.length).trim());
    return { title: 'Sessions', lines: [answer.text] };
  }
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
    return { title: 'Status', lines: result.text.split('\n') };
  }
  return null;
}
