// Room questions (spontaneous.roomQuestionChance). Outside any follow-up window, an untagged line that failed the
// eavesdrop roll may be a question or remark put to everyone present. When the eavesdrop rails pass for its channel
// now (spontaneous.eavesdropReady), the line passes roomPreFilter (text, no reply, no member mention) and a roll of
// spontaneous.roomQuestionChance wins, the room classifier (room.md, the same request shape as the address classifier:
// buildClassifierRequest) is asked once; a `yes` hands the line back to the scheduler as a room line
// (spontaneous.onMessage with `room`: no second roll, the turn about that line). At most one call per channel in
// flight; a line arriving meanwhile is skipped, not held. Nothing is persisted. createMessageHandler
// (src/behavior/pipeline.js) builds it once with createRoom.

import { isFollowUpOpen, parseAddressAnswer, roomPreFilter } from '../behavior/mention.js';
import { roomQuestionChance } from '../behavior/spontaneous.js';
import { railReason, roleRequestOptions } from '../llm/openrouter.js';
import { roleModel } from '../llm/roles.js';
import { log } from '../log.js';
import type { ClassifierParams, ClassifierRequest } from './classifier-request.ts';
import type { FollowUpWindows } from './follow-up-window.ts';
import type { Conv, Line, PipelineConfig, PipelineHot, PipelineLlm, Thrown } from './types.ts';

/** The spontaneous scheduler (src/behavior/spontaneous.js#createSpontaneous), as the room path calls it. */
type RoomScheduler = {
  onMessage: (channel: Conv, normalized: Line, options?: { room: boolean }) => unknown;
  eavesdropReady?: (channel: Conv) => unknown;
};

/** What createRoom reads: the dependencies of createMessageHandler and its other parts' functions. */
export type RoomContext = {
  hot: PipelineHot;
  llm: PipelineLlm | null | undefined;
  now: () => number;
  rng: () => number;
  spontaneous: RoomScheduler;
  getSelfName: (guildId: string) => string;
  windowOf: FollowUpWindows['windowOf'];
  buildClassifierRequest: (params: ClassifierParams) => Promise<ClassifierRequest | null>;
};

export type MaybeRoom = (channel: Conv, normalized: Line, ownPrefill: Promise<void> | null) => Promise<void>;

export function createRoom({
  hot,
  llm,
  now,
  rng,
  spontaneous,
  getSelfName,
  windowOf,
  buildClassifierRequest,
}: RoomContext): { maybeRoom: MaybeRoom } {
  const roomInFlight = new Set<string>(); // channelIds with a room classifier call running right now

  /**
   * The room path of an untagged `normalized` message the eavesdrop roll did
   * not schedule (onMessage step 10), every check read from the live config
   * now, the cheap ones first: the chance above 0 and an llm, no open
   * follow-up window in the channel, the eavesdrop rails, the pre-filter,
   * then the roll; only then the prompt (`room: skipped`, `no-prompt`) and
   * the channel's slot (`in-flight`). Never throws past its own call:
   * classifyRoom logs a failure and answers null.
   */
  async function maybeRoom(channel: Conv, normalized: Line, ownPrefill: Promise<void> | null): Promise<void> {
    const config = hot.config;
    const chance = roomQuestionChance(config);
    if (!(chance > 0) || !llm) return;
    if (isFollowUpOpen(windowOf(channel.id), now(), config.mention)) return;
    if (spontaneous.eavesdropReady?.(channel) !== true) return;
    if (!roomPreFilter(normalized)) return;
    if (rng() >= chance) return;
    const prompt = hot.prompts?.room;
    if (!prompt) {
      log.info('room: skipped', { channel: channel.id, reason: 'no-prompt' });
      return;
    }
    if (roomInFlight.has(channel.id)) {
      log.info('room: skipped', { channel: channel.id, reason: 'in-flight' });
      return;
    }
    roomInFlight.add(channel.id);
    try {
      const answer = await classifyRoom({ channel, normalized, ownPrefill, prompt, config });
      if (answer === 'yes') spontaneous.onMessage(channel, normalized, { room: true });
    } finally {
      roomInFlight.delete(channel.id);
    }
  }

  /**
   * One room classifier call for `normalized` in `channel`: the request from
   * buildClassifierRequest with `prompt` (room.md), sent with the `analyzer` request
   * request options (role analyzer, mention.followUpMaxOutputTokens, the
   * daily cap, llm.analyzerTimeoutMs, purpose `room`). Resolves to `'yes'` or
   * `'no'` (`room: verdict`; the first word, read as the address
   * classifier's answer is: anything but a yes is a no), or null when no
   * verdict came: a request that could not be built (`room: skipped`,
   * `failed`) or a call that failed or answered nothing (`room: classifier
   * failed` with `reason`: the rail's code, `llm-error` or `empty`, and the
   * HTTP `status` when there is one).
   */
  async function classifyRoom({
    channel,
    normalized,
    ownPrefill,
    prompt,
    config,
  }: {
    channel: Conv;
    normalized: Line;
    ownPrefill: Promise<void> | null;
    prompt: string;
    config: PipelineConfig;
  }): Promise<'yes' | 'no' | null> {
    const channelId = channel.id;
    const startedAt = now();
    // A served channel is in a community, so it has its id.
    const selfName = getSelfName(channel.communityId as string);
    let request: ClassifierRequest | null = null;
    try {
      request = await buildClassifierRequest({
        prompt,
        config,
        prompts: hot.prompts,
        channel,
        selfName,
        normalized,
        ownPrefill,
      });
    } catch (err) {
      log.warn('room: skipped', { channel: channelId, reason: 'failed', name: (err as Thrown)?.name ?? null });
      return null;
    }
    if (!request) return null;

    const model: unknown = roleModel(config, 'analyzer', 'room');
    let completion;
    try {
      // maybeRoom asks only with an llm.
      completion = await (llm as PipelineLlm).complete(
        [
          { role: 'system', content: request.system },
          { role: 'user', content: request.user },
        ],
        {
          model,
          ...roleRequestOptions(config, {
            role: 'analyzer',
            maxOutputTokens: config.mention?.followUpMaxOutputTokens,
            purpose: 'room',
          }),
        }
      );
    } catch (err) {
      log.warn('room: classifier failed', {
        channel: channelId,
        reason: railReason(err),
        status: (err as Thrown)?.statusCode ?? null,
        name: (err as Thrown)?.name ?? null,
      });
      return null;
    }
    // eslint-disable-next-line @typescript-eslint/no-base-to-string -- the model's answer as it came, read as text
    const text = String(completion?.text ?? '').trim();
    if (!text) {
      // Nothing at all (a reasoning model that spent its whole output cap) is a failed call, not a "no".
      log.warn('room: classifier failed', { channel: channelId, reason: 'empty', status: null, model: model ?? null });
      return null;
    }
    const answer = parseAddressAnswer(text) === 'yes' ? 'yes' : 'no';
    log.info('room: verdict', { channel: channelId, author: normalized.authorId, answer, ms: now() - startedAt });
    return answer;
  }

  return { maybeRoom };
}
