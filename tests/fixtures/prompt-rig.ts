// The fixtures of the prompt builder tests (tests/prompt.test.ts): the clock, the fake prompts and config, a loose input of
// `buildRequest` and the readers of a request's `<people_now>` block. tests/fixtures/labels.ts is the English fixture
// that covers every key of the prompt contract.
import { userText as contentText } from '../../src/behavior/prompt.ts';
import { handleOf } from '../../src/behavior/handles.ts';
import { fill } from '../../src/format.ts';
import { SAFETY_MARGIN } from '../../src/llm/budget.ts';
import { estimateTokens } from '../../src/llm/tokens.ts';
import { labels } from './labels.ts';
import { frameOf } from '../../src/turn/request/frame.ts';
import type { Frame } from '../../src/turn/request/frame.ts';
import type { Built, RequestInput } from './built-request.ts';
import { DM_CHAIN, ROOM_CHAIN, frameInput } from './frame-input.ts';

type ConfigOverrides = { context?: object; llm?: object; memory?: object; private?: object; features?: object };
type FakeConfig = {
  bot: { timezone: string };
  context: { caps: Record<string, number> } & Record<string, unknown>;
  llm: { maxRequestTokens: number } & Record<string, unknown>;
  memory?: object;
  private?: object;
};
/** A stored chat line as these tests write it: the fields a case reads, and whatever `overrides` add. */
export type Line = { id: number | string; ts: number } & Record<string, unknown>;

export const NOW = Date.UTC(2026, 8, 20, 10, 0, 0); // Sun 20 Sep 2026, 13:00 Moscow
export const MIN = 60_000;

export function identityCalibrator(): { ratio: number; apply: (n: number) => number } {
  return { ratio: 1, apply: (n: number) => n };
}

export function fakePrompts(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    'system-prompt': 'SYSTEM_TEXT for {{name}}',
    'character-card': 'CARD_TEXT',
    // The rules text holds a list item: a rules file with an empty list reaches no system text (src/rules-list.ts).
    rules: '- RULES_TEXT',
    format: 'FORMAT_TEXT',
    reply: 'Called by {{author}}, they {{trigger}}. Answer {{target}} as {{name}}. Target: {{target}}.',
    interject: 'INTERJECT_TASK for {{name}}',
    initiate: 'INITIATE_TASK for {{name}}',
    memory: 'MEMORY_TEXT for {{name}}',
    labels,
    ...overrides,
  };
}

// PR 7d: the switches are code and the context, lore and memory measures constants, so only the settings stay.
export function fakeConfig(overrides: ConfigOverrides = {}): FakeConfig {
  return {
    bot: { timezone: 'Europe/Moscow' },
    context: {
      caps: { interlocutor: 2500, aboutChat: 2500, people: 4000, neighbors: 3000, server: 2500, lore: 1500 },
      ...overrides.context,
    },
    llm: { maxRequestTokens: 50000, ...overrides.llm },
    ...(overrides.memory ? { memory: overrides.memory } : {}),
    ...(overrides.private ? { private: overrides.private } : {}),
  };
}

// PR 7d: llm.safetyMargin is the constant 0.9 (SAFETY_MARGIN of src/llm/budget.ts), so a request limit of exactly
// `tokens` needs a maxRequestTokens of tokens / 0.9.
export const exactly = (tokens: number): number => Math.ceil(tokens / SAFETY_MARGIN);

export function makeMessage(id: number | string, ts: number, overrides: Record<string, unknown> = {}): Line {
  return {
    id,
    ts,
    authorId: `author-${id}`,
    authorName: `User${id}`,
    self: false,
    content: `content of message ${id}`,
    attachments: [],
    stickers: [],
    replyToId: null,
    ...overrides,
  };
}

/**
 * The turn frame of a loose input (src/turn/request/frame.ts): its kind read off `mode`, `triggerKind` and `wakeKind`,
 * in the fixture's room or, with `privateChat`, in a one-to-one chat, answering the trigger's author.
 */
export function frameOfInput(input: Record<string, unknown>): Frame {
  const text = (value: unknown): string | null => (typeof value === 'string' ? value : null);
  const trigger = input.trigger as { id?: unknown; authorId?: unknown; authorName?: unknown } | null | undefined;
  const rawId = trigger?.authorId;
  const authorId = typeof rawId === 'string' || typeof rawId === 'number' ? String(rawId) : '';
  const author = trigger
    ? { personId: `person:${authorId}`, accountId: authorId, name: text(trigger.authorName) }
    : null;
  const dm = Boolean(input.privateChat);
  return frameOf(
    frameInput({
      mode: text(input.mode) ?? 'reply',
      triggerKind: text(input.triggerKind),
      wakeKind: text(input.wakeKind),
      chain: dm ? DM_CHAIN : ROOM_CHAIN,
      dm: dm ? { word: 'private', nativeId: authorId || '1234', partner: author } : null,
      trigger: trigger ? { messageId: String(trigger.id), authorId } : null,
      author,
      now: typeof input.now === 'number' ? input.now : NOW,
    })
  );
}

/** `input` with the turn frame of its own fields (frameOfInput): every request is built on its frame. */
export function framed<T extends Record<string, unknown>>(input: T): T & { frame: Frame } {
  return { ...input, frame: frameOfInput(input) };
}

/**
 * A loose input of `buildRequest`. Every request is built on its turn frame, so an input without one gets the frame of
 * its own fields (frameOfInput); a test that passes `frame` keeps its own.
 */
export function baseInput(overrides: Record<string, unknown> = {}): RequestInput {
  const history = overrides.history ?? [makeMessage(1, NOW - MIN)];
  const input: Record<string, unknown> = {
    config: fakeConfig(),
    prompts: fakePrompts(),
    calibrator: identityCalibrator(),
    mode: 'reply',
    now: NOW,
    selfName: 'Nept',
    history,
    neighbors: [],
    trigger: null,
    triggerKind: null,
    placeMemory: {},
    interlocutor: null,
    otherProfiles: [],
    ...overrides,
  };
  if (!Object.hasOwn(overrides, 'frame')) input.frame = frameOfInput(input);
  return input as unknown as RequestInput;
}

/** The `<people_now>` body of a request, null when it has none. */
export function peopleNowOf(request: Built): string | null {
  const match = /^<people_now>\n([\s\S]*?)\n<\/people_now>$/m.exec(contentText(request.messages[1].content));
  return match ? match[1] : null;
}

/** The `<people_now>` entry (heading and field lines) of the member called `name` (after the handle, before a tag), null when there is none. */
export function rowOf(request: Built, name: string): string | null {
  const body = peopleNowOf(request);
  if (body === null) return null;
  const who = (line: string) => (/^@u[0-9a-z]+ /.test(line) ? line.slice(line.indexOf(' ') + 1) : line);
  return (
    body.split('\n\n').find((entry) => {
      const heading = who(entry.split('\n')[0]);
      return heading === name || heading.startsWith(`${name} (`);
    }) ?? null
  );
}

/** The field lines of a `<people_now>` entry (or of profileStateFields) as `{ field: value }`. */
export function fieldsOf(entry: string | Array<string> | null): Record<string, string> {
  const lines = Array.isArray(entry) ? entry : entry!.split('\n').slice(1);
  return Object.fromEntries(
    lines.map((line: string) => {
      const text = line.replace(/^- /, '');
      const at = text.indexOf(': ');
      return [text.slice(0, at), text.slice(at + 2)];
    })
  );
}

/**
 * What a member of the tail `<people>` costs in the budget: `profileText` with their
 * `<people_now>` entry under it (one item), here the bare entry of a member with no live part, no
 * attitude and no stored count. `profile`: `{ id, names }`.
 */
export function itemCost(profileText: string, profile: { id: string; names: Array<string> }): number {
  const entry = [
    `@${handleOf(profile.id)} ${profile.names[0]}`,
    fill(labels.peopleNow.field, { field: labels.peopleNow.fields.attitude, value: labels.peopleNow.values.none }),
    fill(labels.peopleNow.field, { field: labels.peopleNow.fields.messages, value: labels.peopleNow.values.none }),
  ].join('\n');
  return estimateTokens(`${profileText}\n${entry}`) + 2;
}

/** The clock of the test stores: every voice join seen 12 minutes before the request. */
export const joinClock = (): number => NOW - 12 * 60_000;
/** The join part of a voice seat seen joining 12 minutes before the request. */
export const JOINED = fill(labels.peopleNow.joinedAgo, { ago: fill('12 {minute}', labels.units) });

/** What `<people>` takes with the `<people_now>` lead paid after the fit (a budget line of its own). */
export function peopleSide(stats: Record<string, { used: number } | undefined>): number {
  return stats.people!.used + (stats.peopleNow?.used ?? 0);
}

/** The field names of the fixture. */
export const F = labels.peopleNow.fields;
export const V = labels.peopleNow.values;

/** `## name (@handle)`: a profile heading with the member's handle in `request`. */
export function headingOf(request: Built, name: string, id: string): string {
  const handle = [...request.handles!].find(([, member]) => member === id)?.[0];
  return `## ${name} (@${handle})`;
}
