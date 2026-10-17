// Tests for src/agent-runner/profiles.js: the generated OpenCode config (the
// V1 shape of release v1.19.3) for each profile -- the agent's prompt, step
// cap, model and cost, the permission map (deny-all first, then the profile's
// allows), the bash allow-list order (catch-all deny first, specifics after,
// so the last match wins), the withheld-path denies added only in a
// filtered scope (the path tools' globs and the server shell's per-command
// patterns, checked through a copy of OpenCode's wildcard and last-match
// rule), each profile's model role, and where its system-prompt files are
// (the override under the private directory). Pure but for reading
// config.json and a temporary directory.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readPromptFile } from '../src/agent-runner/opencode.js';
import { onLog } from '../src/log.js';
import { WEB, SERVER, profileOf, promptFilesOf, SERVER_SHELL_ALLOW, SHELL_CONTENT_COMMANDS, SHELL_DENY_AFTER, withheldShellDenies } from '../src/agent-runner/profiles.js';
import { WITHHELD_NAMES, WITHHELD_ROOTS, withheldRootsOf } from '../src/agent-runner/policy.js';
import { ROLE_DEFAULTS } from '../src/llm/roles.js';
import { resolvePaths } from '../src/paths.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** This checkout's data directory as the policy resolves it (NEPTUNIA_DATA_DIR, else <root>/data). */
const DATA_DIR = resolvePaths({ rootDir: ROOT }).dataDir;

test('profileOf: web, server, and nothing else', () => {
  assert.equal(profileOf('web'), WEB);
  assert.equal(profileOf('server'), SERVER);
  assert.equal(profileOf('nope'), null);
});

test('web config: agent prompt, model, cost, step cap, search absent from config', () => {
  const cfg = WEB.buildConfig({ systemPrompt: 'be careful', providerModel: 'openrouter/x-ai/grok-4.7', steps: 25, scope: 'core', cost: { input: 2, output: 6 }, toolResultChars: 6000 });
  assert.equal(cfg.model, 'openrouter/x-ai/grok-4.7');
  const agent = cfg.agent['errand-web'];
  assert.equal(agent.prompt, 'be careful');
  assert.equal(agent.steps, 25);
  assert.equal(agent.mode, 'primary');
  assert.deepEqual(cfg.provider.openrouter.models['x-ai/grok-4.7'].cost, { input: 2, output: 6 });
  assert.equal(cfg.tool_output.max_bytes, 6000);
  assert.equal(cfg.websearch, undefined, 'v1.19.3 has no websearch config key');
});

test('web permission: web tools allowed, edit/write/task/question denied, bash allow-list', () => {
  const p = WEB.buildConfig({ systemPrompt: 'x', scope: 'core' }).agent['errand-web'].permission;
  assert.equal(p.websearch, 'allow');
  assert.equal(p.webfetch, 'allow');
  assert.equal(p.read, 'allow');
  assert.equal(p.edit, 'deny');
  assert.equal(p.write, 'deny');
  assert.equal(p.task, 'deny');
  assert.equal(p.question, 'deny');
  assert.equal(p.external_directory, 'deny');
  // bash: the catch-all deny is first so a specific allow (last match) wins
  const keys = Object.keys(p.bash);
  assert.equal(keys[0], '*');
  assert.equal(p.bash['*'], 'deny');
  assert.equal(p.bash['curl *'], 'allow');
  // the denies that must beat an allow come last
  assert.equal(keys[keys.length - 1], 'gawk *');
  assert.equal(p.bash['find * -exec*'], 'deny');
  assert.equal(p.bash['awk */inet/*'], 'deny');
});

test('server permission: read tools allowed, no network tools, read-only bash', () => {
  const p = SERVER.buildConfig({ systemPrompt: 'x', scope: 'core' }).agent['errand-server'].permission;
  assert.equal(p.read, 'allow');
  assert.equal(p.grep, 'allow');
  assert.equal(p.list, 'allow');
  assert.equal(p.webfetch, 'deny');
  assert.equal(p.websearch, 'deny');
  assert.equal(p.bash['*'], 'deny');
  assert.equal(p.bash['cat *'], 'allow');
  assert.equal(p.bash['systemctl status *'], 'allow');
  assert.equal(p.bash.rm, undefined);
  // every allow-listed command is present
  for (const cmd of SERVER_SHELL_ALLOW) assert.equal(p.bash[cmd], 'allow', cmd);
});

test('filtered scope: path tools gain withheld denies, core does not', () => {
  const core = SERVER.buildConfig({ systemPrompt: 'x', scope: 'core' }).agent['errand-server'].permission;
  assert.equal(core.read, 'allow');
  const dm = SERVER.buildConfig({ systemPrompt: 'x', scope: 'dm' }).agent['errand-server'].permission;
  assert.equal(typeof dm.read, 'object');
  // allow first, then the denies (last match wins -> a withheld path is denied)
  const keys = Object.keys(dm.read);
  assert.equal(keys[0], '*');
  assert.equal(dm.read['*'], 'allow');
  assert.equal(dm.read['/var/www'], 'deny');
  assert.equal(dm.read['**/.env'], 'deny');
});

test('defaults: limits, daily, model, env names', () => {
  assert.deepEqual(WEB.defaultLimits, { steps: 25, usd: 0.5, seconds: 300 });
  assert.deepEqual(SERVER.defaultLimits, { steps: 20, usd: 0.2, seconds: 120 });
  assert.deepEqual(WEB.defaultDaily, { tasks: 40, usd: 8 });
  assert.ok(WEB.envNames.includes('OPENROUTER_AGENT_KEY'));
  assert.ok(WEB.envNames.includes('PROXY_URL'));
  assert.deepEqual([...SERVER.envNames], ['OPENROUTER_AGENT_KEY']);
  assert.equal(WEB.defaultSearchProvider, 'exa');
});

test('model: each profile runs on its model role, whose default is its default model; config.json carries no agents.<profile>.model', () => {
  assert.equal(WEB.modelRole, 'agent.web');
  assert.equal(SERVER.modelRole, 'agent.server');
  assert.equal(WEB.defaultModel, ROLE_DEFAULTS['agent.web']);
  assert.equal(SERVER.defaultModel, ROLE_DEFAULTS['agent.server']);
  const shipped = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8')).agents;
  for (const name of ['web', 'server']) {
    assert.equal(Object.hasOwn(shipped[name], 'model'), false, `${name}: the model is roles.${profileOf(name).modelRole}`);
    assert.deepEqual(shipped[name].cost, { input: 2, output: 6 }, `${name}: the cost stays (OpenCode's price table is off)`);
  }
});

test('promptFilesOf: the override is read from NEPTUNIA_PRIVATE_DIR, the tracked prompt from the root; the profiles use it', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-profiles-'));
  try {
    const rootDir = path.join(base, 'checkout');
    const privateDir = path.join(base, 'private');
    const write = (file, text) => {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, text);
    };
    write(path.join(rootDir, 'prompts', 'agent-web.md'), 'tracked');
    write(path.join(rootDir, 'prompts.local', 'agent-web.md'), 'checkout override');
    write(path.join(privateDir, 'prompts.local', 'agent-web.md'), 'private override');

    const apart = promptFilesOf('web', { rootDir, env: { NEPTUNIA_PRIVATE_DIR: privateDir } });
    assert.deepEqual(apart, [path.join(privateDir, 'prompts.local', 'agent-web.md'), path.join(rootDir, 'prompts', 'agent-web.md')]);
    assert.equal(readPromptFile(apart), 'private override', 'the checkout prompts.local/ is not read');
    assert.equal(readPromptFile(promptFilesOf('web', { rootDir, env: {} })), 'checkout override', 'unset: the root is the private directory');
    fs.rmSync(path.join(privateDir, 'prompts.local', 'agent-web.md'));
    assert.equal(readPromptFile(apart), 'tracked', 'no override: the tracked prompt under the root');

    assert.deepEqual(WEB.promptFiles, promptFilesOf('web'));
    assert.deepEqual(SERVER.promptFiles, promptFilesOf('server'));
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('readPromptFile: an override that exists but cannot be read falls back to the tracked prompt, warned once; other errors still throw', () => {
  const [override, tracked] = promptFilesOf('web', { rootDir: '/checkout', env: { NEPTUNIA_PRIVATE_DIR: '/private-unreadable' } });
  const failing = (code) => (file) => {
    if (file === override) throw Object.assign(new Error(`${code}: ${file}`), { code });
    if (file === tracked) return 'tracked';
    throw Object.assign(new Error(`ENOENT: ${file}`), { code: 'ENOENT' });
  };
  const seen = [];
  const off = onLog((entry) => seen.push(entry));
  try {
    assert.equal(readPromptFile([override, tracked], { read: failing('EACCES') }), 'tracked');
    assert.equal(readPromptFile([override, tracked], { read: failing('EACCES') }), 'tracked', 'every task falls back');
    assert.equal(readPromptFile([override, tracked], { read: failing('EPERM') }), 'tracked');
    const warns = seen.filter((entry) => entry.msg === 'profiles: override unreadable');
    assert.equal(warns.length, 1, 'one warning per process, not per task');
    assert.equal(warns[0].level, 'warn');
    assert.equal(warns[0].file, override);
    assert.throws(() => readPromptFile([override, tracked], { read: failing('EISDIR') }), { code: 'EISDIR' }, 'any other error still fails');
    const trackedDenied = (file) => {
      if (file === override) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
    };
    assert.throws(() => readPromptFile([override, tracked], { read: trackedDenied }), { code: 'EACCES' }, 'the tracked prompt itself unreadable still fails');
  } finally {
    off();
  }
});

/** OpenCode's wildcard match (packages/core/src/util/wildcard.ts, v1.19.3): `*` any text, `?` one character. */
function wildcard(input, pattern) {
  let escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  if (escaped.endsWith(' .*')) escaped = `${escaped.slice(0, -3)}( .*)?`;
  return new RegExp(`^${escaped}$`, 's').test(input);
}

/** The action a permission map gives `command`: the last matching pattern's (OpenCode's rule). */
function actionOf(map, command) {
  let action = null;
  for (const [pattern, value] of Object.entries(map)) if (wildcard(command, pattern)) action = value;
  return action;
}

test('withheldShellDenies: one pattern per content command and withheld root, name or .env form, generated', () => {
  const denies = withheldShellDenies();
  const parts = [...WITHHELD_ROOTS, ...WITHHELD_NAMES, '.env'];
  assert.equal(denies.length, SHELL_CONTENT_COMMANDS.length * parts.length);
  assert.deepEqual([...SHELL_CONTENT_COMMANDS], ['cat', 'head', 'tail', 'grep', 'egrep', 'fgrep', 'sed', 'awk', 'cut', 'sort', 'uniq', 'wc', 'file', 'git']);
  for (const pattern of ['cat */var/www*', 'cat *.ssh*', 'cat *.env*', 'cat *config.local.json*', 'git */srv/git*', `sed *${DATA_DIR}*`, 'wc *.secrets*']) assert.ok(denies.includes(pattern), pattern);
  for (const listing of ['ls', 'find', 'stat', 'du', 'readlink', 'realpath']) assert.ok(!denies.some((pattern) => pattern.startsWith(`${listing} `)), `${listing} stays allowed`);
});

test('withheldShellDenies: the deployment\'s data directory and a private directory apart from the checkout come from `paths`', () => {
  const apart = withheldShellDenies({ paths: resolvePaths({ rootDir: '/srv/app', env: { NEPTUNIA_PRIVATE_DIR: '/srv/site/etc', NEPTUNIA_DATA_DIR: '/srv/site/data' } }) });
  for (const pattern of ['cat */srv/site/data*', 'grep */srv/site/etc*', 'cat */etc/neptunia*']) assert.ok(apart.includes(pattern), pattern);
  assert.ok(!apart.some((pattern) => pattern.includes('/srv/app')), 'the checkout itself is not withheld');
  const together = withheldShellDenies({ paths: resolvePaths({ rootDir: '/srv/app', env: {} }) });
  assert.ok(together.includes('cat */srv/app/data*'), 'default: <root>/data');
  assert.ok(!together.includes('cat */srv/app*'), 'a private directory that is the checkout is not withheld whole');
  const roots = withheldRootsOf({ paths: resolvePaths({ rootDir: '/srv/app', env: {} }) });
  assert.equal(together.length, SHELL_CONTENT_COMMANDS.length * (roots.length + WITHHELD_NAMES.length + 1));
});

test('filtered scope: the server shell denies a content read of a withheld path after the allows and before SHELL_DENY_AFTER; core and web get none', () => {
  const dm = SERVER.buildConfig({ systemPrompt: 'x', scope: 'dm' }).agent['errand-server'].permission.bash;
  const keys = Object.keys(dm);
  const denies = withheldShellDenies();
  const firstDeny = keys.indexOf(denies[0]);
  assert.ok(firstDeny > keys.indexOf(SERVER_SHELL_ALLOW.at(-1)), 'after the last allow');
  assert.deepEqual(keys.slice(firstDeny, firstDeny + denies.length), denies, 'in one block');
  assert.deepEqual(keys.slice(-SHELL_DENY_AFTER.length), [...SHELL_DENY_AFTER], 'SHELL_DENY_AFTER still last');
  for (const pattern of denies) assert.equal(dm[pattern], 'deny', pattern);
  const group = SERVER.buildConfig({ systemPrompt: 'x', scope: 'group' }).agent['errand-server'].permission.bash;
  assert.deepEqual(group, dm);
  const core = SERVER.buildConfig({ systemPrompt: 'x', scope: 'core' }).agent['errand-server'].permission.bash;
  assert.equal(Object.hasOwn(core, 'cat */var/www*'), false, 'core reads everything');
  const web = WEB.buildConfig({ systemPrompt: 'x', scope: 'dm' }).agent['errand-web'].permission.bash;
  assert.equal(Object.hasOwn(web, 'cat */var/www*'), false, 'the web agent has its own shell');
});

test('filtered scope: under OpenCode\'s last-match rule a read of a withheld path is refused, a listing of it and any other read pass', () => {
  const dm = SERVER.buildConfig({ systemPrompt: 'x', scope: 'dm' }).agent['errand-server'].permission.bash;
  const core = SERVER.buildConfig({ systemPrompt: 'x', scope: 'core' }).agent['errand-server'].permission.bash;
  const refused = [
    'cat /var/www/site/index.php', 'head -n 5 /home/u/.ssh/authorized_keys', 'tail /srv/app/.env', 'grep -r token /srv/app/.env.local',
    'sed -n 1p /srv/neptunia-dev/neptunia-core/config.local.json', 'awk 1 /etc/shadow', `wc -l ${DATA_DIR}/guilds/1/tasks.json`,
    'git log --stat /srv/git/core.git/hooks', 'file /srv/neptunia-dev/.secrets/proxy', 'sort /etc/letsencrypt/live/x/privkey.pem',
  ];
  for (const command of refused) {
    assert.equal(actionOf(dm, command), 'deny', `dm: ${command}`);
    assert.equal(actionOf(core, command), 'allow', `core: ${command}`);
  }
  for (const command of ['ls /var/www', 'ls -la /home/u/.ssh', 'find /var/www -name "*.php"', 'stat /srv/app/.env', 'du -sh /srv/git', 'readlink /srv/app/.env', 'realpath /var/www/site', 'cat /etc/hostname', 'grep -c ExecStart /etc/systemd/system/x.service', 'git log --oneline -5']) {
    assert.equal(actionOf(dm, command), 'allow', `dm: ${command}`);
  }
  assert.equal(actionOf(dm, 'find /var/www -exec cat {} ;'), 'deny', 'SHELL_DENY_AFTER still wins');
  assert.equal(actionOf(dm, 'rm -rf /tmp/x'), 'deny');
});
