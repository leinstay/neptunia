// The route classifier's I/O side: the production route hook of the turn
// runner (src/behavior/turn.ts, `routeChannels`). When a conversation is
// about another channel nobody named with an explicit <#id>, one cheap
// classifier call picks it from the server's stored channel map so the pull
// phase can show it in `<channel_view>`. The decisions live in
// src/behavior/route.ts; this module reads the live config and prompts, the
// store's channel map and profiles, judges each listed channel with the pull
// phase's own rails (src/behavior/pull-fetch.ts#checkPull over the turn's snapshot, no read) and
// sends the one request through the rails of src/llm/openrouter.js.

import { accountOf } from '../memory/addresses.ts';
import { log } from '../log.ts';
import { roleRequestOptions, railReason } from '../llm/openrouter.ts';
import { roleModel } from '../llm/roles.ts';
import { checkPull } from './pull-fetch.ts';
import {
  buildRouteRequest,
  parseRouteAnswer,
  routeAllowed,
  routeCandidate,
  routeChannelList,
  routeContext,
  routeEntries,
  routeSettings,
} from './route.ts';
import { MEMORY_LIMITS } from '../memory/text-limits.ts';
import { objOf } from '../tools/types.ts';
import type { Untyped } from '../tools/types.ts';
import type { ConversationInfo } from '../protocol/adapter.ts';
import type { Snapshot } from './snapshot.ts';
import type { Line } from './lines.ts';
import type { StoredChannel, StoredProfile } from './route.ts';

/** What the route classifier reads of the store: the stored channels and a member's profile. */
export type RouteStore = {
  listChannels: (placeId: string) => Array<object>;
  getUser: (accountId: string) => StoredProfile | null;
};

/**
 * The numbered `<channels>` list of one route decision for the route hook below: the stored
 * channels of `placeId` other than `channel` and the candidate's own, each
 * judged with the pull phase's rails (checkPull against `channel` over `snapshot`,
 * `partnerId` for a private chat; a check that throws drops that channel), at most
 * `settings.maxChannels` (routeEntries), rendered by routeChannelList.
 * `ids[n - 1]` is the channel of line `n`. No read, no log.
 */
export function routeChannelOffer({
  store,
  placeId,
  channel,
  snapshot = null,
  partnerId = null,
  candidate,
  config,
  settings,
  now,
}: {
  store: RouteStore;
  placeId: string;
  channel: ConversationInfo;
  snapshot?: Snapshot | null;
  partnerId?: string | null;
  candidate: { placeId?: string | null } | null;
  config: Record<string, Untyped>;
  settings: { maxChannels: number; purposeChars: number };
  now: number;
}): { lines: Array<string>; ids: Array<string> } {
  const check = (id: string) => {
    try {
      const judged = checkPull({ snapshot, placeId: id, destination: channel, partnerId, config, now });
      return judged.skip === null ? judged.channel : null;
    } catch {
      return null;
    }
  };
  const entries = routeEntries({
    // The store answers its channels as plain objects; they are the stored channels.
    channels: store.listChannels(placeId) as Array<StoredChannel>,
    exclude: [channel?.id ?? null, candidate?.placeId ?? null].filter((id): id is string => Boolean(id)),
    check,
    profileOf: (accountId) => store.getUser(accountOf(store, accountId)),
    max: settings.maxChannels,
    aliasHalfLifeDays: MEMORY_LIMITS.aliasHalfLifeDays,
  });
  return routeChannelList(entries, { max: settings.maxChannels, purposeChars: settings.purposeChars });
}

/**
 * The route hook for createTurnRunner. Per call, with `hot.config` /
 * `hot.prompts` read at that moment: nothing (`[]`, no log) with
 * `features.channelRoute` off or on a turn routeAllowed refuses -- a private
 * chat asks only on behalf of its partner (`partner`, the member of the served
 * community the turn runner passes with
 * features.privateLikeServer on), for a `private` turn, and lists the
 * channels that member can view (checkPull's private-chat rule); `route:
 * skipped` (`reason: 'no-prompt'`) without `prompts['route-channel']`, (`reason:
 * 'no-candidate'`) without a message to judge (routeCandidate); nothing (no
 * call, no log) when no stored channel other than this one (and the
 * candidate's own) passes checkPull -- a check that throws drops that
 * channel. Else one request on the `analyzer` model role (roleModel), its answer capped at
 * `route.maxOutputTokens`, with the analyzer timeout, logged `route:
 * classified` (`kind`, `channels` = the list length, `pick` = the channel id
 * or null, `parse` = the parse code, `direction`, `ms`). Resolves `[id]` for a
 * pick, `[{ id, direction: 'earlier' }]` for a pick that asks for the page
 * before the last view of that channel (parseRouteAnswer), else `[]`; never rejects: a failure logs `route: failed` (`reason`: the rail
 * code of a refused or failed request, `error` for anything else). Counts,
 * ids and codes only: never a message text, never a channel name.
 * @returns `snapshot`: the turn's listing of the served community.
 */
export function createChannelRouter({
  hot,
  store,
  llm,
  now = Date.now,
}: {
  hot: { config: Record<string, Untyped>; prompts: Record<string, Untyped> };
  store: RouteStore;
  llm: { complete: (...args: Array<Untyped>) => Untyped };
  now?: () => number;
}): (args: {
  placeId: string;
  channel: ConversationInfo;
  snapshot?: Snapshot | null;
  partner?: { id: string } | null;
  history: Array<Line>;
  trigger: Line | null;
  triggerKind?: string | null;
  selfName: string;
  config?: Untyped;
}) => Promise<Array<string | { id: string; direction: 'earlier' }>> {
  return async function routeChannels({
    placeId,
    channel,
    snapshot = null,
    partner = null,
    history,
    trigger = null,
    triggerKind = null,
    selfName,
  }) {
    const conversationId = channel?.id ?? null;
    try {
      const config = hot.config;
      const settings = routeSettings(config);
      if (!settings) return [];
      const allowed =
        channel?.rootId != null
          ? routeAllowed({ triggerKind })
          : Boolean(snapshot && partner) && triggerKind === 'private';
      if (!allowed) return [];
      const prompt = hot.prompts?.['route-channel'];
      if (typeof prompt !== 'string' || !prompt.trim()) {
        log.info('route: skipped', { channel: conversationId, reason: 'no-prompt' });
        return [];
      }
      const candidate = routeCandidate(history, trigger);
      if (!candidate) {
        log.info('route: skipped', { channel: conversationId, reason: 'no-candidate' });
        return [];
      }

      const at = now();
      const { lines, ids } = routeChannelOffer({
        store,
        placeId,
        channel,
        snapshot,
        partnerId: partner?.id ?? null,
        candidate,
        config,
        settings,
        now: at,
      });
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
          ...roleRequestOptions(config, {
            role: 'analyzer',
            maxOutputTokens: settings.maxOutputTokens,
            purpose: 'route-channel',
          }),
        });
      } catch (err) {
        log.warn('route: failed', {
          channel: conversationId,
          reason: railReason(err),
          status: objOf(err).statusCode ?? null,
          name: objOf(err).name ?? null,
        });
        return [];
      }
      const { index, reason, direction } = parseRouteAnswer(completion?.text, ids.length);
      const pick = index === null ? null : ids[index - 1];
      log.info('route: classified', {
        channel: conversationId,
        kind: triggerKind ?? null,
        channels: ids.length,
        pick,
        parse: reason,
        direction: pick ? direction : null,
        ms: now() - at,
      });
      if (!pick) return [];
      return direction === 'earlier' ? [{ id: pick, direction }] : [pick];
    } catch (err) {
      log.warn('route: failed', {
        channel: conversationId,
        reason: 'error',
        status: null,
        name: objOf(err).name ?? null,
      });
      return [];
    }
  };
}
