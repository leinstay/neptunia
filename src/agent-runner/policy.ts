// The scope policy of the agent runners: what an errand may disclose depends
// on where the persona was asked. The request carries `context.scope`: `core`
// (the owner's own console) redacts nothing, and `dm` and `group` (a private
// chat or group of a chat interface) redact secret-looking strings from the
// text that leaves the runner. A request without a valid scope is treated as
// `group`, the narrowest. `redactSecrets(text)` turns key-, token- and
// password-looking strings, private-key blocks, SSH key material and URL
// credentials into `[redacted]`. Pure.

/** The scopes a request may carry. */
export const SCOPES = ['core', 'dm', 'group'] as const;
/** The scope of a request that names none. */
export const DEFAULT_SCOPE = 'group';
/** The scopes in which secrets are redacted. */
export const FILTERED_SCOPES = Object.freeze(['dm', 'group']);
/** The replacement of a redacted string. */
export const REDACTED = '[redacted]';

/**
 * The scope of a request context: its `scope` when it is one of SCOPES,
 * else DEFAULT_SCOPE.
 */
export function scopeOf(context?: { scope?: unknown }): 'core' | 'dm' | 'group' {
  const scope = context?.scope;
  return SCOPES.find((known) => known === scope) ?? DEFAULT_SCOPE;
}

/** Whether `scope` redacts secrets. */
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
