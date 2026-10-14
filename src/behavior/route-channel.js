// The route classifier's I/O side: the production route hook of the turn
// runner (src/behavior/turn.js, `routeChannels`). When a conversation is
// about another channel nobody named with an explicit <#id>, one cheap
// classifier call picks it from the server's stored channel map so the pull
// phase can show it in `<channel_view>`. The decisions live in
// src/behavior/route.js; this module reads the live config and prompts, the
// store's channel map and profiles, judges each listed channel with the pull
// phase's own rails (src/discord/pull-fetch.js#checkPull, no request) and
// sends the one request through the rails of src/llm/openrouter.js.

import { log } from '../log.js';
import { checkPull } from '../discord/pull-fetch.js';
import { helperRequestOptions, railReason } from '../llm/openrouter.js';
import { roleModel } from '../llm/roles.js';
import {
  buildRouteRequest,
  parseRouteAnswer,
  routeAllowed,
  routeCandidate,
  routeChannelList,
  routeContext,
  routeEntries,
  routeSettings,
} from './route.js';

/**
 * The numbered `<channels>` list of one route decision, shared by the route
 * hook below and the turn planner (src/behavior/planner.js): the stored
 * channels of `guildId` other than `channel` and the candidate's own, each
 * judged with the pull phase's rails (checkPull against `channel`, `partner`
 * for a private chat; a check that throws drops that channel), at most
 * `settings.maxChannels` (routeEntries), rendered by routeChannelList.
 * `ids[n - 1]` is the channel of line `n`. No request, no log.
 * @param {{ store: object, guildId: string, channel: object, guild?: object|null, partner?: object|null,
 *   candidate: object, config: object, settings: { maxChannels: number, purposeChars: number }, now: number }} params
 * @returns {{ lines: string[], ids: string[] }}
 */
export function routeChannelOffer({ store, guildId, channel, guild = channel?.guild ?? null, partner = null, candidate, config, settings, now }) {
  const check = (id) => {
    try {
      const judged = checkPull({ guild, channelId: id, destination: channel, partner, config, now });
      return judged.skip === null ? judged.channel : null;
    } catch {
      return null;
    }
  };
  const entries = routeEntries({
    channels: store.listChannels(guildId),
    exclude: [channel?.id ?? null, candidate?.channelId ?? null].filter(Boolean),
    check,
    profileOf: (userId) => store.getUser(guildId, userId),
    max: settings.maxChannels,
    aliasHalfLifeDays: config.memory?.aliasHalfLifeDays,
  });
  return routeChannelList(entries, { max: settings.maxChannels, purposeChars: settings.purposeChars });
}

/**
 * The route hook for createTurnRunner. Per call, with `hot.config` /
 * `hot.prompts` read at that moment: nothing (`[]`, no log) with
 * `features.channelRoute` off or on a turn routeAllowed refuses -- a private
 * chat asks only on behalf of its partner (`partner`, the discord.js
 * GuildMember of the served `guild` the turn runner passes with
 * features.privateLikeServer on), for a `private` turn, and lists the
 * channels that member can view (checkPull's private-chat rule); `route:
 * skipped` (`reason: 'no-prompt'`) without `prompts['route-channel']`, (`reason:
 * 'no-candidate'`) without a message to judge (routeCandidate); nothing (no
 * call, no log) when no stored channel other than this one (and the
 * candidate's own) passes checkPull -- a check that throws drops that
 * channel. Else one request on the `analyzer` helper model (roleModel), its answer capped at
 * `route.maxOutputTokens`, with the helper timeout, logged `route:
 * classified` (`kind`, `channels` = the list length, `pick` = the channel id
 * or null, `parse` = the parse code, `direction`, `ms`). Resolves `[id]` for a
 * pick, `[{ id, direction: 'earlier' }]` for a pick that asks for the page
 * before the last view of that channel (parseRouteAnswer), else `[]`; never rejects: a failure logs `route: failed` (`reason`: the rail
 * code of a refused or failed request, `error` for anything else). Counts,
 * ids and codes only: never a message text, never a channel name.
 * @param {{ hot: { config: object, prompts: object }, store: object, llm: { complete: Function },
 *   now?: () => number }} deps
 * @returns {(args: { guildId: string, channel: object, guild?: object|null, partner?: object|null,
 *   history: object[], trigger: object|null, triggerKind?: string|null, selfName: string,
 *   config?: object }) => Promise<Array<string|{ id: string, direction: 'earlier' }>>}  `guild`: the served guild (default: the channel's).
 */
export function createChannelRouter({ hot, store, llm, now = Date.now }) {
  return async function routeChannels({ guildId, channel, guild = channel?.guild ?? null, partner = null, history, trigger = null, triggerKind = null, selfName }) {
    const channelId = channel?.id ?? null;
    try {
      const config = hot.config;
      const settings = routeSettings(config);
      if (!settings) return [];
      const allowed = channel?.guild ? routeAllowed({ triggerKind }) : Boolean(guild && partner) && triggerKind === 'private';
      if (!allowed) return [];
      const prompt = hot.prompts?.['route-channel'];
      if (typeof prompt !== 'string' || !prompt.trim()) {
        log.info('route: skipped', { channel: channelId, reason: 'no-prompt' });
        return [];
      }
      const candidate = routeCandidate(history, trigger);
      if (!candidate) {
        log.info('route: skipped', { channel: channelId, reason: 'no-candidate' });
        return [];
      }

      const at = now();
      const { lines, ids } = routeChannelOffer({ store, guildId, channel, guild, partner, candidate, config, settings, now: at });
      if (lines.length === 0) return [];

      const { transcriptBlock, candidateBlock } = routeContext({
        history,
        candidate,
        contextMessages: settings.contextMessages,
        config,
        labels: hot.prompts.labels,
        selfName,
      });
      const messages = buildRouteRequest({ prompt, selfName, transcriptBlock, candidateBlock, lines });
      if (!messages) return [];

      let completion;
      try {
        completion = await llm.complete(messages, {
          model: roleModel(config, 'analyzer', 'route-channel'),
          ...helperRequestOptions(config, { role: 'analyzer', maxOutputTokens: settings.maxOutputTokens, purpose: 'route-channel' }),
        });
      } catch (err) {
        log.warn('route: failed', { channel: channelId, reason: railReason(err), status: err?.statusCode ?? null, name: err?.name ?? null });
        return [];
      }
      const { index, reason, direction } = parseRouteAnswer(completion?.text, ids.length);
      const pick = index === null ? null : ids[index - 1];
      log.info('route: classified', { channel: channelId, kind: triggerKind ?? null, channels: ids.length, pick, parse: reason, direction: pick ? direction : null, ms: now() - at });
      if (!pick) return [];
      return direction === 'earlier' ? [{ id: pick, direction }] : [pick];
    } catch (err) {
      log.warn('route: failed', { channel: channelId, reason: 'error', status: null, name: err?.name ?? null });
      return [];
    }
  };
}
