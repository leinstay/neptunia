// The owner's `/plugins` commands: what the console (console.ts) runs for `plugins.list`, `enable`, `disable` and
// `setup`, over the plugin control the core hands it (src/plugins/control.ts). A refused change answers `failed` with
// the command as the owner typed it and the reason. The text is for the owner alone and never reaches a request.

import type { PluginControl } from '../../plugins/control.ts';

export type PluginsAnswer = { text: string; status: string };

/** The command as the owner typed it. */
const typedOf = (name: string, plugin: string): string =>
  `/${name.replaceAll('.', ' ')}${plugin === '' ? '' : ` ${plugin}`}`;

const failed = (name: string, plugin: string, why: string): PluginsAnswer => ({
  text: `${typedOf(name, plugin)}: ${why}`,
  status: 'failed',
});

const noPlugin = (name: string, plugin: string): PluginsAnswer => failed(name, plugin, `no plugin named ${plugin}`);

/** Runs the command `name` (`plugins.<sub>`) with its arguments; a missing control answers `failed`. */
export async function pluginsCommand(
  control: PluginControl | null | undefined,
  name: string,
  args: Readonly<Record<string, unknown>>
): Promise<PluginsAnswer> {
  const plugin = typeof args.name === 'string' ? args.name : '';
  if (control == null) return failed(name, plugin, 'plugins are not available here');
  switch (name) {
    case 'plugins.list': {
      const views = control.list();
      const rows = views.map(
        (view) =>
          `${view.name}  ${view.enabled ? 'enabled' : 'disabled'}  ${view.connected ? 'connected' : 'not connected'}  tools: ${view.tools.join(', ') || 'none'}`
      );
      const refused = control.problems().map((one) => `refused: ${one.dir} (${one.code})`);
      const lines = [...(rows.length === 0 ? ['no plugin installed'] : rows), ...refused];
      return { text: lines.join('\n'), status: 'ok' };
    }
    case 'plugins.enable':
    case 'plugins.disable': {
      const enabling = name === 'plugins.enable';
      const done = await (enabling ? control.enable(plugin) : control.disable(plugin));
      if (!done.ok) {
        if (done.code === 'unknown-plugin') return noPlugin(name, plugin);
        const why = done.code === 'inprocess-mode' ? 'plugins need interfaces.mode: units' : 'its unit did not start';
        return failed(name, plugin, why);
      }
      const state = enabling ? 'on' : 'off';
      return { text: done.changed ? `${plugin} is ${state}` : `${plugin} was already ${state}`, status: 'ok' };
    }
    case 'plugins.setup': {
      const view = control.setup(plugin);
      if (view === null) return noPlugin(name, plugin);
      const lines = view.env.map((one) => `${one.key}: ${one.state}`);
      return { text: lines.length === 0 ? 'no env key needed' : lines.join('\n'), status: 'ok' };
    }
    default:
      return failed(name, plugin, 'no such command; type /help');
  }
}
