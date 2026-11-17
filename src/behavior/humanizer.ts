// The humanizer (docs/humanizer.md): her speech of one step, read as one text, checked by the linter and, when the
// linter asks for it, written again by the writer before it is posted. postSpeech (src/turn/tool-round.ts) calls
// humanize once per step and posts what it resolves. Every failure resolves her own messages.

import { railReason, roleRequestOptions } from '../llm/openrouter.ts';
import { parseOutput, strictJsonObject } from '../llm/parse.ts';
import { stripDashes } from '../memory/clamp.ts';
import { HUMANIZER_LINTER_ROLE, HUMANIZER_WRITER_ROLE, roleModel } from '../llm/roles.ts';
import { log } from '../log.ts';
import { block, fillPromptTemplate } from '../turn/request/text.ts';

export type HumanizerMessage = { text: string; replyTo: number | null };

type Llm = {
  complete: (messages: Array<{ role: string; content: string }>, options: Record<string, unknown>) => Promise<unknown>;
};

// The owner's decision of 2026-11-17: a shorter text reads as typed and goes out with no model call.
const MIN_WORDS = 40;
// The measured answers of 2026-11-17 stayed under half of these.
const LINTER_MAX_TOKENS = 1200;
const WRITER_MAX_TOKENS = 3000;
// A writer on a harness takes tens of seconds; the analyzer timeout would cut it.
const LINTER_TIMEOUT_MS = 30_000;
const WRITER_TIMEOUT_MS = 120_000;

const KINDS = ['shape', 'rhythm', 'wit', 'tone', 'words', 'language', 'overdone'] as const;

/** The schema of the linter's answer, handed to the client as `responseFormat`. */
const LINTER_FORMAT = {
  name: 'humanizer',
  schema: {
    type: 'object',
    properties: {
      rewrite: { type: 'boolean' },
      findings: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            kind: { type: 'string', enum: KINDS },
            quote: { type: 'string' },
            problem: { type: 'string' },
            fix: { type: 'string' },
          },
          required: ['kind', 'quote', 'problem', 'fix'],
          additionalProperties: false,
        },
      },
    },
    required: ['rewrite', 'findings'],
    additionalProperties: false,
  },
};

const draftOf = (messages: ReadonlyArray<HumanizerMessage>): string =>
  messages.map((one) => `<msg${one.replyTo === null ? '' : ` reply="#${one.replyTo}"`}>${one.text}</msg>`).join('\n');

const textOf = (value: unknown): unknown => (value as { text?: unknown } | null)?.text;

const findingLine = (finding: unknown, index: number): string => {
  const one = (finding ?? {}) as Record<string, unknown>;
  const field = (name: string) => (typeof one[name] === 'string' ? one[name] : '');
  return `${index + 1}. kind: ${field('kind')}; quote: "${field('quote')}"; problem: ${field('problem')}; fix: ${field('fix')}`;
};

type LoweredCall = { skill: string; args: Record<string, unknown> };

const replyOf = (reply: unknown): number | null =>
  typeof reply === 'string' && /^#\d+$/.test(reply) ? Number(reply.slice(1)) : null;

/**
 * Her speech of one step as it is posted: `parsed.messages` of an addressed turn or a diary post, or the lowered
 * `message.create` calls of an inner turn, each with the humanizer's text. A call keeps every argument but `text`, and
 * every other lowered call stays as it is. A `message.create` call of her own comes as one message with no lowered call.
 */
export async function humanizeSpeech<TCall extends LoweredCall>({
  parsed,
  loweredCalls,
  ...rest
}: {
  parsed: { messages: ReadonlyArray<{ text: string; replyTo?: number | null }> };
  loweredCalls: Array<TCall>;
  llm: Llm;
  hot: { readonly config: unknown; readonly prompts: unknown };
  name: string;
  place: string;
}): Promise<{ messages: Array<HumanizerMessage>; loweredCalls: Array<TCall> }> {
  const spoken = parsed.messages.map((one) => ({ text: one.text, replyTo: one.replyTo ?? null }));
  const created = loweredCalls.filter((call) => call.skill === 'message.create');
  if (created.length === 0) return { messages: await humanize({ ...rest, messages: spoken }), loweredCalls };
  const draft = created.map((call) => ({
    text: typeof call.args.text === 'string' ? call.args.text : '',
    replyTo: replyOf(call.args.reply),
  }));
  const texts = (await humanize({ ...rest, messages: draft })).map((one) => one.text);
  return {
    messages: spoken,
    loweredCalls: loweredCalls.map((call) =>
      call.skill === 'message.create' ? { ...call, args: { ...call.args, text: texts[created.indexOf(call)] } } : call
    ),
  };
}

/**
 * The messages to post: hers, or the writer's when the humanizer is on, the text holds at least 40 words, both roles
 * have a route, the linter asks for a rewrite and the writer's answer passes its checks.
 */
async function humanize({
  messages,
  llm,
  hot,
  name,
  place,
}: {
  messages: Array<HumanizerMessage>;
  llm: Llm;
  hot: { readonly config: unknown; readonly prompts: unknown };
  name: string;
  place: string;
}): Promise<Array<HumanizerMessage>> {
  const config = hot.config as { humanizer?: { enabled?: unknown }; format?: { stripDashes?: unknown } };
  if (config.humanizer?.enabled !== true) return messages;
  const words = messages.reduce((sum, one) => sum + one.text.split(/\s+/).filter(Boolean).length, 0);
  if (words < MIN_WORDS) return messages;
  const linterModel = roleModel(config, HUMANIZER_LINTER_ROLE);
  const writerModel = roleModel(config, HUMANIZER_WRITER_ROLE);
  if (linterModel === undefined || writerModel === undefined) return messages;
  const prompts = (hot.prompts ?? {}) as Record<string, unknown>;
  const draft = draftOf(messages);
  const startedAt = Date.now();

  let verdict: Record<string, unknown> | null;
  try {
    const answer = await llm.complete(
      [
        { role: 'system', content: fillPromptTemplate(prompts['humanizer-linter'], { name }) },
        { role: 'user', content: draft },
      ],
      {
        model: linterModel,
        ...roleRequestOptions(config, {
          role: HUMANIZER_LINTER_ROLE,
          maxOutputTokens: LINTER_MAX_TOKENS,
          purpose: 'humanizer-linter',
          timeoutMs: LINTER_TIMEOUT_MS,
        }),
        responseFormat: LINTER_FORMAT,
      }
    );
    verdict = strictJsonObject(textOf(answer));
  } catch (err) {
    log.warn('humanizer: failed', { channel: place, stage: 'linter', reason: railReason(err) });
    return messages;
  }
  if (verdict === null || typeof verdict.rewrite !== 'boolean' || !Array.isArray(verdict.findings)) {
    log.warn('humanizer: failed', { channel: place, stage: 'linter', reason: 'unparsed' });
    return messages;
  }
  const findings: Array<unknown> = verdict.findings;
  log.info('humanizer: checked', {
    channel: place,
    words,
    rewrite: verdict.rewrite,
    findings: findings.length,
    ms: Date.now() - startedAt,
  });
  if (!verdict.rewrite) return messages;

  let written: Array<HumanizerMessage>;
  try {
    const answer = await llm.complete(
      [
        { role: 'system', content: fillPromptTemplate(prompts['humanizer-writer'], { name }) },
        {
          role: 'user',
          // Her think stays out of the request: a provider's filter stops the answer to a request that carries a model's
          // reasoning (measured 2026-11-17, docs/humanizer.md).
          content: [block('draft', draft), block('findings', findings.map(findingLine).join('\n'))].join('\n\n'),
        },
      ],
      {
        model: writerModel,
        ...roleRequestOptions(config, {
          role: HUMANIZER_WRITER_ROLE,
          maxOutputTokens: WRITER_MAX_TOKENS,
          purpose: 'humanizer-writer',
          timeoutMs: WRITER_TIMEOUT_MS,
        }),
      }
    );
    written = parseOutput(textOf(answer)).messages;
    // format.stripDashes holds for the writer's words as for hers (src/turn/phases/response.ts).
    if (config.format?.stripDashes !== false) written = written.map((one) => ({ ...one, text: stripDashes(one.text) }));
  } catch (err) {
    log.warn('humanizer: failed', { channel: place, stage: 'writer', reason: railReason(err) });
    return messages;
  }
  // The count is hers (the owner, 2026-11-17): each message keeps its place and its reply target, and only its text
  // changes. A broken think tag leaves parseOutput with no message, so the count refuses it too.
  const refused =
    written.length !== messages.length
      ? 'count'
      : written.some((one) => one.text.trim() === '')
        ? 'empty'
        : written.some((one, i) => one.replyTo !== messages[i].replyTo)
          ? 'reply'
          : null;
  if (refused !== null) {
    log.warn('humanizer: failed', { channel: place, stage: 'writer', reason: refused, messages: written.length });
    return messages;
  }
  log.info('humanizer: rewritten', {
    channel: place,
    messages: messages.length,
    ms: Date.now() - startedAt,
  });
  return written;
}
