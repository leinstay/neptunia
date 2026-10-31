// The small text tools every request builder shares: a block's tags, the `{{key}}` filler of the prompt files, the
// stored `<@id>` tokens turned into names, the labels' check, and the two date forms the blocks write. The block
// builders of src/turn/request/ and the request builders of src/behavior/prompt.js call them.

import { formatClock, formatDate } from '../../format.js';
import { fromTokens } from '../../memory/mentions.ts';
import type { Labels, NameOf } from './types.ts';

/** The tokens a request keeps free for the tags around its blocks. */
export const TAG_OVERHEAD = 60;

/**
 * `body` wrapped in `<tag>` ... `</tag>` on lines of their own; '' for an
 * empty body, so a block with nothing to say drops out of a request. The one
 * copy: every request builder uses it.
 */
export function block(tag: string, body: string): string {
  return body ? `<${tag}>\n${body}\n</${tag}>` : '';
}

/** `fromTokens(text, nameOf, 'chat')`, tolerating a non-string `text` and a
 * missing `nameOf` (an unresolved `<@id>` token is then left exactly as
 * stored) -- see docs/prompt-contract.md, "Members are referred to
 * by id, never by nickname". */
export function resolveChatText<T>(text: T, nameOf: NameOf | null | undefined): T | string {
  if (typeof text !== 'string') return text;
  return fromTokens(text, typeof nameOf === 'function' ? nameOf : () => null, 'chat');
}

/**
 * Fill the double-brace `{{key}}` placeholders of a prompt file (the prompt
 * contract's form; labels.json uses single braces, see fill() in
 * src/format.js). The one `{{key}}` filler of the codebase: a key
 * present in `values` (an own property) with a non-null value is replaced by
 * `String(value)`; a key that is absent, null or undefined leaves its
 * placeholder untouched. A missing template reads as ''.
 */
export function fillPromptTemplate(template: unknown, values?: Record<string, unknown> | null): string {
  const source = values ?? {};
  // eslint-disable-next-line @typescript-eslint/no-base-to-string -- a prompt file as the prompt layer gives it, read as text
  return String(template ?? '').replace(/\{\{(\w+)\}\}/g, (all: string, key: string) =>
    // eslint-disable-next-line @typescript-eslint/no-base-to-string -- a placeholder's value is any value, read as text
    Object.hasOwn(source, key) && source[key] != null ? String(source[key]) : all
  );
}

/**
 * Whether `labels` (prompts.labels) can render a request at all: an object
 * with `transcript`. The startup check (src/index.js) and every request
 * builder use this one test.
 */
export function hasRequiredLabels(labels: unknown): boolean {
  return Boolean(labels) && typeof labels === 'object' && Boolean((labels as { transcript?: unknown }).transcript);
}

/** A deployment with no/broken labels.json must fail loudly, not send a broken prompt. */
export function requireLabels(prompts: { labels?: unknown } | null | undefined): Labels {
  const labels = prompts?.labels;
  if (!hasRequiredLabels(labels)) {
    throw new Error('prompts.labels is missing or incomplete: labels.transcript is required');
  }
  // hasRequiredLabels found the object with its transcript: the labels file the prompt contract describes.
  return labels as Labels;
}

/** `{from}` / `{to}` of a pulled channel's header: the date and the clock of `ts`, joined as `<now>` joins them. */
export function pulledMoment(ts: number, timezone: string, locale: string | undefined): string {
  return `${formatDate(ts, timezone, locale)}, ${formatClock(ts, timezone, locale)}`;
}

/** A stored `YYYY-MM-DD` in the transcript's date form (`formatDate`), read as that calendar day:
 * its noon formatted in UTC, so no zone moves it to a neighbouring day. */
export function calendarDate(ymd: string, locale: string | undefined): string {
  return formatDate(Date.parse(`${ymd}T12:00:00.000Z`), 'UTC', locale);
}
