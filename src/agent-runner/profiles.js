// The two agent profiles, `web` and `server`, each a set of OpenCode tools,
// default limits, a system-prompt file, the environment variable names its
// run needs, and an out/socket default. A profile also builds the OpenCode
// config for one task (`buildConfig`): one agent definition carrying the
// prompt, the step cap, and a permission map that starts every tool at deny
// and allow-lists only what the profile needs, plus the model and its cost
// (so OpenCode's local cost estimate is right). In a filtered scope
// (`dm`/`group`) the path tools also deny the withheld paths
// (src/agent-runner/policy.js).
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
import { WITHHELD_GLOBS } from './policy.js';

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
  'file *', 'echo *', 'basename *', 'dirname *', 'date', 'date *', 'free', 'free *', 'uptime', 'hostname', 'env',
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

/** A permission value for `bash`: deny-all first, then the allowed command patterns. */
function bashPermission(allow) {
  const map = { '*': 'deny' };
  for (const pattern of allow) map[pattern] = 'allow';
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
    bash: bashPermission(SERVER_SHELL_ALLOW),
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
function makeProfile({ name, agentId, promptFiles, envNames, defaultModel, defaultLimits, defaultDaily, defaultSearchProvider }) {
  return {
    name,
    agentId,
    promptFiles,
    envNames,
    defaultModel,
    defaultLimits,
    defaultDaily,
    defaultSearchProvider,
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
  defaultModel: 'openrouter/x-ai/grok-4.7',
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
  defaultModel: 'openrouter/x-ai/grok-4.7',
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
