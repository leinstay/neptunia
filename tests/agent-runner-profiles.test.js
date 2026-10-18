// Tests for src/agent-runner/profiles.js: the generated OpenCode config (the
// V1 shape of release v1.19.3) for each profile -- the agent's prompt, step
// cap, model and cost, the permission map (deny-all first, then the profile's
// allows), the bash allow-list order (catch-all deny first, specifics after,
// so the last match wins), the withheld-path denies added only in a
// filtered scope (the path tools' globs and the server shell's per-command
// patterns, checked through a copy of OpenCode's wildcard and last-match
// rule), each profile's model role, where its system-prompt files are
// (the override under the private directory, the tracked prompt in
// agents/<id>/), and the agents/ folder the profiles are built from: the
// real one, and temporary trees with a valid worker, an unknown tool, an
// unknown shell class, a missing key and a consultation the runner skips;
// the tools every agent is denied (skill, todowrite, ...) and the web
// agent's `web-search` command with its wrapper.
// Pure but for reading config.json, agents/ and a temporary directory.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readPromptFile } from '../src/agent-runner/opencode.js';
import { onLog } from '../src/log.js';
import { WEB, SERVER, PROFILES, ALWAYS_DENIED, AgentProfileError, SHELL_CLASSES, WEB_TOOLS_DIR, listAgents, loadProfiles, profileOf, promptFilesOf, SERVER_SHELL_ALLOW, SEGMENT_NAMES, SHELL_CONTENT_COMMANDS, SHELL_DENY_AFTER, WEB_SHELL_ALLOW, YT_DLP_DENIES, withheldShellDenies } from '../src/agent-runner/profiles.js';
import { WITHHELD_GLOBS, WITHHELD_NAMES, WITHHELD_ROOTS, withheldGlobsOf, withheldRootsOf } from '../src/agent-runner/policy.js';
import { ROLE_DEFAULTS } from '../src/llm/roles.js';
import { resolvePaths } from '../src/paths.js';
import { tempDir } from './fixtures/tmp.js';

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
  assert.equal(p.external_directory, 'deny', 'only the server class reaches outside its folder');
  const dm = WEB.buildConfig({ systemPrompt: 'x', scope: 'dm' }).agent['errand-web'].permission;
  assert.equal(dm.external_directory, 'deny');
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

test('every agent: skill, todowrite and the other tools no profile asks for are denied, in every scope', () => {
  for (const tool of ['skill', 'todowrite', 'lsp', 'plan_exit', 'execute', 'edit', 'write', 'patch', 'task', 'question']) assert.ok(ALWAYS_DENIED.includes(tool), tool);
  for (const profile of [WEB, SERVER]) {
    for (const scope of ['core', 'dm', 'group']) {
      const p = profile.buildConfig({ systemPrompt: 'x', scope }).agent[profile.agentId].permission;
      for (const tool of ALWAYS_DENIED) assert.equal(p[tool], 'deny', `${profile.name} ${scope} ${tool}`);
      assert.equal(p.skill, 'deny');
      assert.equal(p.todowrite, 'deny');
    }
  }
});

test('web shell: the web-search command runs, through the wrapper on the child\'s PATH; node itself never does', () => {
  const p = WEB.buildConfig({ systemPrompt: 'x', scope: 'core' }).agent['errand-web'].permission;
  assert.equal(p.bash['web-search *'], 'allow');
  for (const command of ['node *', 'node', 'web-search']) assert.equal(p.bash[command], undefined, command);
  assert.equal(actionOf(p.bash, 'web-search olé meme --count 4'), 'allow');
  assert.equal(actionOf(p.bash, 'node bin/agent-runner.mjs --profile web'), 'deny');
  assert.equal(actionOf(p.bash, 'NODE_OPTIONS=--import=./x.mjs web-search q'), 'deny', 'OpenCode matches the whole command text, assignments included');
  assert.deepEqual([...WEB.pathDirs], [WEB_TOOLS_DIR]);
  assert.equal(WEB_TOOLS_DIR, path.join(ROOT, 'agents', 'web', 'bin'));
  const wrapper = path.join(WEB_TOOLS_DIR, 'web-search');
  assert.ok(fs.statSync(wrapper).mode & 0o111, 'the wrapper is executable');
  assert.match(fs.readFileSync(wrapper, 'utf8'), /^#!\/bin\/sh\n[\s\S]*exec node "\$\{0%\/\*\}\/\.\.\/\.\.\/\.\.\/bin\/web-search\.mjs" "\$@"\n$/);
  assert.ok(fs.existsSync(path.join(ROOT, 'bin', 'web-search.mjs')));
  assert.deepEqual([...SERVER.pathDirs], [], 'the server agent gets no command of its own');
});

test('web shell: yt-dlp runs only with --ignore-config; no option that runs another program passes, abbreviated or in = form', () => {
  assert.ok(WEB_SHELL_ALLOW.includes('yt-dlp --ignore-config *'));
  assert.ok(!WEB_SHELL_ALLOW.includes('yt-dlp *'));
  for (const pattern of YT_DLP_DENIES) assert.ok(SHELL_DENY_AFTER.includes(pattern), pattern);
  for (const scope of ['core', 'dm']) {
    const bash = WEB.buildConfig({ systemPrompt: 'x', scope }).agent['errand-web'].permission.bash;
    assert.equal(bash['yt-dlp --ignore-config *'], 'allow');
    for (const command of [
      'yt-dlp --ignore-config -f "bv*[height<=720]+ba" -o x.mp4 https://www.youtube.com/watch?v=abc',
      'yt-dlp --ignore-config -f "bv*[height<=720]+ba/b[height<=720]" -o "trailer.%(ext)s" https://www.youtube.com/watch?v=abc',
      'yt-dlp --ignore-config --merge-output-format mp4 https://www.youtube.com/watch?v=abc', 'yt-dlp --ignore-config -F https://youtu.be/abc',
      'yt-dlp --ignore-config --no-exec --no-plugin-dirs https://youtu.be/abc', 'yt-dlp --ignore-config --netrc --netrc-location x https://youtu.be/abc',
    ]) assert.equal(actionOf(bash, command), 'allow', `${scope}: ${command}`);
    for (const command of [
      // without --ignore-config a yt-dlp.conf the agent wrote in its folder would be loaded
      'yt-dlp https://youtu.be/abc', 'yt-dlp -f "bv*[height<=720]+ba" -o x.mp4 https://youtu.be/abc',
      'yt-dlp -F https://youtu.be/abc --ignore-config',
      'yt-dlp --ignore-config --exec rm https://youtu.be/abc',
      'yt-dlp --ignore-config --config-location a.conf https://youtu.be/abc',
      'yt-dlp --ignore-config --exec "rm -rf ~" https://youtu.be/abc', 'yt-dlp --ignore-config https://youtu.be/abc --exec "sh -c id"',
      'yt-dlp --ignore-config --exec=id https://youtu.be/abc',
      'yt-dlp --ignore-config --exec-before-download id https://youtu.be/abc', 'yt-dlp --ignore-config --exec-b id https://youtu.be/abc',
      'yt-dlp --ignore-config --exe id https://youtu.be/abc',
      'yt-dlp --ignore-config --netrc-cmd "sh x" https://youtu.be/abc', 'yt-dlp --ignore-config --netrc-c id https://youtu.be/abc',
      'yt-dlp --ignore-config --config-locations=x.conf https://youtu.be/abc', 'yt-dlp --ignore-config --conf x.conf https://youtu.be/abc',
      'yt-dlp --ignore-config --plugin-dirs ./p https://youtu.be/abc', 'yt-dlp --ignore-config --plu ./p https://youtu.be/abc',
    ]) assert.equal(actionOf(bash, command), 'deny', `${scope}: ${command}`);
  }
  const server = SERVER.buildConfig({ systemPrompt: 'x', scope: 'core' }).agent['errand-server'].permission.bash;
  assert.equal(actionOf(server, 'yt-dlp --ignore-config https://youtu.be/abc'), 'deny', 'the server shell has no yt-dlp');
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

test('server external_directory: allowed in core, the path tools\' withheld denies in a filtered scope; web stays denied', () => {
  assert.equal(SHELL_CLASSES['server-read-only'].externalDirectory, true);
  assert.equal(SHELL_CLASSES['web-download'].externalDirectory, false);
  const core = SERVER.buildConfig({ systemPrompt: 'x', scope: 'core' }).agent['errand-server'].permission;
  assert.equal(core.external_directory, 'allow');
  for (const tool of ['edit', 'write', 'patch', 'task', 'question']) assert.equal(core[tool], 'deny', tool);
  const group = SERVER.buildConfig({ systemPrompt: 'x', scope: 'group' }).agent['errand-server'].permission;
  const ext = group.external_directory;
  assert.deepEqual(ext, group.read, 'the same value as the path tools');
  const keys = Object.keys(ext);
  assert.equal(keys[0], '*');
  assert.equal(ext['*'], 'allow');
  assert.deepEqual(keys.slice(1), [...WITHHELD_GLOBS]);
  for (const glob of WITHHELD_GLOBS) assert.equal(ext[glob], 'deny', glob);
  // OpenCode asks external_directory with a `<dir>/*` resource; `*` matches any text, so `<root>/**` covers it
  for (const resource of ['/etc/neptunia/*', '/var/www/site/*', '/srv/neptunia-backups/*', `${DATA_DIR}/*`, `${DATA_DIR}/guilds/*`, '/srv/x/.git/*', '/home/u/.ssh/*']) {
    assert.equal(actionOf(ext, resource), 'deny', resource);
  }
  for (const resource of ['/opt/neptunia/app/*', '/home/steam/servers/*', '/etc/systemd/system/*', '/srv/git/*', '/srv/git/core.git/*']) assert.equal(actionOf(ext, resource), 'allow', resource);
  // a private directory apart from the checkout (production: /opt/neptunia/etc) yields globs that deny its `<dir>/*`
  const apart = { '*': 'allow' };
  for (const glob of withheldGlobsOf({ paths: resolvePaths({ rootDir: '/opt/neptunia/app', env: { NEPTUNIA_PRIVATE_DIR: '/opt/neptunia/etc', NEPTUNIA_DATA_DIR: '/opt/neptunia/data' } }) })) apart[glob] = 'deny';
  for (const resource of ['/opt/neptunia/etc/*', '/opt/neptunia/etc/prompts.local/*', '/opt/neptunia/data/*']) assert.equal(actionOf(apart, resource), 'deny', resource);
  assert.equal(actionOf(apart, '/opt/neptunia/app/*'), 'allow');
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

test('promptFilesOf: the override is read from NEPTUNIA_PRIVATE_DIR, the tracked prompt from agents/<name>/ under the root; the profiles use it', () => {
  const base = tempDir('agent-profiles-');
  try {
    const rootDir = path.join(base, 'checkout');
    const privateDir = path.join(base, 'private');
    const write = (file, text) => {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, text);
    };
    write(path.join(rootDir, 'agents', 'web', 'prompt.md'), 'tracked');
    write(path.join(rootDir, 'prompts.local', 'agent-web.md'), 'checkout override');
    write(path.join(privateDir, 'prompts.local', 'agent-web.md'), 'private override');

    const apart = promptFilesOf('web', { rootDir, env: { NEPTUNIA_PRIVATE_DIR: privateDir } });
    assert.deepEqual(apart, [path.join(privateDir, 'prompts.local', 'agent-web.md'), path.join(rootDir, 'agents', 'web', 'prompt.md')]);
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

/** The shell deny patterns per content command: one per withheld root, plain name and the .env form, six per segment name. */
const patternsPerCommand = (roots) => roots.length + WITHHELD_NAMES.length - SEGMENT_NAMES.length + 1 + SEGMENT_NAMES.length * 6;

test('withheldShellDenies: one pattern per content command and withheld root, name or .env form, six per segment name, generated', () => {
  const denies = withheldShellDenies();
  assert.equal(denies.length, SHELL_CONTENT_COMMANDS.length * patternsPerCommand(WITHHELD_ROOTS));
  assert.deepEqual([...SEGMENT_NAMES], ['.git', '.local.git']);
  for (const pattern of ['cat .git*', 'cat * .git*', 'cat */.git*', 'git *=.git*', "grep *'.local.git*", 'sed *".local.git*']) assert.ok(denies.includes(pattern), pattern);
  assert.ok(!denies.includes('cat *.git*'), 'no bare substring pattern for .git');
  assert.deepEqual([...SHELL_CONTENT_COMMANDS], ['cat', 'head', 'tail', 'grep', 'egrep', 'fgrep', 'sed', 'awk', 'cut', 'sort', 'uniq', 'wc', 'file', 'git', 'cp']);
  for (const pattern of ['cat */var/www*', 'cat *.ssh*', 'cat *.env*', 'cat *config.local.json*', 'git */srv/neptunia-backups*', `sed *${DATA_DIR}*`, 'wc *.secrets*']) assert.ok(denies.includes(pattern), pattern);
  for (const listing of ['ls', 'find', 'stat', 'du', 'readlink', 'realpath']) assert.ok(!denies.some((pattern) => pattern.startsWith(`${listing} `)), `${listing} stays allowed`);
  assert.ok(!denies.some((pattern) => pattern.includes('/srv/git')), 'the bare repositories are not withheld');
});

test('withheldShellDenies: the deployment\'s data directory and a private directory apart from the checkout come from `paths`', () => {
  const apart = withheldShellDenies({ paths: resolvePaths({ rootDir: '/srv/app', env: { NEPTUNIA_PRIVATE_DIR: '/srv/site/etc', NEPTUNIA_DATA_DIR: '/srv/site/data' } }) });
  for (const pattern of ['cat */srv/site/data*', 'grep */srv/site/etc*', 'cat */etc/neptunia*']) assert.ok(apart.includes(pattern), pattern);
  assert.ok(!apart.some((pattern) => pattern.includes('/srv/app')), 'the checkout itself is not withheld');
  const together = withheldShellDenies({ paths: resolvePaths({ rootDir: '/srv/app', env: {} }) });
  assert.ok(together.includes('cat */srv/app/data*'), 'default: <root>/data');
  assert.ok(!together.includes('cat */srv/app*'), 'a private directory that is the checkout is not withheld whole');
  const roots = withheldRootsOf({ paths: resolvePaths({ rootDir: '/srv/app', env: {} }) });
  assert.equal(together.length, SHELL_CONTENT_COMMANDS.length * patternsPerCommand(roots));
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
    'git log --stat /srv/neptunia-backups/x/hooks', 'cat /opt/neptunia/app/.git/config', 'cat .git/config',
    'grep x /srv/neptunia-dev/neptunia-core/.local.git/config', 'grep --file=.git/info/exclude x', 'cat "/srv/app/.git/HEAD"', 'file /srv/neptunia-dev/.secrets/proxy', 'sort /etc/letsencrypt/live/x/privkey.pem',
  ];
  for (const command of refused) {
    assert.equal(actionOf(dm, command), 'deny', `dm: ${command}`);
    assert.equal(actionOf(core, command), 'allow', `core: ${command}`);
  }
  for (const command of ['ls /var/www', 'ls -la /home/u/.ssh', 'find /var/www -name "*.php"', 'stat /srv/app/.env', 'du -sh /srv/neptunia-backups', 'cat /srv/git/README', 'cat /srv/git/core.git/HEAD', 'grep -r main /srv/git/neptunia-core-local.git/refs', 'readlink /srv/app/.env', 'realpath /var/www/site', 'cat /etc/hostname', 'grep -c ExecStart /etc/systemd/system/x.service', 'git log --oneline -5']) {
    assert.equal(actionOf(dm, command), 'allow', `dm: ${command}`);
  }
  assert.equal(actionOf(dm, 'find /var/www -exec cat {} ;'), 'deny', 'SHELL_DENY_AFTER still wins');
  assert.equal(actionOf(dm, 'rm -rf /tmp/x'), 'deny');
});

test('server shell: git reads another checkout by path (git -C); no write subcommand, config or output file passes, whatever the words around it', () => {
  for (const form of ['git -C * log *', 'git -C * show *', 'git -C * status', 'git -C * status *', 'git -C * diff *', 'git -C * branch *', 'git -C * rev-parse *']) {
    assert.ok(SERVER_SHELL_ALLOW.includes(form), form);
  }
  for (const scope of ['core', 'dm']) {
    const bash = SERVER.buildConfig({ systemPrompt: 'x', scope }).agent['errand-server'].permission.bash;
    for (const command of [
      'git -C /srv/app log --oneline -5', 'git -C /srv/app log -5 --format="%h %s"', 'git -C /srv/app show --stat HEAD', 'git -C /srv/app status',
      'git -C /srv/app status --short', 'git -C /srv/app diff HEAD~1 --stat', 'git -C /srv/app branch -a', 'git -C /srv/app branch --show-current',
      'git -C /srv/app rev-parse HEAD', 'git -C /srv/app log --oneline -- src/reset.js',
    ]) assert.equal(actionOf(bash, command), 'allow', `${scope}: ${command}`);
    for (const command of [
      'git -C /x commit', 'git -C /x commit -m log x', 'git -C /x push', 'git -C /x push origin status', 'git -C /x checkout main', 'git -C /x checkout -- status',
      'git -C /x reset --hard', 'git -C /x reset --hard log x', 'git -C /x config user.name x', 'git -C /x config --get log x', 'git -C /x add log x',
      'git -C /x stash', 'git -C /x clean -fdx status', 'git -C /x -c core.fsmonitor=x status', 'git -C /x -c core.pager=x log -1',
      'git -C /x --config-env=core.pager=X log -1', 'git -C /x log --output=/tmp/x', 'git -C /x diff --output /tmp/x HEAD',
      'git -C /x branch -D main', 'git -C /x branch --delete main', 'git -C /x branch -m a b', 'git -C /x branch --set-upstream-to=origin/x',
      'git -C /x branch -f main HEAD~3', 'git -C /x tag -d v1 log',
    ]) assert.equal(actionOf(bash, command), 'deny', `${scope}: ${command}`);
  }
  const dm = SERVER.buildConfig({ systemPrompt: 'x', scope: 'dm' }).agent['errand-server'].permission.bash;
  assert.equal(actionOf(dm, 'git -C /var/www/site log -5'), 'deny', 'a withheld checkout stays withheld in a filtered scope');
  for (const command of ['git -C /srv/git/core.git log -5', 'git -C /srv/git/neptunia-private.git log -5']) assert.equal(actionOf(dm, command), 'allow', `the bare repositories under /srv/git are readable in a filtered scope: ${command}`);
  for (const command of ['cat /opt/neptunia/app/.git/config', 'cat .git/config', 'grep x /srv/neptunia-dev/neptunia-core/.local.git/config']) assert.equal(actionOf(dm, command), 'deny', `a .git or .local.git segment stays withheld: ${command}`);
});

test('server shell: cp hands a file back into the task folder; in a filtered scope a withheld source is refused like cat', () => {
  assert.ok(SERVER_SHELL_ALLOW.includes('cp *'));
  const core = SERVER.buildConfig({ systemPrompt: 'x', scope: 'core' }).agent['errand-server'].permission.bash;
  const dm = SERVER.buildConfig({ systemPrompt: 'x', scope: 'dm' }).agent['errand-server'].permission.bash;
  const group = SERVER.buildConfig({ systemPrompt: 'x', scope: 'group' }).agent['errand-server'].permission.bash;
  for (const command of ['cp /srv/app/docs/north-star.md north-star.md', 'cp -r /srv/app/docs docs', 'cp /opt/neptunia/etc/.env x', 'cp /srv/x/.git/config x']) {
    assert.equal(actionOf(core, command), 'allow', `core: ${command}`);
  }
  for (const command of ['cp /srv/app/docs/north-star.md north-star.md', 'cp /etc/hostname hostname.txt', 'cp -r /srv/app/docs docs']) {
    assert.equal(actionOf(dm, command), 'allow', `dm: ${command}`);
  }
  for (const command of ['cp /opt/neptunia/etc/.env x', 'cp /srv/x/.git/config x', 'cp /var/www/site/index.php index.php', `cp ${DATA_DIR}/guilds/1/tasks.json t.json`, 'cp -r /home/u/.ssh keys']) {
    assert.equal(actionOf(dm, command), 'deny', `dm: ${command}`);
    assert.equal(actionOf(group, command), 'deny', `group: ${command}`);
  }
  for (const command of ['mv /srv/app/docs/north-star.md x', 'rm x']) assert.equal(actionOf(core, command), 'deny', `only copy: ${command}`);
});

test('child env: the server profile carries safe.directory=* (GIT_CONFIG_COUNT) and GIT_PAGER=cat; the web profile none', () => {
  assert.deepEqual({ ...SERVER.childEnv }, { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'safe.directory', GIT_CONFIG_VALUE_0: '*', GIT_PAGER: 'cat' });
  assert.deepEqual({ ...WEB.childEnv }, {});
  assert.ok(Object.isFrozen(SERVER.childEnv));
});

// ---- the agents/ folder ---------------------------------------------------------------

/** A worker profile.json that passes every check, `changes` merged over it (an `undefined` value drops the key). */
function workerProfile(id, changes = {}) {
  const base = {
    id,
    kind: 'worker',
    role: 'agent.server',
    prompt: 'prompt.md',
    override: `agent-${id}.md`,
    tools: ['read', 'list'],
    shell: 'server-read-only',
    limits: { steps: 5, usd: 0.1, seconds: 60 },
    daily: { tasks: 3, usd: 1 },
    searchProvider: null,
    socket: `/run/test-${id}/sock`,
    out: `/var/lib/test-${id}/out`,
    env: ['OPENROUTER_AGENT_KEY'],
    description: 'A test worker.',
  };
  const merged = { ...base, ...changes };
  for (const [key, value] of Object.entries(merged)) if (value === undefined) delete merged[key];
  return merged;
}

/** A temporary engine root whose agents/ holds `profiles` (`{ <folder>: object }`) and a README; `fn(rootDir)` runs over it. */
function withAgentsTree(profiles, fn) {
  const rootDir = tempDir('agent-tree-');
  try {
    fs.mkdirSync(path.join(rootDir, 'agents'));
    fs.writeFileSync(path.join(rootDir, 'agents', 'README.md'), 'not an agent');
    for (const [folder, profile] of Object.entries(profiles)) {
      fs.mkdirSync(path.join(rootDir, 'agents', folder));
      fs.writeFileSync(path.join(rootDir, 'agents', folder, 'profile.json'), JSON.stringify(profile));
    }
    return fn(rootDir);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
}

/** Asserts that loading the tree fails with one AgentProfileError naming `agent` and `key`. */
function assertRefused(rootDir, agent, key) {
  for (const load of [() => loadProfiles({ rootDir, env: {} }), () => listAgents({ rootDir })]) {
    assert.throws(load, (err) => {
      assert.ok(err instanceof AgentProfileError, err.message);
      assert.equal(err.agent, agent);
      assert.equal(err.key, key);
      assert.ok(err.message.includes(`"${agent}"`) && err.message.includes(`"${key}"`), err.message);
      assert.ok(!err.message.includes('\n'), 'one line');
      return true;
    });
  }
}

test('loadProfiles: a valid worker from a temporary agents/ tree becomes a profile with the runner\'s shape', () => {
  withAgentsTree({ probe: workerProfile('probe') }, (rootDir) => {
    const profiles = loadProfiles({ rootDir, env: { NEPTUNIA_PRIVATE_DIR: '/private' } });
    assert.deepEqual(Object.keys(profiles), ['probe']);
    const probe = profiles.probe;
    assert.equal(probe.name, 'probe');
    assert.equal(probe.agentId, 'errand-probe');
    assert.equal(probe.modelRole, 'agent.server');
    assert.equal(probe.defaultModel, ROLE_DEFAULTS['agent.server']);
    assert.deepEqual(probe.promptFiles, [path.join('/private', 'prompts.local', 'agent-probe.md'), path.join(rootDir, 'agents', 'probe', 'prompt.md')]);
    assert.deepEqual(probe.defaultLimits, { steps: 5, usd: 0.1, seconds: 60 });
    assert.deepEqual(probe.defaultDaily, { tasks: 3, usd: 1 });
    assert.equal(probe.defaultSearchProvider, null);
    assert.equal(probe.defaultSocket, '/run/test-probe/sock');
    assert.equal(probe.defaultOut, '/var/lib/test-probe/out');
    assert.deepEqual([...probe.envNames], ['OPENROUTER_AGENT_KEY']);
    // A profile only narrows: the tools it leaves out of its class are denied.
    const p = probe.buildConfig({ systemPrompt: 'x', scope: 'core' }).agent['errand-probe'].permission;
    assert.equal(p.read, 'allow');
    assert.equal(p.list, 'allow');
    assert.equal(p.grep, 'deny');
    assert.equal(p.glob, 'deny');
    assert.equal(p.bash, 'deny');
    assert.equal(p.edit, 'deny');
    assert.equal(p.websearch, 'deny');
  });
});

test('loadProfiles: a tool outside the shell class is refused at load, naming the agent and the key', () => {
  withAgentsTree({ probe: workerProfile('probe', { tools: ['read', 'edit'] }) }, (rootDir) => assertRefused(rootDir, 'probe', 'tools'));
  withAgentsTree({ probe: workerProfile('probe', { tools: ['read', 'websearch'] }) }, (rootDir) => assertRefused(rootDir, 'probe', 'tools'));
  withAgentsTree({ probe: workerProfile('probe', { shell: 'web-download', tools: ['grep'] }) }, (rootDir) => assertRefused(rootDir, 'probe', 'tools'));
});

test('loadProfiles: an unknown shell class is refused', () => {
  withAgentsTree({ probe: workerProfile('probe', { shell: 'root-shell' }) }, (rootDir) => assertRefused(rootDir, 'probe', 'shell'));
});

test('loadProfiles: a missing key or an unknown one is refused, nested keys too', () => {
  withAgentsTree({ probe: workerProfile('probe', { env: undefined }) }, (rootDir) => assertRefused(rootDir, 'probe', 'env'));
  withAgentsTree({ probe: workerProfile('probe', { kind: undefined }) }, (rootDir) => assertRefused(rootDir, 'probe', 'kind'));
  withAgentsTree({ probe: workerProfile('probe', { command: 'rm -rf /' }) }, (rootDir) => assertRefused(rootDir, 'probe', 'command'));
  withAgentsTree({ probe: workerProfile('probe', { limits: { steps: 5, usd: 0.1 } }) }, (rootDir) => assertRefused(rootDir, 'probe', 'limits.seconds'));
  withAgentsTree({ probe: workerProfile('probe', { id: 'other' }) }, (rootDir) => assertRefused(rootDir, 'probe', 'id'));
  withAgentsTree({ probe: workerProfile('probe', { prompt: '../prompt.md' }) }, (rootDir) => assertRefused(rootDir, 'probe', 'prompt'));
  withAgentsTree({ probe: workerProfile('probe', { role: 'voice' }) }, (rootDir) => assertRefused(rootDir, 'probe', 'role'));
});

test('a consultation is skipped by loadProfiles and listed by listAgents with the workers', () => {
  const consult = { id: 'consult', kind: 'consultation', role: 'agent.advice', prompt: null, override: null, description: 'A test consultation.' };
  withAgentsTree({ consult, probe: workerProfile('probe') }, (rootDir) => {
    assert.deepEqual(Object.keys(loadProfiles({ rootDir, env: {} })), ['probe']);
    const all = listAgents({ rootDir });
    assert.deepEqual(all.map((agent) => [agent.id, agent.kind]), [['consult', 'consultation'], ['probe', 'worker']]);
    assert.deepEqual({ ...all[0] }, consult);
    assert.ok(Object.isFrozen(all[0]));
  });
  withAgentsTree({ consult: { ...consult, shell: 'server-read-only' } }, (rootDir) => assertRefused(rootDir, 'consult', 'shell'));
});

test('the real agents/ folder: web and server workers, the advice consultation, each prompt tracked beside its profile', () => {
  const agents = listAgents();
  assert.deepEqual(agents.map((agent) => [agent.id, agent.kind]), [['advice', 'consultation'], ['server', 'worker'], ['web', 'worker']]);
  assert.deepEqual(Object.keys(PROFILES).sort(), ['server', 'web']);
  const advice = agents.find((agent) => agent.id === 'advice');
  assert.equal(advice.role, 'agent.advice');
  assert.equal(advice.prompt, 'prompt.md');
  assert.ok(fs.existsSync(path.join(ROOT, 'agents', 'advice', 'prompt.md')), 'the advice prompt is tracked beside its profile');
  for (const profile of [WEB, SERVER]) {
    assert.ok(fs.existsSync(path.join(ROOT, 'agents', profile.name, 'prompt.md')), profile.name);
    assert.equal(path.basename(profile.promptFiles[0]), `agent-${profile.name}.md`, 'the override keeps its name');
    assert.ok(SHELL_CLASSES[profile.shell].tools.length >= profile.tools.length);
  }
  assert.equal(fs.existsSync(path.join(ROOT, 'prompts', 'agent-web.md')), false, 'the agent prompts left prompts/');
  const shipped = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8')).agents;
  for (const name of ['web', 'server']) {
    assert.equal(shipped[name].socket, profileOf(name).defaultSocket, `${name}: config.json and the profile agree on the socket`);
    assert.equal(shipped[name].out, profileOf(name).defaultOut, `${name}: and on the out dir`);
  }
});
