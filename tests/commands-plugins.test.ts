// `/plugins` (src/interface/commands/table.ts, src/interface/commands/plugins.ts): the rows of the command table and
// the answers of the command over a control the test fills with fixed views.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCommandLine } from '../src/interface/commands/table.ts';
import { pluginsCommand } from '../src/interface/commands/plugins.ts';
import type { Change, PluginControl, PluginView, SetupView } from '../src/plugins/control.ts';
import type { PluginProblem } from '../src/plugins/folders.ts';

const ECHO: PluginView = {
  name: 'echo',
  layer: 'local',
  description: 'Says back.',
  enabled: true,
  connected: true,
  tools: ['echo.say'],
};

function control(
  options: {
    views?: Array<PluginView>;
    problems?: Array<PluginProblem>;
    change?: Change;
    setup?: SetupView | null;
  } = {}
): PluginControl {
  const change = options.change ?? { ok: true, changed: true };
  return {
    list: () => options.views ?? [ECHO],
    problems: () => options.problems ?? [],
    enable: () => Promise.resolve(change),
    disable: () => Promise.resolve(change),
    setup: () => options.setup ?? null,
  };
}

test('the table parses the four /plugins rows, and a bare /plugins is the list', () => {
  assert.deepEqual(parseCommandLine('/plugins'), { ok: true, name: 'plugins.list', args: {} });
  assert.deepEqual(parseCommandLine('/plugins list'), { ok: true, name: 'plugins.list', args: {} });
  assert.deepEqual(parseCommandLine('/plugins enable echo'), {
    ok: true,
    name: 'plugins.enable',
    args: { name: 'echo' },
  });
  assert.deepEqual(parseCommandLine('/plugins disable echo'), {
    ok: true,
    name: 'plugins.disable',
    args: { name: 'echo' },
  });
  assert.deepEqual(parseCommandLine('/plugins setup echo'), {
    ok: true,
    name: 'plugins.setup',
    args: { name: 'echo' },
  });
});

test('the table refuses enable without a name and a subcommand it does not have', () => {
  assert.equal(parseCommandLine('/plugins enable').ok, false);
  assert.equal(parseCommandLine('/plugins install echo').ok, false);
});

test('list prints a row per plugin with its switch, its link and its tools', async () => {
  const idle: PluginView = { ...ECHO, name: 'quiet', enabled: false, connected: false, tools: [] };
  const answer = await pluginsCommand(control({ views: [ECHO, idle] }), 'plugins.list', {});
  assert.equal(answer.status, 'ok');
  assert.deepEqual(answer.text.split('\n'), [
    'echo  enabled  connected  tools: echo.say',
    'quiet  disabled  not connected  tools: none',
  ]);
});

test('list names the folders the loader refused, and says so when no plugin is installed', async () => {
  const refused = await pluginsCommand(
    control({ views: [], problems: [{ dir: 'broken', code: 'not-json' }] }),
    'plugins.list',
    {}
  );
  assert.deepEqual(refused.text.split('\n'), ['no plugin installed', 'refused: broken (not-json)']);
});

test('enable and disable say what changed, and what was already so', async () => {
  const on = await pluginsCommand(control(), 'plugins.enable', { name: 'echo' });
  assert.deepEqual(on, { text: 'echo is on', status: 'ok' });
  const already = await pluginsCommand(control({ change: { ok: true, changed: false } }), 'plugins.disable', {
    name: 'echo',
  });
  assert.deepEqual(already, { text: 'echo was already off', status: 'ok' });
});

test('a refused enable answers failed with the command as typed and the reason', async () => {
  const unknown = await pluginsCommand(control({ change: { ok: false, code: 'unknown-plugin' } }), 'plugins.enable', {
    name: 'nope',
  });
  assert.deepEqual(unknown, { text: '/plugins enable nope: no plugin named nope', status: 'failed' });
  const unit = await pluginsCommand(control({ change: { ok: false, code: 'unit-failed' } }), 'plugins.enable', {
    name: 'echo',
  });
  assert.deepEqual(unit, { text: '/plugins enable echo: its unit did not start', status: 'failed' });
});

test('setup prints one line per env key, and a plugin that needs none says so', async () => {
  const setup: SetupView = { name: 'echo', env: [{ key: 'ECHO_PREFIX', state: 'missing' }] };
  assert.deepEqual(await pluginsCommand(control({ setup }), 'plugins.setup', { name: 'echo' }), {
    text: 'ECHO_PREFIX: missing',
    status: 'ok',
  });
  const none = await pluginsCommand(control({ setup: { name: 'echo', env: [] } }), 'plugins.setup', { name: 'echo' });
  assert.deepEqual(none, { text: 'no env key needed', status: 'ok' });
});

test('setup of an unknown plugin and any command without a control answer failed', async () => {
  assert.deepEqual(await pluginsCommand(control(), 'plugins.setup', { name: 'nope' }), {
    text: '/plugins setup nope: no plugin named nope',
    status: 'failed',
  });
  assert.deepEqual(await pluginsCommand(null, 'plugins.list', {}), {
    text: '/plugins list: plugins are not available here',
    status: 'failed',
  });
});

test('a refused enable in process mode names the setting that fixes it', async () => {
  const refused = await pluginsCommand(control({ change: { ok: false, code: 'inprocess-mode' } }), 'plugins.enable', {
    name: 'echo',
  });
  assert.deepEqual(refused, { text: '/plugins enable echo: plugins need interfaces.mode: units', status: 'failed' });
});
