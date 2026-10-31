// What a turn reads around its request: the port references of a conversation and a message, the gateway's check of
// one effect of her reply, the memory context of an attempt's reads, skills discovery for a classifier, the stable
// freezes per guild, and the request's `errands`, `<intentions>` and `<places>` inputs. createTurnRunner
// (src/behavior/turn.js) builds it once per runner with createInputs; the attempt and the other topic modules call its
// functions.

import type { Snapshot } from '../behavior/snapshot.ts';
import { placesBlockText } from '../behavior/wake.ts';
import { innerSettings } from '../behavior/inner.ts';
import { DEFAULT_RESULT_MAX_CHARS, errandResultText, errandsBlockText } from '../errands/blocks.ts';
import type { ErrandRecord } from '../errands/types.ts';
import { portIface } from '../interface/capabilities.ts';
import { DEFAULT_INTENTIONS_CAP, intentionsBlockText } from '../intentions/blocks.ts';
import { intentionSettings } from '../intentions/model.ts';
import { log } from '../log.js';
import { channelPlaceId, personId } from '../memory/db/ids.ts';
import type { ConversationRef, MessageRef } from '../protocol/adapter.ts';
import { IN_TURN_TOOLS } from '../tools/tools.ts';
import { skillFeatureOn } from '../tools/access.ts';
import { discoveryOn, proposalVerdicts, proposedRows, skillsIndex } from '../tools/discovery.ts';
import type { SkillsLines } from '../tools/discovery.ts';
import { checkReplyEffect, listSkills } from '../tools/gateway.ts';
import type { SkillMap } from '../tools/types.ts';
import { PERSONA, defaultSkills, requesterOf } from './calls.ts';
import { inCommunity } from './routing.ts';

/** The live config, as far as the inputs read it; the settings functions read their own sections. */
export type InputsConfig = {
  features?: { intentions?: unknown } | null;
  errands?: { unreadShown?: number; resultMaxChars?: number } | null;
  bot?: { timezone?: string } | null;
  context?: { caps?: { intentions?: number } | null; places?: unknown } | null;
};

/** The labels as the inputs hand them on; the block functions read their own sections. */
type InputsLabels = { locale?: string; [key: string]: unknown } | null | undefined;

/** The interface port (src/interface/port.js), as far as its interface name is read. */
type InputsPort = { iface: string };

/** What a memory read's execution context is issued for: a private chat's partner, or a group's destination. */
type MemorySpec = { kind: 'dm'; person: string } | { kind: 'group'; destination: string | null };

/** The errands service (src/errands/service.ts), as far as `<errands>` lists from it. */
type InputsErrands = {
  view?: (args: { guildId: string; privateChannelId: string | null }) => unknown;
} | null;

/** One errand as `<errands>` tells it from the one a result turn brings. */
type ListedTask = { id?: unknown } | null;

/** Whether the errands view answered a list. */
const isTaskList = (value: unknown): value is ReadonlyArray<ListedTask> => Array.isArray(value);

/** The intentions service (src/intentions/service.ts), as far as `<intentions>` lists from it. */
type InputsIntentions = {
  view: (guildId: string, options: { privateChannelId: string | null }) => unknown;
} | null;

/** The inner life's places view (src/behavior/inner.ts#places). */
type PlacesView = ((guildId: string, options: { sort: string; page: number; pageSize: number }) => unknown) | null;

/** What createInputs reads: the dependencies of the runner. */
export type InputsContext = {
  hot: { readonly config: unknown; readonly prompts: { tools?: unknown } | null | undefined };
  store: { getUser?: (guildId: string, userId: string) => { names?: Array<string | null> } | null | undefined } | null;
  iface: InputsPort;
  skills: SkillMap | null;
  selfIdOf: () => string;
  memoryContext: ((spec: MemorySpec) => unknown) | null;
  errands: InputsErrands;
  intentions: InputsIntentions;
  places: PlacesView;
};

/** What an attempt's draft holds that the inputs read and write. */
type InputsDraft = {
  memoryContext?: unknown;
  privateUserId?: string | null;
  requesterGroups?: Array<string>;
  skillsProposed?: Array<{ name: string; allowed: boolean }>;
};

/** The gateway's verdict on one effect of her reply. */
type EffectVerdict = ReturnType<typeof checkReplyEffect>;

type InputArgs = {
  guildId: string;
  channel: { id: string; communityId?: string | null };
  isPrivate: boolean;
  config: InputsConfig;
  labels: InputsLabels;
  now: number;
};

export type Inputs = {
  turnContextOf: (
    draft: InputsDraft | null | undefined,
    channel: { id?: string; communityId?: string | null } | null | undefined
  ) => unknown;
  stableFreezeOf: (guildId: string | null | undefined) => Map<string, unknown>;
  conversationOf: (channel: { id: string }) => ConversationRef;
  messageOf: (channel: { id: string }, messageId: string) => MessageRef;
  checkEffect: (skill: string, args: unknown, at: { channel: { id: string } }) => EffectVerdict;
  discoveryPrompt: (config: unknown) => { index: string; names: Array<string> };
  discoverSkills: (args: {
    config: unknown;
    channel: { id: string };
    trigger: { authorId?: string | null } | null | undefined;
    answer: Pick<SkillsLines, 'inventory' | 'names'> | null | undefined;
    draft: InputsDraft | null | undefined;
  }) => Array<object> | null;
  errandsInputFor: (
    args: InputArgs & { taskResult: ErrandRecord | null | undefined }
  ) => { list: string; result: string } | null;
  intentionsInputFor: (args: InputArgs & { snapshot?: Snapshot | null }) => string;
  placesInputFor: (args: { guildId: string; config: InputsConfig; labels: InputsLabels }) => string;
};

export function createInputs(ctx: InputsContext): Inputs {
  const { hot, store, iface, skills, selfIdOf, memoryContext, errands, intentions, places } = ctx;

  /**
   * The one execution context of an attempt's memory reads (`memoryContext`): issued the first time a read needs it
   * (a memory search, the request's record) and kept on the draft, so recall and the turn's read record carry one id.
   * A private chat reads as a DM of its partner, anything else as the interface's group. Null without the dependency
   * or the draft, for a private chat whose partner is unknown, or when issuing fails (never a turn's failure).
   */
  function turnContextOf(
    draft: InputsDraft | null | undefined,
    channel: { id?: string; communityId?: string | null } | null | undefined
  ): unknown {
    if (!draft || typeof memoryContext !== 'function') return null;
    if (draft.memoryContext !== undefined) return draft.memoryContext;
    let ctx: unknown = null;
    try {
      const isPrivate = !inCommunity(channel);
      const partner = isPrivate ? (draft.privateUserId ?? null) : null;
      if (!isPrivate || partner) {
        ctx =
          memoryContext(
            isPrivate
              ? { kind: 'dm', person: personId(portIface(iface), String(partner)) }
              : { kind: 'group', destination: channel?.id ? channelPlaceId(portIface(iface), channel.id) : null }
          ) ?? null;
      }
    } catch {
      ctx = null;
    }
    draft.memoryContext = ctx;
    return ctx;
  }
  // Per guild: what the stable part of the reply showed from memory in the current cache bucket
  // (src/behavior/prompt.js#freezePerBucket), in process only; a restart starts afresh.
  const stableFreezes = new Map<string, Map<string, unknown>>();
  const stableFreezeOf = (guildId: string | null | undefined): Map<string, unknown> => {
    const key = String(guildId ?? '');
    let freeze = stableFreezes.get(key);
    if (!freeze) {
      freeze = new Map();
      stableFreezes.set(key, freeze);
    }
    return freeze;
  };

  /**
   * The port reference of a conversation (its info, a snapshot entry, anything with an `id`), in the iface it names.
   */
  function conversationOf(channel: { id: string }): ConversationRef {
    return { iface: portIface(channel) || iface.iface, conversationId: String(channel.id) };
  }

  /**
   * The port reference of message `messageId` in `channel`.
   */
  function messageOf(channel: { id: string }, messageId: string): MessageRef {
    return { ...conversationOf(channel), messageId: String(messageId) };
  }

  /**
   * The gateway's verdict on one effect of the persona's reply in `channel`
   * (src/tools/gateway.ts#checkReplyEffect, the live config read now): carried over in the
   * current conversation, refused only under the full stop. `args` and `trigger` name the effect
   * for the reader; the check needs neither. A refusal logs `skill: refused`.
   */
  function checkEffect(skill: string, _args: unknown, { channel }: { channel: { id: string } }): EffectVerdict {
    const verdict = checkReplyEffect({ skill, principal: PERSONA, config: hot.config });
    if (!verdict.ok)
      log.info('skill: refused', { skill, code: verdict.code, reason: verdict.reason, channel: channel.id });
    return verdict;
  }

  /**
   * What skills discovery gives a classifier (src/tools/discovery.ts, the live config read by
   * the caller now): `index` fills its prompt's `{{skills}}` (skillsIndex over the registry and
   * `hot.prompts.tools`: static texts, no grant), `names` are the registry's skills its `skills:`
   * line may name. With discovery off, '' and none.
   */
  function discoveryPrompt(config: unknown): { index: string; names: Array<string> } {
    if (!discoveryOn(config)) return { index: '', names: [] };
    // Her in-turn tools are hers to call (features.coreTools, where no classifier runs): never offered to one.
    // A skill whose feature switch is off is not offered either (src/tools/access.ts#skillFeatureOn).
    const registry = new Map(
      [...(skills ?? defaultSkills())].filter(([name]) => !IN_TURN_TOOLS.includes(name) && skillFeatureOn(name, config))
    );
    const names = [...registry.keys()];
    return { index: skillsIndex(registry, hot.prompts?.tools), names };
  }

  /**
   * What a classifier's `skills:` line (`answer`: parseSkillsLines' result, null when it gave
   * none) does on a turn someone asked for, with discovery on (read by the caller now). The
   * catalogue of this requester (`trigger`'s author) in `channel` (src/tools/gateway.ts#listSkills,
   * the state read now) decides both: on `inventory` its rows are returned for the request's
   * `<skills>` (logged `skills: inventory` with counts); on named skills (at most four) each name
   * with the gateway's verdict is logged `skills: proposed` and noted in the draft's
   * `skillsProposed` (`{ name, allowed }`) for the journal's turn record, and their catalogue rows
   * are returned marked `proposed` (`<skills>` then shows the allowed ones and names the others).
   * Null otherwise. Names and codes only, never a message.
   */
  function discoverSkills({
    config,
    channel,
    trigger,
    answer,
    draft,
  }: Parameters<Inputs['discoverSkills']>[0]): Array<object> | null {
    if (!answer || !discoveryOn(config)) return null;
    const named: ReadonlyArray<string> = Array.isArray(answer.names) ? answer.names : [];
    if (answer.inventory !== true && named.length === 0) return null;
    const rows = listSkills({
      config,
      selfId: selfIdOf() || null,
      texts: hot.prompts?.tools,
      requester: requesterOf(trigger, draft?.requesterGroups ?? []),
      audience: { conversationId: String(channel.id) },
      registry: skills ?? defaultSkills(),
    });
    if (answer.inventory === true) {
      log.info('skills: inventory', {
        channel: channel.id,
        listed: rows.length,
        allowed: rows.filter((row) => row.allowed).length,
      });
      return rows;
    }
    const proposals = proposalVerdicts(named, rows);
    log.info('skills: proposed', { channel: channel.id, count: proposals.length, proposals });
    if (draft) draft.skillsProposed = proposals.map(({ name, allowed }) => ({ name, allowed }));
    return proposedRows(proposals, rows);
  }

  /**
   * The errands `<errands>` lists: her open errands and unread results (`errands.view`), the one `taskResult` brings left out.
   */
  function listedTasks({
    guildId,
    channel,
    isPrivate,
    taskResult,
  }: {
    guildId: string;
    channel: { id: string };
    isPrivate: boolean;
    taskResult: ErrandRecord | null | undefined;
  }): Array<ListedTask> {
    let shown: unknown = [];
    try {
      shown =
        typeof errands?.view === 'function'
          ? errands.view({ guildId, privateChannelId: isPrivate ? String(channel.id) : null })
          : [];
    } catch (err) {
      log.warn('turn: tasks view failed', { channel: channel.id, error: err });
    }
    return (isTaskList(shown) ? shown : []).filter((task) => task?.id !== taskResult?.id);
  }

  /**
   * The request's `errands` input (buildRequest): the `<errands>` body -- her open errands and the
   * finished ones she has not read (`errands.view`: a private chat's only in that chat; at most
   * `errands.unreadShown` of them), the one `taskResult` brings left out -- and, on the turn an
   * errand's end opened (`taskResult`, trigger kind `errand`), the `<errand_result>` body cut to
   * `errands.resultMaxChars` (read now). Showing a task marks nothing: it is read by the result
   * turn that completed (src/errands/turns.ts) or by `errand.read`. Null when there is nothing to show.
   */
  function errandsInputFor({
    guildId,
    channel,
    isPrivate,
    taskResult,
    config,
    labels,
    now,
  }: Parameters<Inputs['errandsInputFor']>[0]): { list: string; result: string } | null {
    const listed = listedTasks({ guildId, channel, isPrivate, taskResult });
    const list = errandsBlockText(listed, labels, { now, unreadShown: config.errands?.unreadShown });
    const result = taskResult
      ? errandResultText(taskResult, labels, { maxChars: config.errands?.resultMaxChars ?? DEFAULT_RESULT_MAX_CHARS })
      : '';
    return list || result ? { list, result } : null;
  }

  /**
   * The request's `<intentions>` body (features.intentions exactly true, read now): her open
   * intentions and the candidates proposed from her lines (`intentions.view`: a private chat's
   * own only in that chat), cut to `context.caps.intentions` tokens (src/intentions/blocks.ts).
   * '' with the switch off, without the service, or with nothing to show.
   */
  function intentionsInputFor({
    guildId,
    channel,
    snapshot = null,
    isPrivate,
    config,
    labels,
    now,
  }: Parameters<Inputs['intentionsInputFor']>[0]): string {
    if (!intentions || config.features?.intentions !== true) return '';
    let shown: unknown = [];
    try {
      shown = intentions.view(guildId, { privateChannelId: isPrivate ? String(channel.id) : null });
    } catch (err) {
      log.warn('turn: intentions view failed', { channel: channel.id, error: err });
      return '';
    }
    const channelNameOf = (id: string): string | null =>
      inCommunity(channel) ? (snapshot?.get(String(id))?.name ?? null) : null;
    const nameOf = (id: string): string | null =>
      typeof store?.getUser === 'function' ? (store.getUser(guildId, String(id))?.names?.[0] ?? null) : null;
    return intentionsBlockText(shown, labels, {
      timezone: config.bot?.timezone ?? 'UTC',
      locale: labels?.locale,
      maxTokens: config.context?.caps?.intentions ?? DEFAULT_INTENTIONS_CAP,
      channelNameOf,
      nameOf,
      now,
      expiryNoticeDays: intentionSettings(config).expiryNoticeDays,
    });
  }

  /**
   * The request's `<places>` body (context.places exactly true, read now; src/behavior/wake.ts#placesBlockText):
   * the first `innerLife.attention.placesInWake` places by recent activity (0: none), from the inner
   * life's places view. '' with the switch off, without the view, or when it fails.
   */
  function placesInputFor({ guildId, config, labels }: Parameters<Inputs['placesInputFor']>[0]): string {
    if (config.context?.places !== true || typeof places !== 'function') return '';
    const size = innerSettings(config).attention.placesInWake;
    if (!(size > 0)) return '';
    try {
      return placesBlockText(places(guildId, { sort: 'recent', page: 1, pageSize: size }), labels);
    } catch (err) {
      log.warn('turn: places view failed', { guildId, error: err });
      return '';
    }
  }

  return {
    turnContextOf,
    stableFreezeOf,
    conversationOf,
    messageOf,
    checkEffect,
    discoveryPrompt,
    discoverSkills,
    errandsInputFor,
    intentionsInputFor,
    placesInputFor,
  };
}
