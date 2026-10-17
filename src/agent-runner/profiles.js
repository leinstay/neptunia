// The two agent profiles, `web` and `server`, each a set of OpenCode tools,
// default limits, a system-prompt file, the environment variable names its
// run needs, the model role it runs on (`agent.web`, `agent.server`), and an
// out/socket default. A profile also builds the OpenCode
// config for one task (`buildConfig`): one agent definition carrying the
// prompt, the step cap, and a permission map that starts every tool at deny
// and allow-lists only what the profile needs, plus the model and its cost
// (so OpenCode's local cost estimate is right). In a filtered scope
// (`dm`/`group`) the path tools also deny the withheld paths, and the server
// agent's `bash` denies a content-reading command on one
// (src/agent-runner/policy.js), so OpenCode refuses that step and the agent
// goes on.
//
// This matches OpenCode release v1.19.3 (the version installed on the
// server), whose config is the V1 shape: the top-level key is `agent`
// (singular), an agent carries `prompt` (not `system`), `steps` and
// `permission` (an object keyed by tool, each value an action string or a
// { pattern: action } map; a config typo falls back to `ask`, which a
// headless run rejects). Tool/permission keys are OpenCode's own: `bash`
// (the shell), `read`, `grep`, `glob`, `list`, `webfetch`, `websearch`,
// `edit`, `write`, `patch`, `task` (subagents), `question`,
// `external_directory`. The permission runtime takes the LAST matching rule,
// so for `bash` a catch-all `*: deny` comes first and the allowed commands
// after, and for a path tool `*: allow` comes first and the withheld-path
// denies after. The web search provider is chosen by an environment variable
// at run time (src/agent-runner/opencode.js), not in this config, because
// v1.19.3 has no websearch config key. Keep in sync with docs/en/agents.md.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WITHHELD_GLOBS, WITHHELD_NAMES, WITHHELD_ROOTS } from './policy.js';
import { ROLE_DEFAULTS } from '../llm/roles.js';

/** The engine root (two levels up from this file). */
const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** The read-only shell commands the server agent's `bash` may run (OpenCode bash patterns). */
export const SERVER_SHELL_ALLOW = Object.freeze([
  'ls', 'ls *', 'cat', 'cat *', 'head', 'head *', 'tail', 'tail *', 'grep', 'grep *', 'egrep *', 'fgrep *',
  'find', 'find *', 'ps', 'ps *', 'df', 'df *', 'du', 'du *', 'wc', 'wc *', 'stat', 'stat *',
  'which', 'which *', 'id', 'id *', 'uname', 'uname *', 'cut', 'cut *', 'sort', 'sort *', 'uniq', 'uniq *',
  'awk', 'awk *', 'sed -n *', 'ss -ln', 'ss -ln *', 'ss *', 'journalctl', 'journalctl *',
  'systemctl status', 'systemctl status *', 'systemctl show', 'systemctl show *', 'systemctl cat *',
  'systemctl list-units *', 'systemctl list-unit-files *', 'systemctl list-*', 'systemctl is-* *',
  'git log *', 'git show *', 'git status', 'git status *', 'git diff', 'git diff *', 'readlink *', 'realpath *',
  'file *', 'echo *', 'basename *', 'dirname *', 'date', 'date *', 'free', 'free *', 'uptime', 'hostname',
]);

/** The curl/wget/ffmpeg shell the web agent's `bash` may run (its download step). */
export const WEB_SHELL_ALLOW = Object.freeze([
  'curl *', 'wget *', 'ffmpeg *', 'ffprobe *', 'file *', 'ls', 'ls *', 'mkdir *', 'cat *', 'head *', 'stat *',
]);

/** A permission value for a path tool in `scope`: a plain `allow`, or `*: allow` then the withheld denies. */
function pathPermission(scope) {
  if (scope === 'core') return 'allow';
  const map = { '*': 'allow' };
  for (const glob of WITHHELD_GLOBS) map[glob] = 'deny';
  return map;
}

/** Patterns denied after the allows (the last match wins): the ways an allowed read-only command could write or reach the network. */
export const SHELL_DENY_AFTER = Object.freeze(['find * -exec*', 'find * -ok*', 'find * -delete*', 'find * -fprint*', 'awk */inet/*', 'gawk *']);

/** The allowed shell commands that open file contents: in a filtered scope each is refused on a withheld path. */
export const SHELL_CONTENT_COMMANDS = Object.freeze(['cat', 'head', 'tail', 'grep', 'egrep', 'fgrep', 'sed', 'awk', 'cut', 'sort', 'uniq', 'wc', 'file', 'git']);

/** The `.env` forms policy.js withholds (`.env`, `.env.<anything>`): one substring matches them all. */
const ENV_FORM = '.env';

/**
 * The `bash` deny patterns of a filtered scope: one `<command> *<withheld>*` per content command
 * (SHELL_CONTENT_COMMANDS) and withheld root, name or `.env` form (src/agent-runner/policy.js), so
 * OpenCode itself refuses such a read and the model gets the refusal and goes on. OpenCode's `*`
 * matches any text, `/` and spaces included. Listing commands (`ls`, `find`, `stat`, `du`,
 * `readlink`, `realpath`) get none: names stay visible.
 * @returns {string[]}
 */
export function withheldShellDenies() {
  const withheld = [...WITHHELD_ROOTS, ...WITHHELD_NAMES, ENV_FORM];
  return SHELL_CONTENT_COMMANDS.flatMap((command) => withheld.map((part) => `${command} *${part}*`));
}

/** A permission value for `bash`: deny-all first, then the allowed command patterns, then `denies`
 * (the withheld-path ones of a filtered scope), then SHELL_DENY_AFTER. */
function bashPermission(allow, denies = []) {
  const map = { '*': 'deny' };
  for (const pattern of allow) map[pattern] = 'allow';
  for (const pattern of denies) map[pattern] = 'deny';
  for (const pattern of SHELL_DENY_AFTER) map[pattern] = 'deny';
  return map;
}

/** The V1 permission map of a profile for `scope`. */
function permissionFor(name, scope) {
  if (name === 'web') {
    return {
      websearch: 'allow',
      webfetch: 'allow',
      read: pathPermission(scope),
      glob: pathPermission(scope),
      list: pathPermission(scope),
      grep: 'deny',
      bash: bashPermission(WEB_SHELL_ALLOW),
      edit: 'deny',
      write: 'deny',
      patch: 'deny',
      task: 'deny',
      question: 'deny',
      external_directory: 'deny',
    };
  }
  return {
    read: pathPermission(scope),
    grep: pathPermission(scope),
    glob: pathPermission(scope),
    list: pathPermission(scope),
    bash: bashPermission(SERVER_SHELL_ALLOW, scope === 'core' ? [] : withheldShellDenies()),
    webfetch: 'deny',
    websearch: 'deny',
    edit: 'deny',
    write: 'deny',
    patch: 'deny',
    task: 'deny',
    question: 'deny',
    external_directory: 'deny',
  };
}

/**
 * One profile.
 * @param {object} definition
 * @returns {object}
 */
function makeProfile({ name, agentId, promptFiles, envNames, modelRole, defaultLimits, defaultDaily, defaultSearchProvider }) {
  const defaultModel = ROLE_DEFAULTS[modelRole];
  return {
    name,
    agentId,
    promptFiles,
    envNames,
    // The model role (src/llm/roles.js) whose model the agent runs on: `roles.<modelRole>`,
    // else its default, which is `defaultModel`.
    modelRole,
    defaultModel,
    defaultLimits,
    defaultDaily,
    defaultSearchProvider,
    // Where the runner listens and writes its files when `agents.<profile>.socket` / `.out` are unset.
    defaultSocket: `/run/neptunia-agent-${name}/sock`,
    defaultOut: `/var/lib/neptunia-agent-${name}/out`,
    /**
     * The OpenCode config (V1 shape) for one task, to pass as
     * OPENCODE_CONFIG_CONTENT. `providerModel` is `provider/model`; `cost`
     * (`{ input, output }` USD per million tokens) sets the catalog entry so
     * the cost estimate is right; `toolResultChars` caps each tool result
     * (`tool_output.max_bytes`); `scope` adds the withheld-path denies when
     * filtered. The web search provider is set by the environment, not here.
     */
    buildConfig({ systemPrompt, providerModel, steps, scope = 'core', cost, toolResultChars } = {}) {
      const [providerId, ...rest] = String(providerModel ?? defaultModel).split('/');
      const modelId = rest.join('/');
      const agent = {
        mode: 'primary',
        prompt: String(systemPrompt ?? ''),
        permission: permissionFor(name, scope),
      };
      if (Number.isFinite(steps) && steps > 0) agent.steps = Math.floor(steps);
      const config = {
        $schema: 'https://opencode.ai/config.json',
        agent: { [agentId]: agent },
      };
      if (modelId) config.model = `${providerId}/${modelId}`;
      if (cost && Number.isFinite(cost.input) && Number.isFinite(cost.output) && modelId) {
        config.provider = { [providerId]: { models: { [modelId]: { cost: { input: cost.input, output: cost.output } } } } };
      }
      if (Number.isFinite(toolResultChars) && toolResultChars > 0) config.tool_output = { max_bytes: Math.floor(toolResultChars) };
      return config;
    },
  };
}

/** The `web` profile: internet errands through OpenCode's web tools and a curl/ffmpeg download shell. */
export const WEB = makeProfile({
  name: 'web',
  agentId: 'errand-web',
  promptFiles: [path.join(ROOT_DIR, 'prompts.local', 'agent-web.md'), path.join(ROOT_DIR, 'prompts', 'agent-web.md')],
  envNames: Object.freeze(['OPENROUTER_AGENT_KEY', 'OPENCODE_WEBSEARCH_KEY', 'PROXY_URL']),
  modelRole: 'agent.web',
  defaultLimits: Object.freeze({ steps: 25, usd: 0.5, seconds: 300 }),
  defaultDaily: Object.freeze({ tasks: 40, usd: 8 }),
  defaultSearchProvider: 'exa',
});

/** The `server` profile: read-only shell and file reads on the server, no network. */
export const SERVER = makeProfile({
  name: 'server',
  agentId: 'errand-server',
  promptFiles: [path.join(ROOT_DIR, 'prompts.local', 'agent-server.md'), path.join(ROOT_DIR, 'prompts', 'agent-server.md')],
  envNames: Object.freeze(['OPENROUTER_AGENT_KEY']),
  modelRole: 'agent.server',
  defaultLimits: Object.freeze({ steps: 20, usd: 0.2, seconds: 120 }),
  defaultDaily: Object.freeze({ tasks: 40, usd: 3 }),
  defaultSearchProvider: null,
});

/** The profiles by name. */
export const PROFILES = Object.freeze({ web: WEB, server: SERVER });

/** The profile of `name`, or null. */
export function profileOf(name) {
  return PROFILES[name] ?? null;
}
