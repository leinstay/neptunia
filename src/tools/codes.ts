// The catalogue of codes: every refusal, failure and drop code the engine emits for a call, a
// send, a turn or a wake, with the status it reports under, the values its label may take and
// where its wording lives. Every emitter imports its code from here (`CODE.NOT_FOUND`, never the
// string): a code that is not in the table throws at the first use, and tests/skills-codes.test.js
// greps src/ for a string literal in a code position. The wording is never here: a `skill` code is
// worded by `labels.skills.result.reasons.<code>` (the call mark in the transcript, the `<result>`
// block and the facts read the same label with the same values), a `wake` code by
// `labels.wake.feedback.codes.<code>`; `internal` codes are history or transport details the
// persona is never told by themselves. `tools/labels-catalogue.mjs --check` compares this table,
// the labels and the contract's list. This module imports only the leaf `types.ts`, so any module may import it.
//
// Fields of an entry: `status` the result status the code is reported under by default (`ok`,
// `denied`, `invalid`, `not_configured`, `failed`, `partial`, `unknown`); `group` where the wording
// lives (`skill`, `wake`, `internal`, `ok`); `params` the values the label may name (`{status}`:
// an HTTP status, `{what}`: what timed out or ran out, `{feature}`: what is not set up). A value of
// `what` or `feature` is a key of `labels.skills.result.params.<param>` (else the value as it is).

import { idText, objOf } from './types.ts';

/** The result status a code is reported under by default. */
export type CodeStatus = 'ok' | 'denied' | 'invalid' | 'not_configured' | 'failed' | 'partial' | 'unknown';
/** Where the wording of a code lives. */
export type CodeGroup = 'skill' | 'wake' | 'internal' | 'ok';
/** One code of the catalogue: its default status, where its wording lives and the values its label may name. */
export type CodeEntry = Readonly<{ status: CodeStatus; group: CodeGroup; params: ReadonlyArray<string> }>;

const entry = (status: CodeStatus, group: CodeGroup = 'skill', params: ReadonlyArray<string> = []): CodeEntry =>
  Object.freeze({ status, group, params: Object.freeze([...params]) });
const skill = (status: CodeStatus, params?: ReadonlyArray<string>): CodeEntry => entry(status, 'skill', params);
const wake = (status: CodeStatus = 'failed'): CodeEntry => entry(status, 'wake');
const internal = (status: CodeStatus = 'failed'): CodeEntry => entry(status, 'internal');

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
  'not-video-site': skill('invalid'),
  'invalid-action': skill('invalid'),
  'invalid-emoji': skill('invalid'),
  scheme: skill('invalid'),
  'loop-cap': skill('invalid'),
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
  'write-failed': skill('failed'),
  'file-unreadable': skill('failed'),
  'attachment-too-large': skill('failed'),
  'gif-failed': skill('partial'),
  'gif-cap': skill('failed'),
  'no-result': skill('failed'),
  'send-failed': skill('failed'),
  'link-closed': skill('unknown'),
  'link-busy': skill('failed'),
  'adapter-threw': skill('unknown'),
  refused: skill('failed'),
  'image-cap': skill('failed'),
  'image-cap-daily': skill('failed'),
  'image-cap-user-daily': skill('failed'),
  'image-moderation': skill('failed'),
  'image-timeout': skill('failed'),
  'image-error': skill('failed'),
  'image-empty': skill('failed'),
  'unsupported-model': skill('failed'),
  'speech-cap-daily': skill('failed'),
  'speech-prepare-failed': skill('failed'),
  'speech-synth-failed': skill('failed'),
  'speech-convert-failed': skill('failed'),
  'speech-not-configured': skill('not_configured'),

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
export const codesOf = (group: CodeGroup): Array<string> =>
  Object.keys(CATALOGUE).filter((code) => entryOf(code)?.group === group);

/** The entry of a code the catalogue holds, else undefined. */
const entryOf = (code: string): CodeEntry | undefined =>
  Object.hasOwn(CATALOGUE, code) ? CATALOGUE_BY_NAME[code] : undefined;
const CATALOGUE_BY_NAME: Readonly<Record<string, CodeEntry>> = CATALOGUE;

/** `NOT_FOUND` for `not-found`: the constant's name. */
const nameOf = (code: string): string => code.toUpperCase().replaceAll('-', '_');

/**
 * `CODE.NOT_FOUND === 'not-found'`: the one way an emitter spells a code. A name the catalogue does
 * not have throws, so a typo stops at the first use instead of becoming a code nobody words.
 */
export const CODE: Readonly<Record<string, string>> = new Proxy(
  Object.freeze(Object.fromEntries(Object.keys(CATALOGUE).map((code) => [nameOf(code), code]))),
  {
    get(table: Record<string, string>, name: string | symbol): string | undefined {
      if (typeof name === 'symbol') return undefined;
      if (name === 'then' || name === 'toJSON') return table[name];
      if (!Object.hasOwn(table, name)) throw new Error(`not a catalogued code: ${name}`);
      return table[name];
    },
  }
);

/** Whether `code` is in the catalogue. */
export const isCode = (code: unknown): code is string => typeof code === 'string' && Object.hasOwn(CATALOGUE, code);

/** The statuses of a refusal made before anything ran, per code: `invalid` for a call that was not right. */
export const INVALID_CODES: ReadonlyArray<string> = Object.freeze(
  Object.keys(CATALOGUE).filter((code) => entryOf(code)?.status === 'invalid')
);
/** The codes that mean what a call needs is not set up. */
export const NOT_CONFIGURED_CODES: ReadonlyArray<string> = Object.freeze(
  Object.keys(CATALOGUE).filter((code) => entryOf(code)?.status === 'not_configured')
);

/** What a timeout, a cap or a missing feature is about: the values of `{what}`. */
export const WHAT: Readonly<Record<string, string>> = Object.freeze({
  chat: 'chat',
  page: 'page',
  search: 'search',
  errand: 'errand',
  picture: 'picture',
});

/** What a `not-configured` result may name: the values of `{feature}`. */
export const FEATURE: Readonly<Record<string, string>> = Object.freeze({ web: 'web' });

const HTTP_CODE_RE = /^http-(\d{3})$/;

/** The code of an HTTP answer: `http-<status>` (a port's, Discord's refusals); normalised to `http` + `{status}` by {@link normalCode}. */
export const httpCode = (status: unknown): string => `http-${idText(status)}`;

/**
 * A code as the catalogue knows it, with its values: `http-404` is `http` with `{ status: '404' }`.
 * Any other code is itself with `values` as given.
 */
export function normalCode(code: string, values: Record<string, unknown> | null = null): NormalCode {
  const given = values !== null && typeof values === 'object' ? values : {};
  const match = typeof code === 'string' ? HTTP_CODE_RE.exec(code) : null;
  return match ? { code: CODE.HTTP, values: { status: match[1], ...given } } : { code, values: given };
}

/** A code as the catalogue knows it with the values its label may name. */
export type NormalCode = { code: string; values: Record<string, unknown> };

/**
 * The words of a code: `labels.skills.result.reasons[<code>]` with the code's values filled
 * (`{status}` as it is, `{what}` and `{feature}` through `labels.skills.result.params.<param>.<value>`
 * when that exists). The one lookup the call mark (src/format.js#callReason) and the `<result>`
 * block (src/tools/tool-calls.ts#toolResultText) share, so a restart that reseeds the mark from
 * the journal tells the same text. `null` when the code has no wording or a value its label names
 * is missing.
 */
export function reasonText(
  labels: unknown,
  code: string,
  values: Record<string, unknown> | null,
  fill: (template: string, values: Record<string, string>) => string
): string | null {
  const normal = normalCode(code, values);
  const result = objOf(objOf(objOf(labels).skills).result);
  const table = objOf(result.reasons);
  const template = Object.hasOwn(table, normal.code) ? table[normal.code] : null;
  if (typeof template !== 'string' || !template) return null;
  const params = objOf(result.params);
  const words: Record<string, string> = {};
  for (const [key, value] of Object.entries(normal.values)) {
    const wording = objOf(params[key]);
    const named = Object.hasOwn(wording, String(value)) ? wording[String(value)] : null;
    words[key] = typeof named === 'string' && named ? named : String(value);
  }
  const text = fill(template, words);
  return /\{\w+\}/.test(text) ? null : text;
}
