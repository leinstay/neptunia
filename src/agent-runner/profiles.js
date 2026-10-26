// The agent profiles, built from the `agents/` folder at the engine root: one
// `agents/<id>/profile.json` per agent, beside its tracked prompt
// (`agents/<id>/prompt.md`). A profile file only describes a request: its
// kind (`worker`, run under this runner on a socket; `consultation`, a
// model role tools call directly; `development`, an agent of the
// workspace's development side that a dispatcher outside this engine runs
// on OpenCode: the runner skips the last two), its model role
// (`scout`, `server`, `thinker`, `dev`: the key of its model under `models.<group>`), its prompt and the deployment's override
// name under `prompts.local/`, the OpenCode tools it asks for, the name of
// its shell class, its default limits, daily caps, socket and out dir, and
// the environment variable names its run may fall back on (the core sends
// the keys with each task). It never authorizes anything: the shell classes
// (their allow lists, which tools each class may grant) and every deny are
// defined here and in src/agent-runner/policy.js, a profile can only ask for
// fewer tools than its class allows, and a profile that names an unknown
// key, tool or shell class, or misses a key, fails `loadProfiles` at start
// with one error naming the agent and the key. A profile also builds the
// OpenCode config for one task (`buildConfig`): one agent definition
// carrying the prompt, the step cap, and a permission map that starts every
// tool at deny and allow-lists only what the profile asks for within its
// class, plus the model and its cost (so OpenCode's local cost estimate is
// right). In a filtered scope (`dm`/`group`) the path tools also deny the
// withheld paths, and the read-only server shell's `bash` denies a
// content-reading command on one (src/agent-runner/policy.js), so OpenCode
// refuses that step and the agent goes on. A shell class also names the
// variables its OpenCode child runs with (the server agent's git settings),
// and whether its agent may reach paths outside its own working directory
// (`external_directory`, which OpenCode asks for a path-tool target, a bash
// workdir outside it, or a path argument of `cd`, `rm`, `cp`, `mv`, `mkdir`,
// `touch`, `chmod`, `chown` and `cat`, with a `<dir>/*` resource): the
// read-only server class gets it under the same value as its path tools (the
// withheld denies in a filtered scope), the scout class only for its private
// temporary directory (SCOUT_TMP_DIR, where OpenCode saves the files it
// fetches), in every scope.
//
// This matches OpenCode release v1.19.3 (the version installed on the
// server), whose config is the V1 shape: the top-level key is `agent`
// (singular), an agent carries `prompt` (not `system`), `steps` and
// `permission` (an object keyed by tool, each value an action string or a
// { pattern: action } map; a config typo falls back to `ask`, which a
// headless run rejects). Tool/permission keys are OpenCode's own: `bash`
// (the shell), `read`, `grep`, `glob`, `list`, `webfetch`, `websearch`,
// `edit`, `write`, `patch`, `task` (subagents), `question`, `skill`,
// `todowrite`, `lsp`, `plan_exit`, `execute`, `external_directory`; every
// tool no class asks for is denied (ALWAYS_DENIED). v1.19.3 shows `websearch`
// only with Exa or Parallel switched on directly, which this engine never
// does (Exa only through OpenRouter): the scout agent searches with the
// `web-search` command of its shell instead (src/web/web-search.js). The permission runtime takes the LAST matching rule,
// so for `bash` a catch-all `*: deny` comes first and the allowed commands
// after (then a class's staged rules, then the denies), and for a path tool (and the server class's `external_directory`)
// `*: allow` comes first and the withheld-path denies after. The web search provider is chosen by an environment variable
// at run time (src/agent-runner/opencode.js), not in this config, because
// v1.19.3 has no websearch config key. Keep in sync with docs/errands.md.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WITHHELD_GLOBS, WITHHELD_NAMES, WITHHELD_ROOTS, withheldRootsOf } from './policy.js';
import { DEVELOPMENT_ROLES, OPENCODE_ROLES, ROLE_DEFAULTS } from '../llm/roles.js';
import { resolvePaths } from '../paths.js';

/** The engine root (two levels up from this file). */
const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** The folder of the agents under an engine root: one `<id>/profile.json` per agent. */
const AGENTS_DIRNAME = 'agents';

/** The description file inside an agent's folder. */
const PROFILE_FILE = 'profile.json';

/**
 * The system-prompt files of agent `name`, in the order they are tried: the deployment's
 * override `prompts.local/<override>` under the private directory (`NEPTUNIA_PRIVATE_DIR`, else
 * the root; src/paths.js#resolvePaths), then the tracked `agents/<name>/<prompt>` under the root.
 * `override` defaults to `agent-<name>.md` and `prompt` to `prompt.md`, the names the shipped
 * profiles use, so the owner's override files keep their names. An override that exists but
 * cannot be read (EACCES, EPERM) is skipped like an absent one, with one warning
 * (src/agent-runner/opencode.js#readPromptFile). Pure: `env` is only read.
 * @param {string} name
 * @param {{ rootDir?: string, env?: Record<string, string | undefined>, override?: string, prompt?: string }} [options]
 * @returns {string[]}
 */
export function promptFilesOf(
  name,
  { rootDir = ROOT_DIR, env = process.env, override = `agent-${name}.md`, prompt = 'prompt.md' } = {}
) {
  const { rootDir: root, privateDir } = resolvePaths({ rootDir, env });
  return [path.join(privateDir, 'prompts.local', override), path.join(root, AGENTS_DIRNAME, name, prompt)];
}

/** The first option words `tar` may start with on the server: the list mode (`-t`) with only
 * verbose, archive-file and decompression letters, so no cluster carries a write mode or `-I`.
 * The options after it are checked by TAR_DENIES. */
const TAR_LIST_CLUSTERS = Object.freeze([
  '-t',
  '-tf',
  '-tvf',
  '-tzf',
  '-tzvf',
  '-tvzf',
  '-tjf',
  '-tjvf',
  '-tvjf',
  '-tJf',
  '-tJvf',
  '-tvJf',
  '-taf',
  '-tavf',
  '-tvaf',
  '--list',
]);

/** The `ip` objects the server agent may show (`ip a`, `ip r` and `ip l` are their short names), and
 * the display options that may precede one. Only `show` (or nothing) may follow: no `add`, `set`,
 * `flush`, `-batch` or `netns`. */
const IP_OBJECTS = Object.freeze(['addr', 'address', 'a', 'route', 'r', 'link', 'l']);
const IP_DISPLAY_OPTIONS = Object.freeze(['', '-br ', '-4 ', '-6 ', '-s ', '-d ', '-j ']);
const IP_SHOW_ALLOW = Object.freeze(
  IP_DISPLAY_OPTIONS.flatMap((option) =>
    IP_OBJECTS.flatMap((object) => [
      `ip ${option}${object}`,
      `ip ${option}${object} show`,
      `ip ${option}${object} show *`,
    ])
  )
);

/** The shell commands the server agent's `bash` may run (OpenCode bash patterns): read-only ones, and `cp` into its folder. */
export const SERVER_SHELL_ALLOW = Object.freeze([
  'ls',
  'ls *',
  'cat',
  'cat *',
  'head',
  'head *',
  'tail',
  'tail *',
  'grep',
  'grep *',
  'egrep *',
  'fgrep *',
  'find',
  'find *',
  'ps',
  'ps *',
  'df',
  'df *',
  'du',
  'du *',
  'wc',
  'wc *',
  'stat',
  'stat *',
  'which',
  'which *',
  'id',
  'id *',
  'uname',
  'uname *',
  'cut',
  'cut *',
  'sort',
  'sort *',
  'uniq',
  'uniq *',
  'sed -n --sandbox *',
  'sed --sandbox -n *',
  'ss -ln',
  'ss -ln *',
  'ss *',
  'journalctl',
  'journalctl *',
  'systemctl status',
  'systemctl status *',
  'systemctl show',
  'systemctl show *',
  'systemctl cat *',
  'systemctl list-units *',
  'systemctl list-unit-files *',
  'systemctl list-*',
  'systemctl is-* *',
  'git log *',
  'git show *',
  'git status',
  'git status *',
  'git diff',
  'git diff *',
  // The same reads of another checkout by path, so the agent never changes directory (OpenCode
  // refuses a workdir outside its own as external_directory); GIT_WRITE_DENIES keeps writes out.
  'git -C * log *',
  'git -C * show *',
  'git -C * status',
  'git -C * status *',
  'git -C * diff *',
  'git -C * branch *',
  'git -C * rev-parse *',
  'readlink *',
  'realpath *',
  'file *',
  'echo *',
  'basename *',
  'dirname *',
  'date',
  'date *',
  'free',
  'free *',
  'uptime',
  'hostname',
  'pwd',
  'command -v *',
  // Searching and reading (each a content command, SHELL_CONTENT_COMMANDS): ripgrep without
  // `--pre` and tar in its list mode only (SHELL_DENY_AFTER).
  'rg',
  'rg *',
  'tree',
  'tree *',
  'jq *',
  'diff *',
  'sha256sum *',
  'md5sum *',
  'zcat *',
  'zgrep *',
  'xxd *',
  'strings *',
  'column',
  'column *',
  'nl',
  'nl *',
  ...TAR_LIST_CLUSTERS.map((cluster) => `tar ${cluster} *`),
  // Who and what this machine is.
  ...IP_SHOW_ALLOW,
  'getent passwd',
  'getent passwd *',
  'getent group',
  'getent group *',
  'last',
  'last *',
  'w',
  'w *',
  'who',
  'who *',
  'timedatectl',
  'timedatectl status',
  'hostnamectl',
  'hostnamectl status',
  // The one command that writes: a copy, so the agent hands an existing file back whole as a
  // result file (src/agent-runner/opencode.js collects what its working directory holds) instead
  // of retyping it. The OS keeps every other destination read-only: the unit's
  // ProtectSystem=strict leaves only its StateDirectory (where the task folders live) and a
  // private /tmp writable. cp is a content command (SHELL_CONTENT_COMMANDS), so a filtered scope
  // refuses copying a withheld path exactly like cat.
  'cp *',
]);

/** The curl/wget/yt-dlp/ffmpeg shell the scout agent's `bash` may run (its download step). yt-dlp
 * (a video page) reaches the network through the HTTPS_PROXY / HTTP_PROXY the runner gives the
 * child (src/agent-runner/opencode.js). It runs only as `yt-dlp --ignore-config ...`: yt-dlp
 * otherwise loads a yt-dlp.conf from its working directory, HOME and XDG_CONFIG_HOME, all inside
 * the agent's task folder, where the agent itself can write one (curl -o, yt-dlp -o) carrying
 * `--exec`; a bare `yt-dlp <url>` matches no allow and is refused. Its options that run another
 * program, or name a config file again, are denied in YT_DLP_DENIES. Beside the download tools it
 * has the everyday commands that sort out what it fetched: text filters (sed only as
 * `sed -n --sandbox`, where sed refuses its `e`, `r` and `w` commands), `jq`, and `cp`, `mv`, `rm`
 * within its folder and SCOUT_TMP_DIR (SCOUT_FILE_RULES). */
export const SCOUT_SHELL_ALLOW = Object.freeze([
  'curl *',
  'wget *',
  'yt-dlp --ignore-config *',
  'ffmpeg *',
  'ffprobe *',
  'file *',
  'ls',
  'ls *',
  'mkdir *',
  'cat *',
  'head *',
  'stat *',
  // The web search (src/web/web-search.js): the wrapper in SCOUT_TOOLS_DIR, found on the child's
  // PATH; never `node` itself, so no other script runs.
  'web-search *',
  'tail *',
  'wc *',
  'sort *',
  'uniq *',
  'cut *',
  'tr *',
  'grep *',
  'egrep *',
  'fgrep *',
  'sed -n --sandbox *',
  'sed --sandbox -n *',
  'jq *',
  'pwd',
  'which *',
  'command -v *',
  'echo',
  'echo *',
  'cp *',
  'mv *',
  'rm *',
]);

/** The folder of the scout agent's own commands (`web-search`), put first on its child's PATH. */
export const SCOUT_TOOLS_DIR = path.join(ROOT_DIR, AGENTS_DIRNAME, 'scout', 'bin');

/**
 * The private temporary directory of the scout agent's OpenCode: it saves the files `webfetch`
 * fetches under `<tmp>/opencode`, and the scout unit runs with PrivateTmp=yes and no TMPDIR, so this
 * one is the agent's own. Its path tools, `external_directory` and `cp`/`mv`/`rm` may reach it.
 */
export const SCOUT_TMP_DIR = '/tmp/opencode';

/** The commands of SCOUT_FILE_RULES and the only options each may start with (none recursive, none naming a target elsewhere). */
const FILE_COMMAND_OPTIONS = Object.freeze({
  cp: Object.freeze(['-f', '-v', '-n', '-p', '-fv', '-vf']),
  mv: Object.freeze(['-f', '-v', '-n', '-fv', '-vf']),
  rm: Object.freeze(['-f', '-v', '-fv', '-vf']),
});

/** The text OpenCode cannot resolve to a path (a variable, a command substitution, a `~user` home, a parent step), refused in a file command. */
const FILE_BYPASS_PARTS = Object.freeze(['$', '`', '~', '..']);

/** The top-level directories a file command may not name (an absolute path outside the folder; `/tmp` itself below). */
const FILE_DENIED_ROOTS = Object.freeze([
  '/bin',
  '/boot',
  '/dev',
  '/etc',
  '/home',
  '/lib',
  '/lost+found',
  '/media',
  '/mnt',
  '/opt',
  '/proc',
  '/root',
  '/run',
  '/sbin',
  '/snap',
  '/srv',
  '/sys',
  '/usr',
  '/var',
]);

/**
 * The staged `bash` rules of the scout agent's `cp`, `mv` and `rm` (`[pattern, action]`, in order,
 * after its allow list; the last match wins), so each works only on its own folder and
 * SCOUT_TMP_DIR, never recursively. OpenCode's `*` matches any text, spaces included, so a rule
 * cannot say "an option word without r": instead any leading option is denied, the plain ones of
 * FILE_COMMAND_OPTIONS allowed again, and then any later option word (` -...`), any text OpenCode
 * cannot resolve (FILE_BYPASS_PARTS), any top-level directory but /tmp (FILE_DENIED_ROOTS), `/`
 * and `/tmp` themselves denied. The main guard of the paths is OpenCode's own: these commands ask
 * `external_directory` for every path argument outside the folder, which the scout class allows only
 * for SCOUT_TMP_DIR; these rules refuse what that check cannot see.
 */
export const SCOUT_FILE_RULES = Object.freeze(
  Object.entries(FILE_COMMAND_OPTIONS).flatMap(([command, options]) =>
    [
      [`${command} -*`, 'deny'],
      ...options.map((option) => [`${command} ${option} *`, 'allow']),
      [`${command} * -*`, 'deny'],
      ...FILE_BYPASS_PARTS.map((part) => [`${command} *${part}*`, 'deny']),
      ...FILE_DENIED_ROOTS.flatMap((root) => [
        [`${command} ${root}*`, 'deny'],
        [`${command} * ${root}*`, 'deny'],
      ]),
      [`${command} / *`, 'deny'],
      [`${command} * / *`, 'deny'],
      [`${command} /tmp *`, 'deny'],
      [`${command} * /tmp *`, 'deny'],
    ].map((rule) => Object.freeze(rule))
  )
);

/**
 * The yt-dlp options that run another program or load options that could (still needed with
 * `--ignore-config`, which only skips the config files found by default: these stop the same
 * options given on the command line, and `--config-locations` would load a file again): `--exec` (and
 * `--exec-before-download`), `--netrc-cmd`, `--config-locations` (also spelled
 * `--config-location`) and `--plugin-dirs`. yt-dlp accepts any unambiguous prefix of a long
 * option, so each pattern is a prefix that names only that option (`--exe`, `--netrc-c`,
 * `--conf`, `--plu`), not the full name. OpenCode's `*` matches any text, so the option is
 * refused wherever it stands, `=value` form included.
 */
export const YT_DLP_DENIES = Object.freeze([
  'yt-dlp *--exe*',
  'yt-dlp *--netrc-c*',
  'yt-dlp *--conf*',
  'yt-dlp *--plu*',
]);

/** A permission value for a path tool in `scope`: a plain `allow`, or `*: allow` then the withheld denies. */
function pathPermission(scope) {
  if (scope === 'core') return 'allow';
  const map = { '*': 'allow' };
  for (const glob of WITHHELD_GLOBS) map[glob] = 'deny';
  return map;
}

/** The git subcommands that write (a repository, a working tree, a remote or a config): never run through `git -C`. */
const GIT_WRITE_SUBCOMMANDS = Object.freeze([
  'commit',
  'push',
  'pull',
  'fetch',
  'checkout',
  'switch',
  'restore',
  'reset',
  'config',
  'merge',
  'rebase',
  'cherry-pick',
  'revert',
  'am',
  'apply',
  'add',
  'rm',
  'mv',
  'clean',
  'stash',
  'tag',
  'gc',
  'prune',
  'repack',
  'worktree',
  'submodule',
  'remote',
  'update-ref',
  'update-index',
  'symbolic-ref',
  'notes',
  'init',
  'clone',
  'filter-branch',
  'replace',
  'bisect',
]);

/** The `git branch` options that create, rename, copy, delete or retarget a branch. */
const GIT_BRANCH_WRITE_OPTIONS = Object.freeze([
  '-d',
  '-D',
  '--delete',
  '-m',
  '-M',
  '--move',
  '-c',
  '-C',
  '--copy',
  '-f',
  '--force',
  '-u',
  '--set-upstream-to',
  '--unset-upstream',
  '--edit-description',
  '--track',
  '--no-track',
]);

/**
 * The denies that keep the `git -C * <read> *` allows read-only. OpenCode's `*` matches any text,
 * spaces included, so `git -C * log *` alone would also pass `git -C /x commit -m log`: each write
 * subcommand is denied as a word after `-C`, and so are a config set on the command line (`-c`,
 * `--config-env`: a hook, a pager or an fsmonitor command would run), `--exec-path`, an `--output`
 * file, and the `git branch` options that change a branch.
 */
export const GIT_WRITE_DENIES = Object.freeze([
  ...GIT_WRITE_SUBCOMMANDS.flatMap((command) => [`git -C * ${command}`, `git -C * ${command} *`]),
  'git -C * -c *',
  'git -C * --config-env*',
  'git -C * --exec-path*',
  'git -C *--output*',
  ...GIT_BRANCH_WRITE_OPTIONS.flatMap((option) => [
    `git -C * branch* ${option}`,
    `git -C * branch* ${option} *`,
    `git -C * branch* ${option}=*`,
  ]),
]);

/**
 * The tar options that write, run another program or reach a remote host, denied after the list
 * forms of SERVER_SHELL_ALLOW: a write mode or `-I`/`-F`/`-g` as a later option word, alone or as
 * the second letter of a cluster (`-x`, `-vx`; a longer cluster is not matched, since OpenCode's
 * `?` also matches a space and would refuse `-f x.tar`), and the long options by the shortest
 * prefix tar takes for each (`--ext` for `--extract`, `--to-c` for `--to-command`, `--use` for
 * `--use-compress-program`, ...).
 */
export const TAR_DENIES = Object.freeze([
  ...['x', 'c', 'r', 'u', 'A', 'I', 'F', 'g'].flatMap((letter) => [`tar * -${letter}*`, `tar * -?${letter}*`]),
  ...[
    '--ext',
    '--get',
    '--cr',
    '--ap',
    '--up',
    '--del',
    '--cat',
    '--conc',
    '--to-c',
    '--use',
    '--checkpoint-a',
    '--rsh',
    '--rmt',
    '--info',
    '--new-v',
    '--listed',
    '--index',
    '--vol',
  ].map((prefix) => `tar *${prefix}*`),
]);

/** The options of an allowed reader that run another program or edit in place: ripgrep's
 * `--pre`, sort's `--compress-program` (any prefix from `--co`), sed's `-i`/`--in-place`. */
export const READER_DENIES = Object.freeze(['rg *--pre*', 'sort *--co*', 'sed * -i*', 'sed * -?i*', 'sed * --in*']);

/** The forms of an allowed command that read the process environment, where the agent's API key
 * lives: echo with any `$` (a variable or a substitution; echo stays for literal text) and jq's
 * `env` / `$ENV`. */
export const ENV_READ_DENIES = Object.freeze(['echo *$*', 'jq *env*', 'jq *$ENV*']);

/** Patterns denied after the allows (the last match wins): the ways an allowed command could write, reach the network, run another program or read the environment. */
export const SHELL_DENY_AFTER = Object.freeze([
  ...GIT_WRITE_DENIES,
  ...YT_DLP_DENIES,
  ...TAR_DENIES,
  ...READER_DENIES,
  ...ENV_READ_DENIES,
  'find * -exec*',
  'find * -ok*',
  'find * -delete*',
  'find * -fprint*',
  'awk */inet/*',
  'gawk *',
]);

/** The allowed shell commands that open file contents: in a filtered scope each is refused on a withheld path. */
export const SHELL_CONTENT_COMMANDS = Object.freeze([
  'cat',
  'head',
  'tail',
  'grep',
  'egrep',
  'fgrep',
  'sed',
  'cut',
  'sort',
  'uniq',
  'wc',
  'file',
  'git',
  'cp',
  'rg',
  'tree',
  'jq',
  'diff',
  'sha256sum',
  'md5sum',
  'zcat',
  'zgrep',
  'xxd',
  'strings',
  'column',
  'nl',
  'tar',
]);

/** The `.env` forms policy.js withholds (`.env`, `.env.<anything>`): one substring matches them all. */
const ENV_FORM = '.env';

/** The withheld names matched only where a path segment starts (so a bare repository named `<x>.git` stays readable). */
export const SEGMENT_NAMES = Object.freeze(['.git', '.local.git']);
/** The text that can precede a segment-start name in a command: the command word's space, any space, a slash, `=` or a quote. */
const SEGMENT_STARTS = Object.freeze(['', '* ', '*/', '*=', "*'", '*"']);

/**
 * The `bash` deny patterns of a filtered scope: one `<command> *<withheld>*` per content command
 * (SHELL_CONTENT_COMMANDS) and withheld root, name or `.env` form (src/agent-runner/policy.js), so
 * OpenCode itself refuses such a read and the model gets the refusal and goes on. OpenCode's `*`
 * matches any text, `/` and spaces included. A SEGMENT_NAMES name gets one pattern per
 * SEGMENT_STARTS form instead (the name right after a space, a slash, `=` or a quote), so it
 * matches only where a path segment starts with it, never inside `core.git`. Listing commands
 * (`ls`, `find`, `stat`, `du`,
 * `readlink`, `realpath`) get none: names stay visible. `paths` (src/paths.js#resolvePaths) picks
 * the deployment's withheld directories; by default this process's (WITHHELD_ROOTS).
 * @param {{ paths?: { rootDir: string, privateDir: string, dataDir: string } }} [options]
 * @returns {string[]}
 */
export function withheldShellDenies({ paths } = {}) {
  const roots = paths ? withheldRootsOf({ paths }) : WITHHELD_ROOTS;
  const withheld = [...roots, ...WITHHELD_NAMES.filter((name) => !SEGMENT_NAMES.includes(name)), ENV_FORM];
  return SHELL_CONTENT_COMMANDS.flatMap((command) => [
    ...withheld.map((part) => `${command} *${part}*`),
    ...SEGMENT_NAMES.flatMap((name) => SEGMENT_STARTS.map((start) => `${command} ${start}${name}*`)),
  ]);
}

/** A permission value for `bash`: deny-all first, then the allowed command patterns, then `rules`
 * (a class's staged `[pattern, action]` pairs, in order), then `denies` (the withheld-path ones of
 * a filtered scope), then SHELL_DENY_AFTER. */
function bashPermission(allow, rules = [], denies = []) {
  const map = { '*': 'deny' };
  for (const pattern of allow) map[pattern] = 'allow';
  for (const [pattern, action] of rules) map[pattern] = action;
  for (const pattern of denies) map[pattern] = 'deny';
  for (const pattern of SHELL_DENY_AFTER) map[pattern] = 'deny';
  return map;
}

/**
 * The `external_directory` value of a shell class in `scope`: the path tools' value
 * (pathPermission) when its `externalDirectory` is `true`; `*: deny` then each listed directory
 * and everything under it allowed when it is a list (OpenCode asks with a `<dir>/*` resource, and
 * its `*` matches any text, so `<dir>/*` covers the subfolders); else a plain deny.
 */
function externalPermission(externalDirectory, scope) {
  if (externalDirectory === true) return pathPermission(scope);
  if (!Array.isArray(externalDirectory)) return 'deny';
  const map = { '*': 'deny' };
  for (const dir of externalDirectory) {
    map[dir] = 'allow';
    map[`${dir}/*`] = 'allow';
  }
  return map;
}

/** The path tools: each takes `*: allow` then the withheld denies in a filtered scope. */
const PATH_TOOLS = Object.freeze(['read', 'grep', 'glob', 'list']);

/** The network tools: a plain allow when granted. */
const NETWORK_TOOLS = Object.freeze(['websearch', 'webfetch']);

/**
 * The environment the server agent's child runs with (src/agent-runner/opencode.js): git trusts
 * every repository (`safe.directory=*`, set through GIT_CONFIG_COUNT), since its shell only reads
 * and the checkouts it reads belong to other users, which git otherwise refuses as "dubious
 * ownership"; and git never pages.
 */
export const SERVER_CHILD_ENV = Object.freeze({
  GIT_CONFIG_COUNT: '1',
  GIT_CONFIG_KEY_0: 'safe.directory',
  GIT_CONFIG_VALUE_0: '*',
  GIT_PAGER: 'cat',
});

/**
 * The tools denied to every agent whatever its profile asks: no profile can grant one. Beside the
 * writing and delegating ones, every other tool v1.19.3 can expose that no shell class asks for:
 * `skill` and `todowrite` (always on), `lsp`, `plan_exit` and `execute` (behind experimental
 * flags). A tool whose permission is a plain deny is left out of the model's tool list.
 */
export const ALWAYS_DENIED = Object.freeze([
  'edit',
  'write',
  'patch',
  'task',
  'question',
  'skill',
  'todowrite',
  'lsp',
  'plan_exit',
  'execute',
]);

/**
 * The shell classes a worker profile names in `shell`, the permission ceiling of this runner.
 * Each class has `allow`, the patterns its `bash` may run (SHELL_DENY_AFTER always after them);
 * `rules`, staged `[pattern, action]` pairs its `bash` takes in order after `allow` (SCOUT_FILE_RULES);
 * `withheldDenies`, whether a filtered scope adds the per-command withheld-path denies to its
 * `bash` (withheldShellDenies); `tools`, the OpenCode tools a profile of the class may ask for,
 * the most it can get; and `order`, the tools its permission map names before ALWAYS_DENIED, in
 * that order (a tool of `order` the profile does not ask for, or outside `tools`, is denied);
 * `externalDirectory`, what `external_directory` (paths outside the agent's working directory)
 * takes: `true` for the path tools' value (pathPermission), a list for those directories only, in
 * every scope, `false` for a deny (externalPermission); `env`, the
 * variables its OpenCode child runs with over the runner's environment; and `path`, the folders
 * of its own commands put first on the child's PATH. A profile picks a class
 * by name and never carries a pattern itself.
 */
export const SHELL_CLASSES = Object.freeze({
  'server-read-only': Object.freeze({
    allow: SERVER_SHELL_ALLOW,
    rules: Object.freeze([]),
    withheldDenies: true,
    externalDirectory: true,
    tools: Object.freeze(['read', 'grep', 'glob', 'list', 'bash']),
    order: Object.freeze(['read', 'grep', 'glob', 'list', 'bash', 'webfetch', 'websearch']),
    env: SERVER_CHILD_ENV,
    path: Object.freeze([]),
  }),
  'scout-download': Object.freeze({
    allow: SCOUT_SHELL_ALLOW,
    rules: SCOUT_FILE_RULES,
    withheldDenies: false,
    externalDirectory: Object.freeze([SCOUT_TMP_DIR]),
    tools: Object.freeze(['websearch', 'webfetch', 'read', 'glob', 'list', 'bash']),
    order: Object.freeze(['websearch', 'webfetch', 'read', 'glob', 'list', 'grep', 'bash']),
    env: Object.freeze({}),
    path: Object.freeze([SCOUT_TOOLS_DIR]),
  }),
});

/**
 * The V1 permission map of a worker for `scope`: each tool of its class's `order` allowed when
 * the profile asks for it (a path tool with the withheld denies of a filtered scope, `bash` with
 * its class's allow list and rules), else denied; then `external_directory` as the class's
 * `externalDirectory` says (externalPermission); then every tool of ALWAYS_DENIED denied.
 * @param {{ shell: string, tools: readonly string[] }} worker
 * @param {string} scope
 */
function permissionFor({ shell, tools }, scope) {
  const shellClass = SHELL_CLASSES[shell];
  const granted = new Set(tools.filter((tool) => shellClass.tools.includes(tool)));
  const map = {};
  for (const tool of shellClass.order) {
    if (!granted.has(tool)) map[tool] = 'deny';
    else if (PATH_TOOLS.includes(tool)) map[tool] = pathPermission(scope);
    else if (NETWORK_TOOLS.includes(tool)) map[tool] = 'allow';
    else if (tool === 'bash')
      map[tool] = bashPermission(
        shellClass.allow,
        shellClass.rules,
        shellClass.withheldDenies && scope !== 'core' ? withheldShellDenies() : []
      );
  }
  map.external_directory = externalPermission(shellClass.externalDirectory, scope);
  for (const tool of ALWAYS_DENIED) map[tool] = 'deny';
  return map;
}

// ---------------------------------------------------------------------------
// profile.json: the keys and their checks

/** The keys every profile carries, whatever its kind. */
const COMMON_KEYS = Object.freeze(['id', 'kind', 'role', 'prompt', 'override', 'description']);

/** The keys only a worker carries (a consultation naming one is refused as an unknown key). */
const WORKER_KEYS = Object.freeze(['tools', 'shell', 'limits', 'daily', 'searchProvider', 'socket', 'out', 'env']);

/**
 * The keys only a development profile carries: the OpenCode tools it asks for (DEVELOPMENT_TOOLS),
 * the permission rules that narrow them (PERMISSION_ACTIONS), its reasoning effort
 * (DEVELOPMENT_EFFORTS, OpenCode's `--variant`) and its default per-run caps `{ steps, minutes }`.
 */
const DEVELOPMENT_KEYS = Object.freeze(['tools', 'permission', 'effort', 'limits']);

/** The keys of each kind, all required. */
const KEYS_BY_KIND = Object.freeze({
  worker: Object.freeze([...COMMON_KEYS, ...WORKER_KEYS]),
  consultation: COMMON_KEYS,
  development: Object.freeze([...COMMON_KEYS, ...DEVELOPMENT_KEYS]),
});

/**
 * The OpenCode (v1.19.3) tool and permission keys a development profile may ask for. A
 * development agent runs outside this runner, under the dispatcher that builds its config from
 * the profile; this list only bounds what a profile can name. `task` (subagents) and `question`
 * (a headless run cannot answer it) are never on it, nor the experimental `lsp`, `plan_exit`
 * and `execute`.
 */
export const DEVELOPMENT_TOOLS = Object.freeze([
  'bash',
  'read',
  'grep',
  'glob',
  'list',
  'edit',
  'write',
  'patch',
  'webfetch',
  'websearch',
  'todowrite',
  'skill',
  'external_directory',
]);

/**
 * The OpenCode permission actions a development profile's `permission` rules may name. `permission`
 * maps a tool of the profile's `tools` to one action or to an object of command patterns (OpenCode
 * wildcards: `*`, `?`; the last matching pattern wins) and their actions. It can only narrow what the
 * dispatcher grants, never widen it.
 */
export const PERMISSION_ACTIONS = Object.freeze(['allow', 'ask', 'deny']);

/** The reasoning efforts a development profile may name (OpenCode's `--variant`). */
export const DEVELOPMENT_EFFORTS = Object.freeze(['low', 'medium', 'high', 'max']);

/** An agent id, the name of its folder: lowercase letters, digits and dashes. */
const ID_PATTERN = /^[a-z][a-z0-9-]*$/;

/** A file name inside a folder (a prompt, an override): no directory part, a `.md` file. */
const FILE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*\.md$/;

/** An environment variable name. */
const ENV_NAME_PATTERN = /^[A-Z][A-Z0-9_]*$/;

/** A web search provider name, as OpenCode takes it. */
const PROVIDER_PATTERN = /^[a-z][a-z0-9-]*$/;

/** The error a profile that cannot be used fails `listAgents` / `loadProfiles` with: one line naming the agent and the key. */
export class AgentProfileError extends Error {
  /**
   * @param {string} agent  the agent's folder name
   * @param {string} key    the offending key (`limits.steps` for a nested one)
   * @param {string} reason
   */
  constructor(agent, key, reason) {
    super(`agent profile "${agent}": key "${key}": ${reason}`);
    this.name = 'AgentProfileError';
    this.agent = agent;
    this.key = key;
  }
}

/** Whether `value` is a plain JSON object. */
function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Whether `value` is a positive finite number, and a whole one when `whole`. */
function isPositive(value, whole = false) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && (!whole || Number.isInteger(value));
}

/**
 * Checks an object of positive numbers with exactly the keys of `spec` (`{ key: whole }`), for
 * `limits` and `daily`.
 */
function checkNumbers(agent, key, value, spec) {
  if (!isObject(value)) throw new AgentProfileError(agent, key, 'must be an object');
  for (const name of Object.keys(value)) {
    if (!Object.hasOwn(spec, name)) throw new AgentProfileError(agent, `${key}.${name}`, 'unknown key');
  }
  for (const [name, whole] of Object.entries(spec)) {
    if (!Object.hasOwn(value, name)) throw new AgentProfileError(agent, `${key}.${name}`, 'missing');
    if (!isPositive(value[name], whole))
      throw new AgentProfileError(
        agent,
        `${key}.${name}`,
        whole ? 'must be a positive whole number' : 'must be a positive number'
      );
  }
}

/** Checks a file name key: a plain `.md` name inside its folder, or null when `nullable`. */
function checkFileName(agent, key, value, nullable) {
  if (value === null && nullable) return;
  if (typeof value !== 'string' || !FILE_NAME_PATTERN.test(value)) {
    throw new AgentProfileError(
      agent,
      key,
      `must be a .md file name with no directory part${nullable ? ', or null' : ''}`
    );
  }
}

/** Checks `tools`: a non-empty list of distinct names, each one of `allowed` (`where` names the bound in the error). */
function checkTools(agent, tools, allowed, where) {
  if (!Array.isArray(tools) || tools.length === 0)
    throw new AgentProfileError(agent, 'tools', 'must be a non-empty list');
  for (const tool of tools) {
    if (!allowed.includes(tool))
      throw new AgentProfileError(
        agent,
        'tools',
        `unknown tool ${JSON.stringify(tool)} ${where} (allowed: ${allowed.join(', ')})`
      );
  }
  if (new Set(tools).size !== tools.length) throw new AgentProfileError(agent, 'tools', 'names a tool twice');
}

/** Checks a development profile's `permission`: tool -> action, or tool -> { pattern: action }, tools from `tools`. */
function checkPermission(agent, permission, tools) {
  if (!isObject(permission))
    throw new AgentProfileError(
      agent,
      'permission',
      'must be an object of tool -> action or tool -> { pattern: action }'
    );
  const actions = `must be one of ${PERMISSION_ACTIONS.join(', ')}`;
  for (const [tool, rules] of Object.entries(permission)) {
    if (!tools.includes(tool))
      throw new AgentProfileError(agent, `permission.${tool}`, 'names a tool the profile does not ask for');
    if (typeof rules === 'string') {
      if (!PERMISSION_ACTIONS.includes(rules)) throw new AgentProfileError(agent, `permission.${tool}`, actions);
      continue;
    }
    if (!isObject(rules) || Object.keys(rules).length === 0)
      throw new AgentProfileError(
        agent,
        `permission.${tool}`,
        'must be an action or a non-empty object of pattern -> action'
      );
    for (const [pattern, action] of Object.entries(rules)) {
      if (!pattern.trim()) throw new AgentProfileError(agent, `permission.${tool}`, 'has an empty pattern');
      if (!PERMISSION_ACTIONS.includes(action))
        throw new AgentProfileError(agent, `permission.${tool}.${pattern}`, actions);
    }
  }
}

/** Checks an absolute path default (`socket`, `out`). */
function checkAbsolute(agent, key, value) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || value.includes('\0'))
    throw new AgentProfileError(agent, key, 'must be an absolute path');
}

/**
 * Validates the parsed `profile.json` of the agent in folder `agent`: every key of its kind
 * present, no other key, each value of the right form; for a worker the shell class one this
 * runner defines (SHELL_CLASSES) and every tool one that class allows. Throws AgentProfileError
 * at the first problem.
 * @param {string} agent  the folder name
 * @param {unknown} raw
 */
function validateProfile(agent, raw) {
  if (!isObject(raw)) throw new AgentProfileError(agent, PROFILE_FILE, 'must be a JSON object');
  if (!Object.hasOwn(raw, 'kind')) throw new AgentProfileError(agent, 'kind', 'missing');
  if (!Object.hasOwn(KEYS_BY_KIND, raw.kind))
    throw new AgentProfileError(agent, 'kind', `must be one of ${Object.keys(KEYS_BY_KIND).join(', ')}`);
  const worker = raw.kind === 'worker';
  const development = raw.kind === 'development';
  const keys = KEYS_BY_KIND[raw.kind];
  for (const key of Object.keys(raw)) {
    if (!keys.includes(key))
      throw new AgentProfileError(
        agent,
        key,
        worker || !WORKER_KEYS.includes(key) ? 'unknown key' : `unknown key (a ${raw.kind} profile has no runner)`
      );
  }
  for (const key of keys) {
    if (!Object.hasOwn(raw, key)) throw new AgentProfileError(agent, key, 'missing');
  }

  if (raw.id !== agent) throw new AgentProfileError(agent, 'id', 'must be the folder name');
  if (!ID_PATTERN.test(agent)) throw new AgentProfileError(agent, 'id', 'must be lowercase letters, digits and dashes');
  const roles = development ? DEVELOPMENT_ROLES : OPENCODE_ROLES;
  if (!roles.includes(raw.role)) throw new AgentProfileError(agent, 'role', `must be one of ${roles.join(', ')}`);
  checkFileName(agent, 'prompt', raw.prompt, !worker && !development);
  checkFileName(agent, 'override', raw.override, !worker);
  if (typeof raw.description !== 'string' || !raw.description.trim())
    throw new AgentProfileError(agent, 'description', 'must be a non-empty string');
  if (development) {
    checkTools(agent, raw.tools, DEVELOPMENT_TOOLS, 'for a development profile');
    checkPermission(agent, raw.permission, raw.tools);
    if (!DEVELOPMENT_EFFORTS.includes(raw.effort))
      throw new AgentProfileError(agent, 'effort', `must be one of ${DEVELOPMENT_EFFORTS.join(', ')}`);
    checkNumbers(agent, 'limits', raw.limits, { steps: true, minutes: false });
    return;
  }
  if (!worker) return;

  if (!Object.hasOwn(SHELL_CLASSES, raw.shell))
    throw new AgentProfileError(
      agent,
      'shell',
      `unknown shell class ${JSON.stringify(raw.shell)} (known: ${Object.keys(SHELL_CLASSES).join(', ')})`
    );
  checkTools(agent, raw.tools, SHELL_CLASSES[raw.shell].tools, `for shell class ${raw.shell}`);
  checkNumbers(agent, 'limits', raw.limits, { steps: true, seconds: false });
  checkNumbers(agent, 'daily', raw.daily, { tasks: true });
  if (
    raw.searchProvider !== null &&
    (typeof raw.searchProvider !== 'string' || !PROVIDER_PATTERN.test(raw.searchProvider))
  ) {
    throw new AgentProfileError(agent, 'searchProvider', 'must be a provider name or null');
  }
  checkAbsolute(agent, 'socket', raw.socket);
  checkAbsolute(agent, 'out', raw.out);
  if (!Array.isArray(raw.env) || raw.env.some((name) => typeof name !== 'string' || !ENV_NAME_PATTERN.test(name))) {
    throw new AgentProfileError(agent, 'env', 'must be a list of environment variable names');
  }
}

/** A deep-frozen copy of a parsed JSON value. */
function frozenCopy(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(frozenCopy));
  if (isObject(value))
    return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, frozenCopy(entry)])));
  return value;
}

/**
 * Every agent described under `<rootDir>/agents/`, of every kind, as their
 * validated `profile.json` (deep-frozen), sorted by id: the reader for the docs, the tools and
 * later the persona's list of her agents. A file directly under `agents/` (its README) is not an
 * agent; a folder without a readable, valid `profile.json` fails with AgentProfileError.
 * @param {{ rootDir?: string }} [options]
 * @returns {readonly object[]}
 */
export function listAgents({ rootDir = ROOT_DIR } = {}) {
  const agentsDir = path.join(rootDir, AGENTS_DIRNAME);
  const folders = fs
    .readdirSync(agentsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  return Object.freeze(
    folders.map((agent) => {
      let raw;
      try {
        raw = JSON.parse(fs.readFileSync(path.join(agentsDir, agent, PROFILE_FILE), 'utf8'));
      } catch (err) {
        throw new AgentProfileError(
          agent,
          PROFILE_FILE,
          err?.code === 'ENOENT' ? 'missing' : `unreadable (${err?.code ?? err?.name ?? 'parse'})`
        );
      }
      validateProfile(agent, raw);
      return frozenCopy(raw);
    })
  );
}

/**
 * One worker profile, the object the runner and the core use, from its validated description.
 * @param {object} definition  a worker's validated profile.json
 * @param {{ rootDir: string, env: Record<string, string | undefined> }} where
 * @returns {object}
 */
function makeProfile(definition, { rootDir, env }) {
  const { id: name, role: modelRole } = definition;
  const defaultModel = ROLE_DEFAULTS[modelRole];
  const agentId = `errand-${name}`;
  return {
    name,
    kind: definition.kind,
    description: definition.description,
    // The OpenCode agent name of one task's config (`--agent`).
    agentId,
    promptFiles: promptFilesOf(name, { rootDir, env, override: definition.override, prompt: definition.prompt }),
    envNames: definition.env,
    // The model role (src/llm/roles.js) whose model the agent runs on: `models.<group>.<modelRole>`,
    // else its default, which is `defaultModel`.
    modelRole,
    defaultModel,
    // The tools the profile asks for and its shell class (SHELL_CLASSES): what buildConfig grants.
    tools: definition.tools,
    shell: definition.shell,
    // The variables its OpenCode child runs with over the runner's environment (its shell class's `env`).
    childEnv: SHELL_CLASSES[definition.shell].env,
    // The folders of its own commands, first on its child's PATH (its shell class's `path`).
    pathDirs: SHELL_CLASSES[definition.shell].path,
    defaultLimits: definition.limits,
    defaultDaily: definition.daily,
    defaultSearchProvider: definition.searchProvider,
    // Where the runner listens and writes its files when `agents.<profile>.socket` / `.out` are unset.
    defaultSocket: definition.socket,
    defaultOut: definition.out,
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
        permission: permissionFor(definition, scope),
      };
      if (Number.isFinite(steps) && steps > 0) agent.steps = Math.floor(steps);
      const config = {
        $schema: 'https://opencode.ai/config.json',
        agent: { [agentId]: agent },
      };
      if (modelId) config.model = `${providerId}/${modelId}`;
      if (cost && Number.isFinite(cost.input) && Number.isFinite(cost.output) && modelId) {
        config.provider = {
          [providerId]: { models: { [modelId]: { cost: { input: cost.input, output: cost.output } } } },
        };
      }
      if (Number.isFinite(toolResultChars) && toolResultChars > 0)
        config.tool_output = { max_bytes: Math.floor(toolResultChars) };
      return config;
    },
  };
}

/**
 * The worker profiles under `<rootDir>/agents/`, by id: every agent of kind `worker` (a
 * consultation or a development profile has no runner here and is skipped), each validated (listAgents) and built into the
 * profile object the runner and the core use. Throws AgentProfileError on the first profile that
 * cannot be used, so a bad file stops the process at start.
 * @param {{ rootDir?: string, env?: Record<string, string | undefined> }} [options]
 * @returns {Readonly<Record<string, object>>}
 */
export function loadProfiles({ rootDir = ROOT_DIR, env = process.env } = {}) {
  const workers = listAgents({ rootDir }).filter((definition) => definition.kind === 'worker');
  return Object.freeze(
    Object.fromEntries(workers.map((definition) => [definition.id, makeProfile(definition, { rootDir, env })]))
  );
}

/** The profiles of this engine's `agents/` folder, by name, loaded once at import. */
export const PROFILES = loadProfiles();

/** The `scout` profile: internet errands through OpenCode's web tools and a curl/ffmpeg download shell. */
export const SCOUT = PROFILES.scout ?? null;

/** The `server` profile: read-only shell and file reads on the server, no network. */
export const SERVER = PROFILES.server ?? null;

/** The profile of `name`, or null. */
export function profileOf(name) {
  return Object.hasOwn(PROFILES, name) ? PROFILES[name] : null;
}
