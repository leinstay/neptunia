// The address classifier's call about one untagged line in an open follow-up window (prompts/address.md): its verdict
// `yes`, `overheard` or `no`, the window's no-streak bumped on a "no", and a failed call let through while the line
// keeps an active one-to-one exchange. createMessageHandler (src/behavior/pipeline.js) builds it once with
// createAddressClassifier; the follow-up path (src/pipeline/follow-up.ts) calls it once the gate passed.

import { parseAddressAnswer } from '../behavior/mention.js';
import { roleRequestOptions } from '../llm/openrouter.js';
import { roleModel } from '../llm/roles.js';
import { log } from '../log.js';
import { MINUTE_MS } from '../time.js';
import type { ClassifierParams, ClassifierRequest } from './classifier-request.ts';
import type { FollowUpWindow, FollowUpWindows } from './follow-up-window.ts';
import type { Conv, Line, PipelineConfig, PipelineHot, PipelineLlm, PipelineMissed } from './types.ts';

/** What the address classifier answers. */
export type AddressAnswer = 'yes' | 'overheard' | 'no';

/** What createAddressClassifier reads: the dependencies of createMessageHandler and its other parts' functions. */
export type AddressClassifierContext = {
  hot: PipelineHot;
  llm: PipelineLlm | null | undefined;
  now: () => number;
  getSelfName: (guildId: string) => string;
  missed: PipelineMissed | null;
  buildClassifierRequest: (params: ClassifierParams) => Promise<ClassifierRequest | null>;
  bumpFollowUpNoStreak: FollowUpWindows['bumpFollowUpNoStreak'];
};

export type ClassifyFollowUp = (
  channel: Conv,
  normalized: Line,
  selfId: string,
  gate: { config: PipelineConfig; state: FollowUpWindow },
  ownPrefill?: Promise<void> | null
) => Promise<AddressAnswer>;

/**
 * Whether a follow-up whose address classifier failed (threw or answered
 * nothing) still belongs to an active one-to-one exchange, from the channel
 * `history` its request fetched (normalized, oldest first, without the
 * candidate): the persona's latest line before `candidate` was posted at most
 * `minutes` before it; that line (with the lines of hers right before it, one
 * multi-line answer) replied only to messages of the candidate's author, or -- no
 * reply target found in `history` -- a message of that author directly
 * preceded it; and nobody but that author wrote between it and `candidate`.
 * False otherwise, and with `minutes` not above 0. Pure.
 */
function activeExchangeWith(
  history: Array<Line>,
  candidate: { authorId: string; ts: number },
  minutes: number
): boolean {
  if (!(minutes > 0) || !Array.isArray(history)) return false;
  const before = history.filter((m) => m && Number.isFinite(m.ts) && m.ts <= candidate.ts);
  let last = -1;
  for (let i = before.length - 1; i >= 0; i -= 1) {
    if (before[i].self) {
      last = i;
      break;
    }
  }
  if (last < 0 || candidate.ts - before[last].ts > minutes * MINUTE_MS) return false;
  if (before.slice(last + 1).some((m) => m.authorId !== candidate.authorId)) return false;
  let first = last;
  while (first > 0 && before[first - 1].self) first -= 1;
  const byId = new Map(history.map((m) => [m?.id, m]));
  const targets = before
    .slice(first, last + 1)
    .map((m) => (m.replyToId ? byId.get(m.replyToId) : null))
    .filter((m) => m && !m.self);
  // The filter above keeps only the lines found.
  if (targets.length > 0) return targets.every((m) => (m as Line).authorId === candidate.authorId);
  return first > 0 && before[first - 1].authorId === candidate.authorId;
}

export function createAddressClassifier({
  hot,
  llm,
  now,
  getSelfName,
  missed,
  buildClassifierRequest,
  bumpFollowUpNoStreak,
}: AddressClassifierContext): { classifyFollowUp: ClassifyFollowUp } {
  let missingAddressPromptLogged = false;

  /**
   * One classifier call for `normalized` (the gate already passed): logs the
   * verdict and bumps the no-streak on a "no"; a "yes" or an "overheard"
   * leaves the streak alone (the persona is still part of the exchange).
   * Resolves to the answer (parseAddressAnswer); the caller starts the turn
   * (settleFollowUp) and owns the in-flight slot. A call that threw or
   * answered nothing is a "yes" while the message keeps an active one-to-one
   * exchange (activeExchangeWith, within mention.failOpenMinutes read now;
   * 0 = off), a "no" otherwise -- `follow-up: fail-open` says which.
   */
  // health: allow complexity until 2027-04-01 -- moved whole from src/behavior/pipeline.js in stage 5d, a pure move
  async function classifyFollowUp(
    channel: Conv,
    normalized: Line,
    selfId: string,
    { config, state }: { config: PipelineConfig; state: FollowUpWindow },
    ownPrefill: Promise<void> | null = null
  ): Promise<AddressAnswer> {
    const channelId = channel.id;
    const mentionCfg = config.mention;
    const startedAt = now();
    // A served channel is in a community, so it has its id.
    const selfName = getSelfName(channel.communityId as string);
    let request: ClassifierRequest | null = null;
    let buildFailed = false;
    try {
      const prompts = hot.prompts;
      request = await buildClassifierRequest({
        prompt: prompts?.address,
        config,
        prompts,
        channel,
        selfName,
        normalized,
        ownPrefill,
      });
    } catch (err) {
      buildFailed = true;
      log.warn('follow-up: building the classifier request failed', { channel: channelId, error: err });
    }

    if (!request) {
      // Only a really missing prompt latches its one warning; a failed build was logged above.
      if (!buildFailed && !missingAddressPromptLogged) {
        missingAddressPromptLogged = true;
        log.warn('follow-up: prompts.address is missing, every follow-up is treated as "no"', {});
      }
      // A failed build is a failed gate (src/behavior/missed.js); a missing prompt is the deployment's.
      if (buildFailed) missed?.noteFact({ reason: 'gate-failed', message: normalized, failure: 'build-failed' });
      log.info('follow-up: verdict', {
        channel: channelId,
        author: normalized.authorId,
        verdict: 'no',
        answer: 'no',
        ms: now() - startedAt,
      });
      bumpFollowUpNoStreak(channelId, state, mentionCfg);
      return 'no';
    }

    let answer: AddressAnswer = 'no';
    let failure: 'classifier-failed' | 'empty' | null = null; // set when the call gave no answer
    if (llm) {
      // Read once: the request and its empty-answer warning name the same model.
      const model: unknown = roleModel(config, 'analyzer', 'address');
      try {
        // A classifier call skipped by the daily cap (DailyCapError, thrown
        // synchronously before any fetch) lands here exactly like any other
        // error -- "no", logged, no request ever left the process.
        const completion = await llm.complete(
          [
            { role: 'system', content: request.system },
            { role: 'user', content: request.user },
          ],
          {
            model,
            // An `analyzer` request: on llm.analyzerTimeoutMs, never the turn-length llm.timeoutMs, and
            // hedged (llm.hedge) -- while this call is in flight it holds the channel's follow-up
            // slot, and every untagged line there is only held.
            ...roleRequestOptions(config, {
              role: 'analyzer',
              maxOutputTokens: mentionCfg.followUpMaxOutputTokens,
              purpose: 'address',
            }),
          }
        );
        // A completion carries its text (src/llm/openrouter.js#complete).
        const done = completion as { text?: unknown };
        // eslint-disable-next-line @typescript-eslint/no-base-to-string -- the model's answer as it came, read as text
        if (String(done.text ?? '').trim()) {
          answer = parseAddressAnswer(done.text);
        } else {
          // Nothing at all (typically a reasoning model that spent its whole
          // output cap thinking) is a failed call, not a silent "no".
          log.warn('follow-up: classifier failed', { channel: channelId, reason: 'empty', model: model ?? null });
          failure = 'empty';
        }
      } catch (err) {
        answer = 'no';
        log.warn('follow-up: classifier failed', { channel: channelId, error: err });
        failure = 'classifier-failed';
      }
    }

    // A failed call (provider slowness, a timeout) does not drop a line from
    // the member the persona is talking with one to one right now.
    const failOpenMinutes = mentionCfg.failOpenMinutes ?? 3;
    let open = false;
    if (failure && failOpenMinutes > 0) {
      open = activeExchangeWith(
        request.history,
        { authorId: normalized.authorId, ts: normalized.ts ?? now() },
        failOpenMinutes
      );
      log.info('follow-up: fail-open', { channel: channelId, author: normalized.authorId, reason: failure, open });
      if (open) answer = 'yes';
    }
    // A failed gate is a fact for the missed-answer registry (src/behavior/missed.js), let through or not.
    if (failure) missed?.noteFact({ reason: open ? 'gate-failopen' : 'gate-failed', message: normalized, failure });

    // `verdict` is the two-way projection (overheard counts as yes), `answer` the word itself.
    const verdict = answer === 'no' ? 'no' : 'yes';
    log.info('follow-up: verdict', {
      channel: channelId,
      author: normalized.authorId,
      verdict,
      answer,
      ms: now() - startedAt,
    });
    if (answer === 'no') missed?.noteNotAddressed?.(normalized);
    if (answer === 'no') bumpFollowUpNoStreak(channelId, state, mentionCfg);
    return answer;
  }

  return { classifyFollowUp };
}
