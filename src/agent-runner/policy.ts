// The scope policy of the agent runners: what an errand may disclose depends
// on where the persona was asked. The request carries `context.scope`: `core`
// (the owner's own console) withholds nothing; `dm` and `group` (a
// private chat or group of a chat interface) withhold the content of sensitive paths and redact
// secret-looking strings from what leaves the runner. A request without a
// valid scope is treated as `group`, the narrowest.
//
// The agents run on OpenCode, so the cut is the agent config's: the server
// agent's `bash` is allow-listed to read-only commands, and in `dm` and
// `group` the config (src/agent-runner/profiles.ts) also denies `read`/`grep`/...
// of the withheld paths this module lists (`WITHHELD_ROOTS`, `WITHHELD_NAMES`,
// `WITHHELD_GLOBS`). `redactSecrets(text)` turns key-, token- and
// password-looking strings, private-key blocks, SSH key material and URL
// credentials into `[redacted]`. Pure. The withheld roots include the deployment's data directory,
// resolved once at load from NEPTUNIA_DATA_DIR (src/paths.ts), so the policy
// follows the layout the unit sets.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolvePaths } from '../paths.ts';

/** The engine root (two levels up from this file). */
const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** The scopes a request may carry. */
export const SCOPES = ['core', 'dm', 'group'] as const;
/** The scope of a request that names none. */
export const DEFAULT_SCOPE = 'group';
/** The scopes in which content is withheld and secrets are redacted. */
export const FILTERED_SCOPES = Object.freeze(['dm', 'group']);
/** The replacement of a redacted string. */
export const REDACTED = '[redacted]';

/** Absolute paths whose content is withheld in `dm` and `group` whatever the deployment's layout. */
const FIXED_ROOTS = Object.freeze([
  '/var/www',
  '/srv/neptunia-backups',
  '/etc/shadow',
  '/etc/gshadow',
  '/etc/nginx/htpasswd',
  '/etc/letsencrypt',
  '/etc/neptunia',
]);

/**
 * The deployment's own withheld directories: its data directory (the persona's memory about real
 * people) and, when it is apart from the checkout, its private directory (.env, config.local/,
 * prompts.local/). Pure.
 * @param paths src/paths.ts#resolvePaths
 */
function deploymentRootsOf(paths: { rootDir: string; privateDir: string; dataDir: string }): Array<string> {
  return paths.privateDir === paths.rootDir ? [paths.dataDir] : [paths.dataDir, paths.privateDir];
}

/** This checkout's directories, resolved from the process environment. */
function defaultPaths(): { rootDir: string; privateDir: string; dataDir: string } {
  return resolvePaths({ rootDir: ROOT_DIR });
}

/**
 * Absolute paths whose content is withheld in `dm` and `group` (everything under them too): the
 * fixed ones, then the deployment's data and private directories (`paths`, by default this
 * checkout's resolved from the process environment, so the policy follows the layout the unit
 * sets). Pure but for reading the environment when `paths` is not given.
 */
export function withheldRootsOf({
  paths = defaultPaths(),
}: { paths?: { rootDir: string; privateDir: string; dataDir: string } } = {}): ReadonlyArray<string> {
  return Object.freeze([...new Set([...FIXED_ROOTS, ...deploymentRootsOf(paths)])]);
}

/** Absolute paths whose content is withheld in `dm` and `group` (everything under them too), for this process. */
export const WITHHELD_ROOTS = withheldRootsOf();
/** Path components that withhold the path wherever they appear. */
export const WITHHELD_NAMES = Object.freeze([
  '.git',
  '.local.git',
  '.secrets',
  '.ssh',
  'config.local.json',
  'config.local',
  'scratch',
]);

/** The glob patterns of the fixed roots and the names, before the deployment's directories. */
const FIXED_GLOBS = Object.freeze([
  '/var/www',
  '/var/www/**',
  '/srv/neptunia-backups',
  '/srv/neptunia-backups/**',
  '/etc/shadow',
  '/etc/gshadow',
  '/etc/nginx/htpasswd',
  '/etc/nginx/htpasswd/**',
  '/etc/letsencrypt',
  '/etc/letsencrypt/**',
  '/etc/neptunia',
  '/etc/neptunia/**',
  '**/.git',
  '**/.git/**',
  '**/.local.git',
  '**/.local.git/**',
  '**/.secrets',
  '**/.secrets/**',
  '**/.ssh',
  '**/.ssh/**',
  '**/config.local.json',
  '**/config.local',
  '**/config.local/**',
  '**/.env',
  '**/.env.*',
]);
/** The glob patterns after the deployment's directories. */
const TRAILING_GLOBS = Object.freeze(['**/data/places', '**/data/places/**']);

/**
 * The glob patterns a config denies for a path tool in a filtered scope (OpenCode's
 * `read`/`grep`/... resources): the fixed ones, `<dir>` and `<dir>/**` for each of the
 * deployment's directories (`paths` as in `withheldRootsOf`), then the trailing ones.
 */
export function withheldGlobsOf({
  paths = defaultPaths(),
}: { paths?: { rootDir: string; privateDir: string; dataDir: string } } = {}): ReadonlyArray<string> {
  const deployment = deploymentRootsOf(paths).flatMap((dir) => [dir, `${dir}/**`]);
  return Object.freeze([...new Set([...FIXED_GLOBS, ...deployment, ...TRAILING_GLOBS])]);
}

/** The glob patterns a config denies for a path tool in a filtered scope, for this process. */
export const WITHHELD_GLOBS = withheldGlobsOf();

/**
 * The scope of a request context: its `scope` when it is one of SCOPES,
 * else DEFAULT_SCOPE.
 */
export function scopeOf(context?: { scope?: unknown }): 'core' | 'dm' | 'group' {
  const scope = context?.scope;
  return SCOPES.find((known) => known === scope) ?? DEFAULT_SCOPE;
}

/** Whether `scope` withholds content and redacts secrets. */
export function isFiltered(scope: unknown): boolean {
  return FILTERED_SCOPES.some((filtered) => filtered === scope);
}

// ---- redaction ----------------------------------------------------------------

const PRIVATE_KEY_BLOCK = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g;
const SSH_KEY = /\b(ssh-(?:ed25519|rsa|dss)|ecdsa-sha2-nistp\d+|sk-ssh-ed25519@openssh\.com)\s+[A-Za-z0-9+/=]{16,}/g;
const URL_CREDENTIALS = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi;
const BEARER = /\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{8,}/g;
const PREFIXED =
  /\b(?:sk-[A-Za-z0-9_-]{16,}|xai-[A-Za-z0-9_-]{16,}|(?:AKIA|ASIA)[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{16,}|xox[abprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{30,})/g;
const DOTTED_TOKEN = /\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{20,}\b/g;
const ASSIGNMENT =
  /\b([\w.-]*(?:key|token|secret|passw(?:or)?d|passphrase|pwd|credentials?|auth)[\w.-]*)(["']?)(\s*[=:]\s*)("[^"\n]*"|'[^'\n]*'|[^\s,;}\]]+)/gi;
const LONG_RUN = /[A-Za-z0-9+/_=-]{32,}/g;
const HEX_RUN = /\b[A-Fa-f0-9]{32,}\b/g;

/** Whether `run` mixes upper case, lower case and digits (a key, not a word or a path). */
function looksRandom(run: string): boolean {
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
 */
export function redactSecrets(text: string): string {
  return String(text ?? '')
    .replace(PRIVATE_KEY_BLOCK, REDACTED)
    .replace(SSH_KEY, `$1 ${REDACTED}`)
    .replace(URL_CREDENTIALS, `$1${REDACTED}@`)
    .replace(BEARER, `$1 ${REDACTED}`)
    .replace(PREFIXED, REDACTED)
    .replace(DOTTED_TOKEN, REDACTED)
    .replace(ASSIGNMENT, (whole: string, name: string, quote: string, sep: string, value: string) =>
      value.includes(REDACTED) ? whole : `${name}${quote}${sep}${REDACTED}`
    )
    .replace(HEX_RUN, (run) => (/\d/.test(run) && /[A-Fa-f]/.test(run) ? REDACTED : run))
    .replace(LONG_RUN, (run) => (looksRandom(run) ? REDACTED : run));
}

/**
 * Whether `text` holds anything `redactSecrets` would redact (the same
 * patterns, so a file is judged exactly like the final text). Pure.
 */
export function containsSecret(text: string): boolean {
  const s = String(text ?? '');
  return redactSecrets(s) !== s;
}

/**
 * The redaction of a scope: `redactSecrets` in `dm` and `group`, the text
 * unchanged in `core`.
 */
export function redactorFor(scope: string): (text: string) => string {
  return isFiltered(scope) ? redactSecrets : (text) => String(text ?? '');
}
