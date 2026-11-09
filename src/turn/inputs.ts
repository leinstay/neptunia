// What a turn reads around its request: the port references of a chat and a message, the gateway's check of
// one effect of her reply, the memory context of an attempt's reads, the stable
// freezes per place, and the request's `errands`, `<intentions>` and `<places>` inputs. createTurnRunner
// (src/behavior/turn.ts) builds it once per runner with createInputs; the attempt and the other topic modules call its
// functions.

import type { Chat } from '../protocol/events.ts';
import { accountOf } from '../memory/addresses.ts';
import type { Snapshot } from '../behavior/snapshot.ts';
import { placesBlockText } from '../behavior/wake.ts';
import { innerSettings } from '../behavior/inner.ts';
import { DEFAULT_RESULT_MAX_CHARS, errandResultText, errandsBlockText } from '../errands/blocks.ts';
import type { ErrandRecord } from '../errands/types.ts';
import { portIface } from '../interface/capabilities.ts';
import { personOfMember, placeOfChat } from '../memory/addresses.ts';
import { DEFAULT_INTENTIONS_CAP, intentionsBlockText } from '../intentions/blocks.ts';
import { intentionSettings } from '../intentions/model.ts';
import { log } from '../log.ts';
import type { ChatRef, MessageRef } from '../protocol/adapter.ts';
import { checkReplyEffect } from '../tools/gateway.ts';
import { PERSONA } from './calls.ts';
import { inRoot } from './routing.ts';

/** Whether an addressed turn's request carries `<places>`. Production value, config cut of 2026-10-31: off. */
const ADDRESSED_PLACES: boolean = false;

/** The live config, as far as the inputs read it; the settings functions read their own sections. */
export type InputsConfig = {
  errands?: { resultMaxChars?: number } | null;
  bot?: { timezone?: string } | null;
  context?: { caps?: { intentions?: number } | null; places?: unknown; myDay?: { lines?: number } | null } | null;
};

/** The labels as the inputs hand them on; the block functions read their own sections. */
type InputsLabels = { locale?: string; [key: string]: unknown } | null | undefined;

/** The interface port (src/interface/port.ts), as far as its interface name is read. */
type InputsPort = { iface: string };

/** What a memory read's execution context is issued for: a private chat's partner, or a group's destination. */
type MemorySpec =
  { kind: 'dm'; person: string; place?: string } | { kind: 'group'; destination: string | null } | { kind: 'internal' };

/** The errands service (src/errands/service.ts), as far as `<errands>` lists from it. */
type InputsErrands = {
  view?: (args: { dmChatId: string | null }) => unknown;
} | null;

/** One errand as `<errands>` tells it from the one a result turn brings. */
type ListedTask = { id?: unknown } | null;

/** Whether the errands view answered a list. */
const isTaskList = (value: unknown): value is ReadonlyArray<ListedTask> => Array.isArray(value);

/** The intentions service (src/intentions/service.ts), as far as `<intentions>` lists from it. */
type InputsIntentions = {
  view: (options: { dmChatId: string | null }) => unknown;
} | null;

/** The inner life's places view (src/behavior/inner.ts#places). */
type PlacesView = ((placeId: string, options: { sort: string; page: number; pageSize: number }) => unknown) | null;

/** What createInputs reads: the dependencies of the runner. */
export type InputsContext = {
  store: { getUser: (accountId: string) => { names?: Array<string | null> } | null | undefined } | null;
  iface: InputsPort;
  memoryContext: ((spec: MemorySpec) => unknown) | null;
  errands: InputsErrands;
  intentions: InputsIntentions;
  places: PlacesView;
};

/** What an attempt's draft holds that the inputs read and write. */
type InputsDraft = {
  memoryContext?: unknown;
  nowhere?: boolean;
  mode?: string | null;
  privateAccountId?: string | null;
};

/** The gateway's verdict on one effect of her reply. */
type EffectVerdict = ReturnType<typeof checkReplyEffect>;

type InputArgs = {
  placeId: string;
  channel: { id: string };
  isDm: boolean;
  config: InputsConfig;
  labels: InputsLabels;
  now: number;
};

export type Inputs = {
  turnContextOf: (
    draft: InputsDraft | null | undefined,
    channel: Partial<Pick<Chat, 'id' | 'rootId'>> | null | undefined
  ) => unknown;
  stableFreezeOf: (placeId: string | null | undefined) => Map<string, unknown>;
  chatOf: (channel: { id: string }) => ChatRef;
  messageOf: (channel: { id: string }, messageId: string) => MessageRef;
  checkEffect: (skill: string, args: unknown, at: { channel: { id: string } }) => EffectVerdict;
  errandsInputFor: (
    args: InputArgs & { taskResult: ErrandRecord | null | undefined }
  ) => { list: string; result: string } | null;
  intentionsInputFor: (args: InputArgs & { snapshot?: Snapshot | null; due?: ReadonlyArray<string> }) => string;
  intentionRefsFor: () => { texts: Array<string>; places: Array<string> };
  placesInputFor: (args: { placeId: string; config: InputsConfig; labels: InputsLabels }) => string;
};

export function createInputs(ctx: InputsContext): Inputs {
  const { store, iface: port, memoryContext, errands, intentions, places } = ctx;

  /**
   * The one execution context of an attempt's memory reads (`memoryContext`): issued the first time a read needs it
   * (a memory search, the request's record) and kept on the draft, so recall and the turn's read record carry one id.
   * A turn that runs nowhere reads as herself (`internal`), except a selfreflection post, which reads as the interface's
   * group, the audience of the mirrors its entry is copied to. A private chat reads as a DM of its partner, anything
   * else as the interface's group. Null without the dependency
   * or the draft, for a private chat whose partner is unknown or has no stored person, or when issuing fails (never a
   * turn's failure).
   */
  function turnContextOf(
    draft: InputsDraft | null | undefined,
    channel: Partial<Pick<Chat, 'id' | 'rootId'>> | null | undefined
  ): unknown {
    if (!draft) return null;
    if (draft.memoryContext !== undefined) return draft.memoryContext;
    if (typeof memoryContext !== 'function') return null;
    let ctx: unknown = null;
    try {
      if (draft.nowhere === true) {
        const spec: MemorySpec =
          draft.mode === 'selfreflection' ? { kind: 'group', destination: null } : { kind: 'internal' };
        ctx = memoryContext(spec) ?? null;
        draft.memoryContext = ctx;
        return ctx;
      }
      const isDm = !inRoot(channel);
      const channelIface = portIface(channel) || portIface(port);
      const partner = isDm ? (draft.privateAccountId ?? null) : null;
      const person = partner ? personOfMember(store, String(partner), channelIface) : null;
      if (!isDm || person) {
        ctx =
          memoryContext(
            isDm && person
              ? {
                  kind: 'dm',
                  person,
                  place: placeOfChat(store, { kind: 'dm', partnerId: String(partner) }, channelIface),
                }
              : { kind: 'group', destination: channel?.id ? placeOfChat(store, channel, channelIface) : null }
          ) ?? null;
      }
    } catch {
      ctx = null;
    }
    draft.memoryContext = ctx;
    return ctx;
  }
  // Per place: what the stable part of the reply showed from memory in the current cache bucket
  // (src/behavior/prompt.ts#freezePerBucket), in process only; a restart starts afresh.
  const stableFreezes = new Map<string, Map<string, unknown>>();
  const stableFreezeOf = (placeId: string | null | undefined): Map<string, unknown> => {
    const key = String(placeId ?? '');
    let freeze = stableFreezes.get(key);
    if (!freeze) {
      freeze = new Map();
      stableFreezes.set(key, freeze);
    }
    return freeze;
  };

  /**
   * The port reference of a chat (its info, a snapshot entry, anything with an `id`), in the iface it names.
   */
  function chatOf(channel: { id: string }): ChatRef {
    return { iface: portIface(channel) || port.iface, chatId: String(channel.id) };
  }

  /**
   * The port reference of message `messageId` in `channel`.
   */
  function messageOf(channel: { id: string }, messageId: string): MessageRef {
    return { ...chatOf(channel), messageId: String(messageId) };
  }

  /**
   * The gateway's verdict on one effect of the persona's reply in `channel`
   * (src/tools/gateway.ts#checkReplyEffect, the live config read now): carried over in the
   * current chat, refused only under the full stop. `args` and `trigger` name the effect
   * for the reader; the check needs neither. A refusal logs `skill: refused`.
   */
  function checkEffect(skill: string, _args: unknown, { channel }: { channel: { id: string } }): EffectVerdict {
    const verdict = checkReplyEffect({ skill, principal: PERSONA });
    if (!verdict.ok)
      log.info('skill: refused', { skill, code: verdict.code, reason: verdict.reason, channel: channel.id });
    return verdict;
  }

  /**
   * The errands `<errands>` lists: her open errands and unread results (`errands.view`), the one `taskResult` brings left out.
   */
  function listedTasks({
    channel,
    isDm,
    taskResult,
  }: {
    placeId: string;
    channel: { id: string };
    isDm: boolean;
    taskResult: ErrandRecord | null | undefined;
  }): Array<ListedTask> {
    let shown: unknown = [];
    try {
      shown = typeof errands?.view === 'function' ? errands.view({ dmChatId: isDm ? String(channel.id) : null }) : [];
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
    placeId,
    channel,
    isDm,
    taskResult,
    config,
    labels,
    now,
  }: Parameters<Inputs['errandsInputFor']>[0]): { list: string; result: string } | null {
    const listed = listedTasks({ placeId, channel, isDm, taskResult });
    const list = errandsBlockText(listed, labels, { now });
    const result = taskResult
      ? errandResultText(taskResult, labels, { maxChars: config.errands?.resultMaxChars ?? DEFAULT_RESULT_MAX_CHARS })
      : '';
    return list || result ? { list, result } : null;
  }

  /**
   * The request's `<intentions>` body (features.intentions exactly true, read now): her open
   * intentions (`intentions.view`: a private chat's own only in that chat), cut to `context.caps.intentions` tokens (src/intentions/blocks.ts).
   * '' with the switch off, without the service, or with nothing to show.
   */
  function intentionsInputFor({
    channel,
    snapshot = null,
    isDm,
    config,
    labels,
    now,
    due = [],
  }: Parameters<Inputs['intentionsInputFor']>[0]): string {
    if (!intentions) return '';
    let shown: unknown = [];
    try {
      shown = intentions.view({ dmChatId: isDm ? String(channel.id) : null });
    } catch (err) {
      log.warn('turn: intentions view failed', { channel: channel.id, error: err });
      return '';
    }
    const channelNameOf = (id: string): string | null => (isDm ? null : (snapshot?.get(String(id))?.name ?? null));
    const nameOf = (id: string): string | null =>
      typeof store?.getUser === 'function' ? (store.getUser(accountOf(store, String(id)))?.names?.[0] ?? null) : null;
    const contextCaps = config.context?.caps;
    return intentionsBlockText(shown, labels, {
      timezone: config.bot?.timezone ?? 'UTC',
      locale: labels?.locale,
      maxTokens: contextCaps?.intentions ?? DEFAULT_INTENTIONS_CAP,
      channelNameOf,
      nameOf,
      now,
      expiryNoticeDays: intentionSettings(config).expiryNoticeDays,
      due,
    });
  }

  /**
   * What her open intentions refer to, for the seeds of a service's `<memory>`: their purposes (a line's identity in one
   * names that line) and the places they begin in, as `<intentions>` of a turn outside a private chat lists them. Nothing
   * without the service or when its view fails.
   */
  function intentionRefsFor(): { texts: Array<string>; places: Array<string> } {
    let shown: unknown = [];
    try {
      shown = intentions?.view({ dmChatId: null }) ?? [];
    } catch (err) {
      log.warn('turn: intentions view failed', { channel: null, error: err });
    }
    const records = (Array.isArray(shown) ? (shown as Array<unknown>) : []).map((one) =>
      one && typeof one === 'object' ? (one as { purpose?: unknown; destination?: unknown }) : {}
    );
    return {
      texts: records.map((one) => one.purpose).filter((text): text is string => typeof text === 'string'),
      places: records.map((one) => one.destination).filter((id): id is string => typeof id === 'string' && id !== ''),
    };
  }

  /**
   * The request's `<places>` body (with ADDRESSED_PLACES on; src/behavior/wake.ts#placesBlockText):
   * the first `wakes.attention.placesInWake` places by recent activity (0: none), from the inner
   * life's places view. '' with the switch off, without the view, or when it fails.
   */
  function placesInputFor({ placeId, config, labels }: Parameters<Inputs['placesInputFor']>[0]): string {
    if (!ADDRESSED_PLACES || typeof places !== 'function') return '';
    const size = innerSettings(config).attention.placesInWake;
    if (!(size > 0)) return '';
    try {
      return placesBlockText(places(placeId, { sort: 'recent', page: 1, pageSize: size }), labels);
    } catch (err) {
      log.warn('turn: places view failed', { placeId, error: err });
      return '';
    }
  }

  return {
    turnContextOf,
    stableFreezeOf,
    chatOf,
    messageOf,
    checkEffect,
    errandsInputFor,
    intentionsInputFor,
    intentionRefsFor,
    placesInputFor,
  };
}
