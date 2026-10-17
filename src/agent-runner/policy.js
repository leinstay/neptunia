// The scope policy of the agent runners: what an errand may disclose depends
// on where the persona was asked. The request carries `context.scope`: `core`
// (the owner's own console) withholds nothing; `dm` and `group` (a Discord
// private chat or group) withhold the content of sensitive paths and redact
// secret-looking strings from what leaves the runner. A request without a
// valid scope is treated as `group`, the narrowest.
//
// The agents run on OpenCode, so most of the cut is the agent config's: the
// server agent's `bash` is allow-listed to read-only commands, and in `dm`
// and `group` the config also denies `read`/`grep`/... of the withheld paths.
// This module is the engine-side backstop OpenCode's command parsing cannot
// give on its own:
// - `withheldInToolUse(event, scope)`: whether a tool-call event OpenCode
//   reports names a withheld path (`WITHHELD_ROOTS`, `WITHHELD_NAMES`). When
//   it does in `dm`/`group`, the runner interrupts the task and fails it with
//   `withheld-path`, which she reads as "visible, not readable here". Listing
//   names is allowed; opening content is not, so a `bash` command is examined
//   only when it reads (`cat`, `grep`, ...), not when it lists (`ls`, `find`
//   without `-exec`).
// - `redactSecrets(text)`: key-, token- and password-looking strings,
//   private-key blocks, SSH key material and URL credentials become
//   `[redacted]`.
// Both pure.

/** The scopes a request may carry. */
export const SCOPES = Object.freeze(['core', 'dm', 'group']);
/** The scope of a request that names none. */
export const DEFAULT_SCOPE = 'group';
/** The scopes in which content is withheld and secrets are redacted. */
export const FILTERED_SCOPES = Object.freeze(['dm', 'group']);
/** The replacement of a redacted string. */
export const REDACTED = '[redacted]';

/** Absolute paths whose content is withheld in `dm` and `group` (everything under them too). */
export const WITHHELD_ROOTS = Object.freeze([
  '/var/www', '/srv/git', '/srv/neptunia-backups', '/etc/shadow', '/etc/gshadow', '/etc/nginx/htpasswd',
  '/etc/letsencrypt', '/etc/neptunia', '/opt/neptunia-bot/data',
]);
/** Path components that withhold the path wherever they appear. */
export const WITHHELD_NAMES = Object.freeze(['.git', '.local.git', '.secrets', '.ssh', 'config.local.json', 'scratch']);
/** A `.env` file (`.env`, `.env.local`, ...) is withheld wherever it is. */
const ENV_FILE = /^\.env(?:\..+)?$/;
/** The glob patterns a config denies for a path tool in a filtered scope (OpenCode's `read`/`grep`/... resources). */
export const WITHHELD_GLOBS = Object.freeze([
  '/var/www', '/var/www/**', '/srv/git', '/srv/git/**', '/srv/neptunia-backups', '/srv/neptunia-backups/**',
  '/etc/shadow', '/etc/gshadow', '/etc/nginx/htpasswd', '/etc/nginx/htpasswd/**', '/etc/letsencrypt',
  '/etc/letsencrypt/**', '/etc/neptunia', '/etc/neptunia/**',
  '**/.git', '**/.git/**', '**/.local.git', '**/.local.git/**', '**/.secrets', '**/.secrets/**',
  '**/.ssh', '**/.ssh/**', '**/config.local.json', '**/.env', '**/.env.*',
  '/opt/neptunia-bot/data', '/opt/neptunia-bot/data/**', '**/data/guilds', '**/data/guilds/**', '**/.agents/scratch', '**/.agents/scratch/**',
]);

/** Bash command words that open file contents (so their path arguments are checked). */
const READERS = new Set([
  'cat', 'tac', 'less', 'more', 'head', 'tail', 'nl', 'od', 'xxd', 'hexdump', 'strings', 'base64', 'cut', 'column',
  'grep', 'egrep', 'fgrep', 'rg', 'ag', 'ack', 'zgrep', 'zcat', 'bzcat', 'xzcat',
  'awk', 'gawk', 'sed', 'perl', 'python', 'python3', 'ruby', 'node', 'php',
  'sort', 'uniq', 'diff', 'comm', 'paste', 'join', 'tr', 'fold', 'fmt', 'expand', 'wc',
  'cp', 'install', 'tar', 'zip', 'gzip', 'openssl', 'gpg', 'jq', 'yq', 'md5sum', 'sha1sum', 'sha256sum',
  'readlink', 'realpath', 'file', 'git', 'vi', 'vim', 'nano', 'emacs', 'source',
]);
/** Wrappers whose first non-flag argument is the real command. */
const WRAPPERS = new Set(['sudo', 'env', 'nohup', 'nice', 'ionice', 'time', 'command', 'stdbuf', 'xargs', 'exec', 'timeout', 'watch', 'bash', 'sh', 'zsh', 'ksh', 'dash']);

/**
 * The scope of a request context: its `scope` when it is one of SCOPES,
 * else DEFAULT_SCOPE.
 * @param {object} [context]
 * @returns {'core'|'dm'|'group'}
 */
export function scopeOf(context) {
  const scope = context?.scope;
  return SCOPES.includes(scope) ? scope : DEFAULT_SCOPE;
}

/** Whether `scope` withholds content and redacts secrets. */
export function isFiltered(scope) {
  return FILTERED_SCOPES.includes(scope);
}

/**
 * Whether `p` (a path, absolute or not) is withheld: under a WITHHELD_ROOTS
 * entry, or with a WITHHELD_NAMES component, or a `.env` file.
 * @param {string} p
 * @returns {boolean}
 */
export function isWithheldPath(p) {
  const text = String(p ?? '').trim().replace(/\/+$/, '') || '/';
  if (WITHHELD_ROOTS.some((root) => text === root || text.startsWith(`${root}/`))) return true;
  return text.split('/').filter(Boolean).some((part) => WITHHELD_NAMES.includes(part) || ENV_FILE.test(part));
}

/** Whether a withheld root lies at or under `p` (a listing of a parent is allowed, a read of it is not). */
function pathReachesWithheld(p) {
  const text = String(p ?? '').trim().replace(/\/+$/, '');
  if (!text) return false;
  const prefix = `${text}/`;
  return WITHHELD_ROOTS.some((root) => root === text || root.startsWith(prefix) || text.startsWith(`${root}/`) || text === root)
    || isWithheldPath(text);
}

/** The path-looking tokens of a bash command (quotes stripped, flags and operators dropped). */
function pathTokensOf(command) {
  const text = String(command ?? '').replace(/'[^']*'/g, (m) => m.slice(1, -1)).replace(/"((?:[^"\\]|\\.)*)"/g, '$1');
  return text
    .split(/[\s;|&><()]+/)
    .filter((tok) => tok && !/^-/.test(tok) && !/^[A-Za-z_]\w*=/.test(tok))
    .map((tok) => {
      const eq = tok.indexOf('=');
      return eq > 0 && /^--?[a-z]/i.test(tok) ? tok.slice(eq + 1) : tok;
    })
    .filter(Boolean);
}

/** The leading command words of each pipeline segment, wrappers unwrapped. */
function commandWordsOf(command) {
  const segments = String(command ?? '').split(/[;\n]|\|\||&&|[|&]/);
  const words = [];
  for (const segment of segments) {
    const toks = segment.trim().split(/\s+/).filter(Boolean);
    let i = 0;
    while (i < toks.length && (/^[A-Za-z_]\w*=/.test(toks[i]) || WRAPPERS.has(toks[i].replace(/^.*\//, '')))) {
      // a shell wrapper with -c is a nested command: treat the whole thing as a reader (conservative)
      if (/^(?:ba|z|k|da)?sh$/.test(toks[i].replace(/^.*\//, '')) && toks.slice(i + 1).some((t) => /^-\w*c/.test(t))) { words.push('sh-c'); break; }
      i += 1;
    }
    if (i < toks.length) words.push(toks[i].replace(/^.*\//, ''));
  }
  return words;
}

/** Whether a bash command only lists names / metadata (never opens content). */
function isListingOnly(command) {
  const words = commandWordsOf(command);
  if (!words.length) return false;
  const text = String(command ?? '');
  return words.every((w) => {
    if (w === 'sh-c') return false;
    if (READERS.has(w)) return false;
    if (w === 'find') return !/\s-(?:exec|execdir|ok|okdir|fprint\w*|fls)\b/.test(text);
    return true;
  });
}

/** The withheld path a read of `command` would open, or null. Listing-only commands return null. */
function withheldInBash(command) {
  if (isListingOnly(command)) return null;
  for (const token of pathTokensOf(command)) {
    if (pathReachesWithheld(token)) return token;
  }
  // A reader with no path token (reads stdin / a pipe) cannot be checked by path: let it run.
  return null;
}

/**
 * The withheld path a tool-call event would open, or null. In `core` nothing
 * is withheld. OpenCode's tool-call events carry `{ tool, input }` (or a
 * nested `state.input`); the path tools (`read`, `grep`, `glob`, `list`)
 * carry `path`/`pattern`/`filePath`, `bash`/`shell` carry `command`.
 * @param {{ tool?: string, name?: string, input?: object, state?: { input?: object } }} event
 * @param {string} scope
 * @returns {string|null}
 */
export function withheldInToolUse(event, scope) {
  if (!isFiltered(scope)) return null;
  const tool = String(event?.tool ?? event?.name ?? '').toLowerCase();
  const input = event?.input ?? event?.state?.input ?? {};
  if (tool === 'bash' || tool === 'shell') return withheldInBash(input.command ?? input.cmd ?? '');
  if (tool === 'read' || tool === 'view') {
    const p = input.filePath ?? input.path ?? input.file ?? '';
    return pathReachesWithheld(p) ? String(p) : null;
  }
  if (tool === 'grep' || tool === 'glob' || tool === 'list' || tool === 'ls') {
    const p = input.path ?? input.pattern ?? input.filePath ?? '';
    // listing a directory is allowed; a content search (grep) of one is not
    if ((tool === 'list' || tool === 'ls') && !isWithheldPath(String(p))) return null;
    return pathReachesWithheld(p) ? String(p) : null;
  }
  if (tool === 'webfetch' || tool === 'fetch') return null;
  return null;
}

// ---- redaction ----------------------------------------------------------------

const PRIVATE_KEY_BLOCK = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g;
const SSH_KEY = /\b(ssh-(?:ed25519|rsa|dss)|ecdsa-sha2-nistp\d+|sk-ssh-ed25519@openssh\.com)\s+[A-Za-z0-9+/=]{16,}/g;
const URL_CREDENTIALS = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi;
const BEARER = /\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{8,}/g;
const PREFIXED = /\b(?:sk-[A-Za-z0-9_-]{16,}|xai-[A-Za-z0-9_-]{16,}|(?:AKIA|ASIA)[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{16,}|xox[abprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{30,})/g;
const DOTTED_TOKEN = /\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{20,}\b/g;
const ASSIGNMENT = /\b([\w.-]*(?:key|token|secret|passw(?:or)?d|passphrase|pwd|credentials?|auth)[\w.-]*)(["']?)(\s*[=:]\s*)("[^"\n]*"|'[^'\n]*'|[^\s,;}\]]+)/gi;
const LONG_RUN = /[A-Za-z0-9+/_=-]{32,}/g;
const HEX_RUN = /\b[A-Fa-f0-9]{32,}\b/g;

/** Whether `run` mixes upper case, lower case and digits (a key, not a word or a path). */
function looksRandom(run) {
  return /[A-Z]/.test(run) && /[a-z]/.test(run) && /\d/.test(run) && !/\/[a-z]+\//.test(run);
}

/**
 * `text` with secret-looking strings replaced by `[redacted]`: private-key
 * blocks, SSH key material, URL credentials (`user:pass@`), bearer tokens,
 * known key prefixes (`sk-`, `xai-`, `AKIA`, `ghp_`, ...), three-part dotted
 * tokens (JWT, bot tokens), the values of key/token/secret/password
 * assignments (`KEY=...`, `"password": "..."`), hex runs of 32+ characters
 * with a digit and a letter, and mixed-case alphanumeric runs of 32+ with a
 * digit. Pure.
 * @param {string} text
 * @returns {string}
 */
export function redactSecrets(text) {
  return String(text ?? '')
    .replace(PRIVATE_KEY_BLOCK, REDACTED)
    .replace(SSH_KEY, `$1 ${REDACTED}`)
    .replace(URL_CREDENTIALS, `$1${REDACTED}@`)
    .replace(BEARER, `$1 ${REDACTED}`)
    .replace(PREFIXED, REDACTED)
    .replace(DOTTED_TOKEN, REDACTED)
    .replace(ASSIGNMENT, (whole, name, quote, sep, value) => (value.includes(REDACTED) ? whole : `${name}${quote}${sep}${REDACTED}`))
    .replace(HEX_RUN, (run) => (/\d/.test(run) && /[A-Fa-f]/.test(run) ? REDACTED : run))
    .replace(LONG_RUN, (run) => (looksRandom(run) ? REDACTED : run));
}

/**
 * The redaction of a scope: `redactSecrets` in `dm` and `group`, the text
 * unchanged in `core`.
 * @param {string} scope
 * @returns {(text: string) => string}
 */
export function redactorFor(scope) {
  return isFiltered(scope) ? redactSecrets : (text) => String(text ?? '');
}
