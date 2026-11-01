// The test plugin: the package contract of a plugin (`start(host)`, src/protocol/plugin.ts) with the smallest tool
// there is. `echo.say` answers the text it was given behind a prefix, `ECHO_PREFIX` from the environment or `echo: `.
// It keeps no state. The folder is copied into a test's `plugins.local/` and run with `neptunia plugin run echo`, so
// nothing here imports a module at run time: the types below are erased.
import type { PluginHost, RunningPlugin, ToolCallBody } from '../../../../src/protocol/plugin.ts';

const DEFAULT_PREFIX = 'echo: ';

export async function start(host: PluginHost): Promise<RunningPlugin> {
  const prefix = host.env.ECHO_PREFIX ?? DEFAULT_PREFIX;
  const served = await host.serve((call: ToolCallBody) => ({
    status: 'ok',
    data: { text: `${prefix}${typeof call.args.text === 'string' ? call.args.text : ''}` },
  }));
  return { stop: () => served.stop() };
}
