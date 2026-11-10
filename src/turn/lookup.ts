// What a turn looks up before its reply request: the memory prefetch of its trigger, the splitter of a message that
// holds several requests, and the directory and partner a turn's searches and mentions read. createTurnRunner
// (src/behavior/turn.ts) builds it once per runner with createLookup; the attempt calls its functions.

import { attentionRetrieval } from '../intentions/model.ts';
import { personOfMember } from '../memory/addresses.ts';
import { isCliOwner } from '../behavior/core-pause.ts';
import { prefetchLanes, prefetchOn, wakeLanes } from '../behavior/prefetch.ts';
import { fillPromptTemplate } from '../behavior/prompt.ts';
import { recallSettings } from '../behavior/recall.ts';
import type { Snapshot } from '../behavior/snapshot.ts';
import { parseSplitAnswer, splitSettings } from '../behavior/split.ts';
import type { Reads } from '../interface/reads.ts';
import { railReason, roleRequestOptions } from '../llm/openrouter.ts';
import { roleModel } from '../llm/roles.ts';
import { isIssuedInternalContext } from '../memory/db/scope.ts';
import type { Context } from '../memory/db/scope.ts';
import { log } from '../log.ts';
import type { ChatRef, MemberInfo } from '../protocol/adapter.ts';
import { CODE } from '../tools/codes.ts';
import type { JournalNotes } from './journal-notes.ts';
import type { journalled } from './journal.ts';
import type { ClassifierContextInput } from './lookup-input.ts';
import { mentionDirectory } from './mentions.ts';
import type { ClassifierLlm, Rewatch } from './rewatch.ts';
import type { TriggerKind } from './triggers.ts';

/** The schema of the splitter's answer, handed to the client as `responseFormat`: `{ "parts": [text, ...] }`. */
export const SPLIT_FORMAT = {
  name: 'split',
  schema: {
    type: 'object',
    properties: { parts: { type: 'array', items: { type: 'string' } } },
    required: ['parts'],
    additionalProperties: false,
  },
};

/** The live config, as far as the lookup reads it; the settings functions read their own sections. */
export type LookupConfig = ClassifierContextInput['config'] & {
  bot?: { timezone?: string } | null;
  private?: { likeServer?: unknown } | null;
};

/** What recall's server search found: its summary, the stretch it quoted and the people in it. */
type RecallFound = { text?: unknown; stretch?: unknown; people?: unknown } | null;

/** The recall runner (src/behavior/recall-run.ts#createRecall), as the searches and the prefetch use it. */
export type LookupRecall = {
  available?: () => unknown;
  run?: (input: Record<string, unknown>) => Promise<RecallFound>;
  prefetch?: (
    input: Record<string, unknown>
  ) => Promise<{ status?: unknown; excerpts?: ReadonlyArray<unknown>; ms?: unknown } | null>;
} | null;

/** The memory store, as the lookup reads its profiles. */
type LookupStore = { listUserProfiles: () => Array<object> | null };

/** What a preparation step writes: its start, its result and its failure (createPrepLedger's). */
type PrepOp = NonNullable<Parameters<typeof journalled>[0]>;

/** What a step's result is judged on when the journal says whether it reached the request. */
type PrepResult = { excerpts: number; summaryChars: number; stretch: unknown };

/** The attempt's journal step: one preparation operation of a stage, or null when the journal does not follow. */
export type JournalStep = (
  stage: string,
  name: string,
  fields: { input: object },
  offeredOf?: (result: PrepResult) => unknown
) => PrepOp | null;

/** What createLookup reads: the dependencies and the functions of the other topic modules it calls. */
export type LookupContext = {
  hot: {
    readonly prompts: { labels: object };
  };
  store: LookupStore;
  llm: ClassifierLlm;
  clock: () => number;
  recall: LookupRecall;
  membersOf: ((placeId: string) => Iterable<unknown>) | null;
  selfIdOf: () => string;
  ifaceReads: Reads;
  classifierContext: Rewatch['classifierContext'];
  linkCalls: JournalNotes['linkCalls'];
};

type Channel = { id: string };

/** One lane of a prefetch, and the prefetch of a trigger: its lanes and the search they make. */
type Lane = { kind: string; text: string; words: string };
type Prefetching = { lanes: Array<Lane>; pending: Promise<unknown> };

function prefetchKey({
  memoryContext,
  historyRef,
  triggerKey,
}: {
  memoryContext?: Context | null;
  historyRef?: ChatRef;
  triggerKey: string;
}): string {
  return JSON.stringify([memoryContext?.id ?? null, historyRef?.iface ?? null, historyRef?.chatId ?? null, triggerKey]);
}

export type Lookup = {
  startPrefetch: (args: {
    historyRef?: ChatRef;
    memoryContext?: Context | null;
    config: LookupConfig;
    channel: Channel;
    snapshot?: Snapshot | null;
    placeId: string;
    place: unknown;
    partner?: { id?: string | null } | null;
    trigger: { id?: string; authorId?: string | null } | null;
    candidate?: { content?: string | null; authorId?: string | null } | null;
    triggerKind?: TriggerKind | null;
    mode?: string | null;
    history: Array<object>;
    selfId: string | null;
    selfName: string;
    nameOf?: ((id: string) => string | null) | null;
    journalStep?: JournalStep | null;
    wake?: { intentions?: ReadonlyArray<{ purpose?: unknown } | null> } | null;
  }) => Prefetching | null;
  recallAvailable: () => boolean;
  turnDirectory: (args: { placeId: string; memoryOn: boolean }) => () => ReturnType<typeof mentionDirectory>;
  privatePartner: (args: {
    iface: string | undefined;
    placeId: string;
    accountId: string | null | undefined;
    config: LookupConfig;
  }) => Promise<MemberInfo | null>;
  maybeSplit: (args: {
    config: LookupConfig;
    placeId: string;
    selfName: string;
    history: ClassifierContextInput['history'];
    trigger: ClassifierContextInput['trigger'];
    descriptions?: Map<string, unknown>;
    prompt: string;
    isLate: () => boolean;
  }) => Promise<Array<string> | null>;
};

// health: allow function-length until 2027-04-01 -- the lookup shares the runner state of src/behavior/turn.ts, moved whole in stage 5b
export function createLookup(ctx: LookupContext): Lookup {
  const { store, llm, clock, recall, membersOf, selfIdOf, ifaceReads, classifierContext, linkCalls } = ctx;

  // A trigger reuses its prefetch only within the same issued read context.
  // An ordinary turn cannot reuse private evidence fetched for the owner.
  const prefetchMemo = new Map<string, Promise<unknown>>();
  /** The most triggers whose prefetch is remembered (the oldest forgotten first). */
  const PREFETCH_MEMO = 16;

  /**
   * The automatic memory prefetch of a turn (src/behavior/prefetch.ts, read now): with prefetchOn
   * and the recall runner's `prefetch`, the lanes of this turn's trigger (prefetchLanes: none for
   * a turn no person's new message opened, nor for a trivial one -- logged `recall: prefetch
   * skipped` with its `reason`), searched once per trigger and text (`prefetchMemo`) over the
   * served place (a private chat on its `partner`'s behalf), the persona's lines marked with her
   * calls (linkCalls). A journal step `memory-prefetch` of the stage `prefetch` (`input.lanes`;
   * `status`, `excerpts`, `ms`) when it starts. Resolves never rejecting. Null when nothing runs,
   * else `{ lanes, pending }`.
   */
  function startPrefetch({
    config,
    channel,
    snapshot = null,
    placeId,
    place,
    partner,
    trigger,
    candidate,
    triggerKind,
    mode,
    history,
    selfId,
    selfName,
    nameOf,
    journalStep,
    wake = null,
    memoryContext,
    historyRef,
  }: Parameters<Lookup['startPrefetch']>[0]): Prefetching | null {
    if (
      !prefetchOn(config) ||
      typeof recall?.prefetch !== 'function' ||
      (!place && !isIssuedInternalContext(memoryContext))
    )
      return null;
    const settings = recallSettings(config)?.prefetch;
    if (!settings) return null;
    // An inner turn has no message: its lane is the purposes of the intentions it woke for.
    const purposes = mode === 'inner' ? (wake?.intentions ?? []).map((record) => record?.purpose) : null;
    const { lanes, skip } = purposes
      ? // wakeLanes reads each purpose as text, as the intentions keep it.
        wakeLanes(purposes as Array<string>)
      : prefetchLanes({
          trigger,
          candidate,
          triggerKind,
          mode,
          history,
          settings,
          selfId,
          selfName,
          selfNames: [],
          nameOf,
        });
    if (skip) {
      if (skip !== 'no-trigger') log.info('recall: prefetch skipped', { channel: channel.id, reason: skip });
      return null;
    }
    const triggerKey = purposes
      ? `${channel.id}:inner:${lanes[0]?.text ?? ''}`
      : `${channel.id}:${trigger?.id}:${candidate?.content ?? ''}`;
    const key = prefetchKey({ memoryContext, historyRef, triggerKey });
    const memo = prefetchMemo.get(key);
    if (prefetchMemo.has(key) && memo) return { lanes, pending: memo };
    const basis = lanes.map((lane) => lane.kind);
    const op =
      journalStep?.('prefetch', 'memory-prefetch', { input: { lanes: basis } }, (result) => result.excerpts > 0) ??
      null;
    const pending = (async () => {
      await op?.started();
      try {
        // Checked above: the recall runner has `prefetch`.
        const found = await recall.prefetch!({
          placeId,
          memoryContext,
          historyRef,
          snapshot,
          channel,
          partnerId: partner?.id ?? null,
          selfId,
          selfName,
          history,
          lanes,
          ...(mode === 'inner'
            ? { retrieval: attentionRetrieval(wake?.intentions ?? [], (id) => personOfMember(store, id)) }
            : {}),
          asker: candidate?.authorId ?? null,
          decorate: (lines: Array<object>) => linkCalls(lines, { channel, snapshot, placeId }),
        });
        op?.succeeded({ status: found?.status ?? null, excerpts: found?.excerpts?.length ?? 0, ms: found?.ms ?? null });
        return found;
      } catch (err) {
        log.warn('recall: prefetch failed', { channel: channel.id, stage: 'turn', name: nameOfError(err) });
        op?.failed(CODE.ERROR);
        return { status: 'unavailable', basis, excerpts: [] };
      }
    })();
    prefetchMemo.set(key, pending);
    // The memo is not empty while it is over its size.
    while (prefetchMemo.size > PREFETCH_MEMO) prefetchMemo.delete(prefetchMemo.keys().next().value as string);
    return { lanes, pending };
  }

  /**
   * Whether the server search (`recall`) could run now: wired, and its
   * `available()` (the switch, its prompt, the daily caps; read only) says
   * yes. A throw counts as no.
   */
  function recallAvailable(): boolean {
    if (typeof recall?.available !== 'function' || typeof recall.run !== 'function') return false;
    try {
      return recall.available() === true;
    } catch {
      return false;
    }
  }

  /**
   * The fallback directory of one turn (mentionDirectory) as a thunk, built on its first call
   * and kept for the turn: the members of the served root the member directory holds (only the members
   * the interface already told the core of, no read) and, with memory on, the stored
   * profiles. A failure to build it logs `turn: directory failed` and gives an empty one.
   */
  function turnDirectory({
    placeId,
    memoryOn,
  }: {
    placeId: string;
    memoryOn: boolean;
  }): () => ReturnType<typeof mentionDirectory> {
    let built: ReturnType<typeof mentionDirectory> | null = null;
    return () => {
      if (built) return built;
      try {
        const members = typeof membersOf === 'function' ? membersOf(placeId) : [];
        const profiles =
          memoryOn && typeof store.listUserProfiles === 'function' ? (store.listUserProfiles() ?? []) : [];
        built = mentionDirectory({ members, profiles, selfId: selfIdOf() || null });
      } catch (err) {
        log.warn('turn: directory failed', { placeId, error: err });
        built = [];
      }
      return built;
    };
  }

  /**
   * A private chat's partner as a member of the served root (`memberInfo`), for a private chat that works
   * like a server turn on their behalf: features.privateLikeServer (read from `config`, the turn's live
   * config; a missing key counts as on, only false turns it off). Null with the switch off, without a user id or in
   * the owner's chat.
   * A read the interface does not answer, an error answer and a user who is no member (the member left) are null
   * and log `turn: partner failed`. Never rejects.
   */
  async function privatePartner({
    iface,
    placeId,
    accountId,
    config,
  }: Parameters<Lookup['privatePartner']>[0]): Promise<MemberInfo | null> {
    if (config.private?.likeServer === false || !accountId || isCliOwner(iface, accountId)) return null;
    const found = await ifaceReads.memberInfo({ placeId, accountId: String(accountId) });
    if (found?.member) return found.member;
    log.warn('turn: partner failed', { placeId, accountId });
    return null;
  }

  /**
   * The splitter (src/behavior/split.ts): whether the call `trigger` holds
   * several requests. One cheap classifier call (`prompt`, prompts/split.md,
   * `{{name}}` = the persona's display name, `{{maxTasks}}` = split.maxTasks;
   * on the `analyzer` model role (roleModel), its answer capped at split.maxOutputTokens, a
   * `analyzer` request: roleRequestOptions, purpose `split`) reads the last
   * `split.contextMessages` messages of `history` before the trigger (the
   * captions this turn has at its start) and the trigger itself, and answers
   * the object of SPLIT_FORMAT, `{ "parts": [...] }` (parseSplitAnswer). Resolves
   * the parts, or null for one request: no part or one, a failed call (`split: failed`
   * with the rail's code or `llm-error` and the HTTP status), an empty or
   * unparsable answer (`split: failed`, `empty` / `unparsed`). Every answer
   * that parsed logs `split: verdict` (`parts`: 1 for one request, `ms`, and `late`
   * once the turn went on without it, `isLate()`). Codes and counts only,
   * never a part. Never throws.
   */
  async function maybeSplit({
    config,
    placeId,
    selfName,
    history,
    trigger,
    descriptions,
    prompt,
    isLate,
  }: Parameters<Lookup['maybeSplit']>[0]): Promise<Array<string> | null> {
    const settings = splitSettings(config);
    const startedAt = clock();
    let completion;
    try {
      const { triggerText, transcriptBlock } = classifierContext({
        config,
        selfName,
        history,
        trigger,
        contextMessages: settings.contextMessages,
        descriptions,
      });
      completion = await llm.complete(
        [
          {
            role: 'system',
            content: fillPromptTemplate(prompt, { name: selfName ?? '', maxTasks: settings.maxTasks }),
          },
          {
            role: 'user',
            content: `${transcriptBlock}<candidate>\n${trigger.authorName}: ${triggerText}\n</candidate>`,
          },
        ],
        {
          model: roleModel(config, 'analyzer', 'split'),
          ...roleRequestOptions(config, {
            role: 'analyzer',
            maxOutputTokens: settings.maxOutputTokens,
            purpose: 'split',
          }),
          responseFormat: SPLIT_FORMAT,
        }
      );
    } catch (err) {
      // A thrown value carries its HTTP status when the provider answered one.
      const status = (err as { statusCode?: unknown } | null | undefined)?.statusCode ?? null;
      log.warn('split: failed', { channel: placeId, reason: railReason(err), status });
      return null;
    }
    const { parts, reason } = parseSplitAnswer(completion?.text, settings);
    const late = isLate() ? { late: true } : {};
    if (reason === 'empty' || reason === 'unparsed') {
      log.warn('split: failed', { channel: placeId, reason, status: null, ...late });
      return null;
    }
    log.info('split: verdict', { channel: placeId, parts: parts?.length ?? 1, ms: clock() - startedAt, ...late });
    return parts;
  }

  return {
    startPrefetch,
    recallAvailable,
    turnDirectory,
    privatePartner,
    maybeSplit,
  };
}

/** The name of a thrown value, when it has one. */
function nameOfError(err: unknown): unknown {
  // A thrown value is anything; its name is read when it has one, as an Error does.
  return (err as { name?: unknown } | null | undefined)?.name ?? null;
}
