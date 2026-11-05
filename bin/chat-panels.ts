// Builds the owner chat's panels from the command table and settings schema. Every action delegates to the same
// command handler as a typed command. Opening setup does no installation, authentication or provider probe.
import { CONFIG_SCHEMA, schemaDefaults } from '../src/config/schema.ts';
import { deepMerge } from '../src/config.ts';
import { COMMANDS, parseCommandLine } from '../src/interface/commands/table.ts';
import type { Panel, PanelResult, PanelRow } from '../cli/panel.ts';
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
        'interface.setup',
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
        'interface.enable',
        { name },
        'Interfaces'
      ),
      action(
        run,
        `disable:${name}`,
        `Disable ${name}`,
        'Keep its settings and stored memories.',
        'interface.disable',
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
      detail: 'Select a role and model with the targeted model command.',
      group: 'Models',
      prefill: '/model set ',
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

/** A local presentation for a supported command, or null so the caller uses the normal command path. */
export async function chatPanel(
  line: string,
  run: Run,
  interfaces: ReadonlyArray<string> = ['discord']
): Promise<Panel | null> {
  if (line === '/setup') return { title: 'Setup', lines: [], rows: setupRows(run, interfaces) };
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
