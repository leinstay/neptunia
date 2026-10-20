// The catalogue of codes: every refusal, failure and drop code the engine emits for a call, a
// send, a turn or a wake, with the status it reports under, the values its label may take and
// where its wording lives. Every emitter imports its code from here (`CODE.NOT_FOUND`, never the
// string): a code that is not in the table throws at the first use, and tests/skills-codes.test.js
// greps src/ for a string literal in a code position. The wording is never here: a `skill` code is
// worded by `labels.skills.result.reasons.<code>` (the call mark in the transcript, the `<result>`
// block and the facts read the same label with the same values), a `wake` code by
// `labels.wake.feedback.codes.<code>`; `internal` codes are history or transport details the
// persona is never told by themselves. `tools/labels-catalogue.mjs --check` compares this table,
// the labels and the contract's list. This module imports nothing, so any module may import it.
//
// Fields of an entry: `status` the result status the code is reported under by default (`ok`,
// `denied`, `invalid`, `not_configured`, `failed`, `partial`, `unknown`); `group` where the wording
// lives (`skill`, `wake`, `internal`, `ok`); `params` the values the label may name (`{status}`:
// an HTTP status, `{what}`: what timed out or ran out, `{feature}`: what is not set up). A value of
// `what` or `feature` is a key of `labels.skills.result.params.<param>` (else the value as it is).

const entry = (status, group = 'skill', params = []) => Object.freeze({ status, group, params: Object.freeze([...params]) });
const skill = (status, params) => entry(status, 'skill', params);
const wake = (status = 'failed') => entry(status, 'wake');
const internal = (status = 'failed') => entry(status, 'internal');

/** code -> `{ status, group, params }`. */
export const CATALOGUE = Object.freeze({
  ok: entry('ok', 'ok'),
  shadow: entry('ok', 'internal'),
  staged: entry('ok', 'internal'),

  // The gateway and the rights: a rule said no.
  'skills-off': skill('denied'),
  'feature-off': skill('denied'),
  'safe-mode': skill('denied'),
  'not-allowed': skill('denied'),
  'not-grantable': skill('denied'),
  'not-granted': skill('denied'),
  'owner-only': skill('denied'),
  'unknown-principal': skill('denied'),
  'no-requester': skill('denied'),
  'mixed-requesters': skill('denied'),
  'requester-denied': skill('denied'),
  'self-grant': skill('denied'),
  'not-self-owned': skill('denied'),
  'not-requester': skill('denied'),
  'inner-stopped': skill('denied'),
  cooldown: skill('denied'),
  'no-budget': skill('denied'),
  'daily-cap': skill('denied'),
  'channel-no-permission': skill('denied'),
  'channel-not-visible': skill('denied'),
  'cap-open': skill('denied'),
  'cap-tasks': skill('denied'),
  'heartbeat-only': skill('denied'),
  'heartbeat-cap': skill('denied'),
  'heartbeat-recurring-cap': skill('denied'),
  paused: skill('denied'),
  'diary-draw-only': skill('denied'),

  // A call that was not right.
  'invalid-args': skill('invalid'),
  'unknown-skill': skill('invalid'),
  'unknown-command': skill('invalid'),
  'unknown-op': skill('invalid'),
  'unknown-member': skill('invalid'),
  'unknown-message': skill('invalid'),
  'message-deleted': skill('invalid'),
  'unknown-file': skill('invalid'),
  'unknown-gif': skill('invalid'),
  'unknown-agent': skill('invalid'),
  'unknown-conversation': skill('invalid'),
  'file-expired': skill('invalid'),
  'file-elsewhere': skill('invalid'),
  'target-ambiguous': skill('invalid'),
  'agent-required': skill('invalid'),
  'not-own-message': skill('invalid'),
  'no-own-message': skill('invalid'),
  'target-required': skill('invalid'),
  'destination-required': skill('invalid'),
  'not-found': skill('invalid'),
  'not-open': skill('invalid'),
  'bad-goal': skill('invalid'),
  'bad-sort': skill('invalid'),
  'bad-page': skill('invalid'),
  'bad-time': skill('invalid'),
  'bad-every': skill('invalid'),
  'bad-attend': skill('invalid'),
  'bad-deadline': skill('invalid'),
  'bad-due': skill('invalid'),
  'bad-expiry': skill('invalid'),
  'bad-move': skill('invalid'),
  'bad-provenance': skill('invalid'),
  'attend-with-due': skill('invalid'),
  'attend-with-every': skill('invalid'),
  'every-without-due': skill('invalid'),
  'due-after-expiry': skill('invalid'),
  'not-attend': skill('invalid'),
  'not-recurring': skill('invalid'),
  'no-next': skill('invalid'),
  'no-purpose': skill('invalid'),
  'reason-required': skill('invalid'),
  'no-task': skill('invalid'),
  'task-ended': skill('invalid'),
  'wait-without-task': skill('invalid'),
  terminal: skill('invalid'),
  'duplicate-id': skill('invalid'),
  'candidate-external': skill('denied'),
  'candidate-same-turn': skill('denied'),
  'candidate-same-chain': skill('denied'),
  'empty-query': skill('invalid'),
  'no-query': skill('invalid'),
  'no-link': skill('invalid'),
  'no-media': skill('invalid'),
  'invalid-action': skill('invalid'),
  'invalid-emoji': skill('invalid'),
  scheme: skill('invalid'),
  'loop-cap': skill('invalid', ['what']),
  'malformed-call': skill('invalid'),
  'truncated-call': skill('invalid'),

  // What it needs is not set up.
  'not-configured': skill('not_configured', ['feature']),
  unsupported: skill('not_configured'),
  'no-guild': skill('not_configured'),

  // It ran and did not work, or may have.
  error: skill('failed'),
  timeout: skill('unknown', ['what']),
  cap: skill('failed', ['what']),
  provider: skill('failed', ['status']),
  http: skill('failed', ['status']),
  network: skill('failed'),
  private: skill('failed'),
  type: skill('failed'),
  size: skill('failed'),
  redirects: skill('failed'),
  'turn-cap': skill('failed'),
  'runner-down': skill('failed'),
  'warmup-running': skill('failed'),
  'write-failed': skill('failed'),
  'file-unreadable': skill('failed'),
  'attachment-too-large': skill('failed'),
  'gif-failed': skill('partial'),
  'gif-cap': skill('failed'),
  'no-result': skill('failed'),
  'send-failed': skill('failed'),
  refused: skill('failed'),
  'image-cap': skill('failed'),
  'image-cap-daily': skill('failed'),
  'image-cap-user-daily': skill('failed'),
  'image-moderation': skill('failed'),
  'image-timeout': skill('failed'),
  'image-error': skill('failed'),
  'image-empty': skill('failed'),
  'unsupported-model': skill('failed'),

  // Why a wake did not run (labels.wake.feedback.codes).
  done: wake('ok'),
  cancelled: wake(),
  expired: wake(),
  forgotten: wake(),
  'dm-off': wake(),
  'not-writable': wake(),
  unavailable: wake(),
  'no-review-channel': wake(),

  // Why a call left the pending queue unanswered (the reasons of a missed fact, src/behavior/missed.js).
  'pending-full': internal(),
  'pending-expired': internal(),
  'pending-outranked': internal(),

  // History and transport details.
  wait: internal('ok'),
  rewait: internal('ok'),
  recurred: internal('ok'),
  'done-occurrence': internal('ok'),
  dropped: internal('ok'),
  'task-missing': internal(),
  'wait-deadline': internal(),
  disconnected: internal(),
  closed: internal(),
  'bad-line': internal(),
  moved: internal('ok'),
});

/** The names of the codes that have wording, by group. */
export const codesOf = (group) => Object.keys(CATALOGUE).filter((code) => CATALOGUE[code].group === group);

/** `NOT_FOUND` for `not-found`: the constant's name. */
const nameOf = (code) => code.toUpperCase().replaceAll('-', '_');

/**
 * `CODE.NOT_FOUND === 'not-found'`: the one way an emitter spells a code. A name the catalogue does
 * not have throws, so a typo stops at the first use instead of becoming a code nobody words.
 */
export const CODE = new Proxy(Object.freeze(Object.fromEntries(Object.keys(CATALOGUE).map((code) => [nameOf(code), code]))), {
  get(table, name) {
    if (typeof name === 'symbol' || name === 'then' || name === 'toJSON') return table[name];
    if (!Object.hasOwn(table, name)) throw new Error(`not a catalogued code: ${String(name)}`);
    return table[name];
  },
});

/** Whether `code` is in the catalogue. */
export const isCode = (code) => typeof code === 'string' && Object.hasOwn(CATALOGUE, code);

/** The statuses of a refusal made before anything ran, per code: `invalid` for a call that was not right. */
export const INVALID_CODES = Object.freeze(Object.keys(CATALOGUE).filter((code) => CATALOGUE[code].status === 'invalid'));
/** The codes that mean what a call needs is not set up. */
export const NOT_CONFIGURED_CODES = Object.freeze(Object.keys(CATALOGUE).filter((code) => CATALOGUE[code].status === 'not_configured'));

/** What a timeout, a cap or a missing feature is about: the values of `{what}`. */
export const WHAT = Object.freeze({
  chat: 'chat',
  page: 'page',
  search: 'search',
  errand: 'errand',
  picture: 'picture',
  // Why a call of the loop was not run (`loop-cap`): too many in one answer, or the steps, the time or the room spent.
  extraCall: 'extra-call',
  steps: 'steps',
  time: 'time',
  tokens: 'tokens',
});

/** What a `not-configured` result may name: the values of `{feature}`. */
export const FEATURE = Object.freeze({ web: 'web' });

const HTTP_CODE_RE = /^http-(\d{3})$/;

/** The code of an HTTP answer: `http-<status>` (a port's, Discord's refusals); normalised to `http` + `{status}` by {@link normalCode}. */
export const httpCode = (status) => `http-${status}`;

/**
 * A code as the catalogue knows it, with its values: `http-404` is `http` with `{ status: '404' }`.
 * Any other code is itself with `values` as given.
 * @param {string} code
 * @param {object|null} [values]
 * @returns {{ code: string, values: object }}
 */
export function normalCode(code, values = null) {
  const given = values && typeof values === 'object' ? values : {};
  const match = typeof code === 'string' ? HTTP_CODE_RE.exec(code) : null;
  return match ? { code: CODE.HTTP, values: { status: match[1], ...given } } : { code, values: given };
}

/**
 * The words of a code: `labels.skills.result.reasons[<code>]` with the code's values filled
 * (`{status}` as it is, `{what}` and `{feature}` through `labels.skills.result.params.<param>.<value>`
 * when that exists). The one lookup the call mark (src/format.js#callReason) and the `<result>`
 * block (src/behavior/prompt.js#skillResultBlock) share, so a restart that reseeds the mark from
 * the journal tells the same text. `null` when the code has no wording or a value its label names
 * is missing.
 * @param {object} labels
 * @param {string} code
 * @param {object|null} [values]
 * @param {(template: string, values: object) => string} fill
 * @returns {string|null}
 */
export function reasonText(labels, code, values, fill) {
  const normal = normalCode(code, values);
  const table = labels?.skills?.result?.reasons;
  const template = table && typeof table === 'object' && Object.hasOwn(table, normal.code) ? table[normal.code] : null;
  if (typeof template !== 'string' || !template) return null;
  const params = labels?.skills?.result?.params;
  const words = {};
  for (const [key, value] of Object.entries(normal.values)) {
    const named = params && typeof params === 'object' && params[key] && typeof params[key] === 'object' && Object.hasOwn(params[key], String(value)) ? params[key][String(value)] : null;
    words[key] = typeof named === 'string' && named ? named : String(value);
  }
  const text = fill(template, words);
  return /\{\w+\}/.test(text) ? null : text;
}
