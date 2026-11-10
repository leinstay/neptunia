// Operations `errand.run`, `errand.list`, `errand.cancel`, `errand.read` and `errand.resolve`, reached by
// `errand.run|status|cancel|result|resolve`: the persona's errands handed to her agents
// (src/errands/, src/agent-runner/). Every member may use them while `features.memberCommands`
// is on (rights.member); the rest is ruled here, for every caller alike -- the owner's command,
// a member's, and the persona's own call (her skills: the requester of her turn is the caller).
// `errand.run` with `agent: server` reads this machine, so only an owner may ask for it
// (`owner-only`); `agent: scout` is any member's. An errand asked in a private chat is `dm`-scoped,
// else `group`, and the runner withholds more in a filtered scope. `errand.run` answers at once
// with the id and `queued`: the errand runs in the background (src/errands/service.ts) and its
// end opens her own turn where it was asked. `errand.cancel` is for the requester of the errand or an
// owner; `errand.list` shows a private chat's errands only to their requester or an
// owner. A finished errand's result stays until she has read it: `errand.list` without an id lists the
// open errands and the finished ones not read yet, and with a `state`, `since`, `until` or `limit` every errand that
// matches, newest first; `errand.read id [from]` returns the whole result in
// pages of `errands.resultMaxChars` (the error, the sources and the files with their handles and
// whether they expired come with the first page) and marks the errand read when its last page is
// returned; `errand.resolve id` closes a finished errand (read too). Both follow the same view rule. Answers are operator lines (ids, agents, states, ages), the goal cut to one short line. A
// `errand.run` of her turn links the intentions of that turn waiting for its errand (src/intentions/).

import { isOwnerCaller } from './grants.ts';
import { TASK_AGENTS } from './catalog.ts';
import { clampWithEllipsis, oneLine } from '../../memory/clamp.ts';
import { MINUTE_MS } from '../../time.ts';
import { ERRAND_STATES, fileHandle, isOpenState } from '../../errands/store.ts';
import { DEFAULT_RESULT_MAX_CHARS } from '../../errands/blocks.ts';
import { defineOp, perEnv, invalid, denied } from './registry.ts';
import { CODE } from '../codes.ts';
import { idText, textOf } from '../types.ts';
import { windowBound } from './shared.ts';
import type { Obj, OpContext } from '../types.ts';
import type { ErrandRecord, ErrandService } from '../../errands/types.ts';

/** How many errands a listing of `errand.list` shows when it names no limit. */
export const ERRAND_LIST_COUNT = 10;
/** The goal's length in an answer line (characters). */
const GOAL_LINE_CHARS = 80;
/** The most errands a listing shows. */
const ERRAND_LIST_MAX = 100;

/** The refusal codes of the errand store and service, as an operation's status. */
const REFUSALS = Object.freeze({
  [CODE.CAP_OPEN]: 'failed',
  [CODE.CAP_TASKS]: 'failed',
  [CODE.NOT_CONFIGURED]: 'failed',
  [CODE.PLACE_REQUIRED]: 'failed',
  [CODE.UNKNOWN_AGENT]: 'invalid',
  [CODE.BAD_GOAL]: 'invalid',
});

const handlers = perEnv((env) => {
  const { hot, assertNotPaused, now = Date.now } = env;

  /** The errand service, or an Error naming what is missing. */
  function errands(): ErrandService {
    if (!env.errands || typeof env.errands.submit !== 'function')
      throw Object.assign(new Error('the errand agents are not running'), { code: CODE.NOT_CONFIGURED });
    return env.errands;
  }

  /** Whether the caller is an owner (grants.ts#isOwnerId, read now). */
  function ownerCalls(context: OpContext) {
    return isOwnerCaller(hot.config, context);
  }

  /** Who asks: an owner, a member, or the persona on her own (her call with nobody asking). */
  function requesterOf(context: OpContext) {
    const accountId = context?.accountId ? idText(context.accountId) : null;
    if (!accountId) return { accountId: null, kind: context?.actor === 'persona' ? 'persona' : 'member' };
    return { accountId, kind: ownerCalls(context) ? 'owner' : 'member' };
  }

  /** Whether the chat the command runs in is a private chat. */
  function inPrivate(context: OpContext) {
    if (context?.dmChat === true) return true;
    const here = env.chatOf(context);
    return here ? env.directory.isDm(here) : false;
  }

  /** Whether the caller may see `errand`: a group errand anyone; a private chat's only its requester or an owner. */
  function mayView(errand: ErrandRecord, context: OpContext): boolean {
    if (errand.scope !== 'dm') return true;
    return (
      ownerCalls(context) || (Boolean(context?.accountId) && idText(context.accountId) === errand.requester?.accountId)
    );
  }

  /** One line of an errand: id, agent, state (with the error code and `files-expired`), age, goal. */
  function errandLine(errand: ErrandRecord): string {
    const minutes = Math.max(0, Math.floor((now() - (errand.createdAt ?? now())) / MINUTE_MS));
    const codes = [
      ...(errand.error && errand.state !== 'done' ? [errand.error] : []),
      ...(errand.filesExpired === true ? ['files-expired'] : []),
    ];
    const state = codes.length > 0 ? `${errand.state} (${codes.join(', ')})` : errand.state;
    return `${errand.id} ${errand.agent} ${state} ${minutes}m: ${clampWithEllipsis(oneLine(errand.goal), GOAL_LINE_CHARS)}`;
  }

  /** A refusal of the store or the service as the operation's result. */
  function refusal(code: string, errand?: ErrandRecord): Obj {
    const status = REFUSALS[code] ?? 'failed';
    return { status, code, summary: `errand not started: ${code}`, data: errand ? { task: errand } : null };
  }

  /** `errand.run agent goal`: a new errand, answered at once with its id and `queued`. */
  function cmdRun(args: Obj, context: OpContext) {
    assertNotPaused();
    const agent = textOf(args.agent).trim();
    if (!TASK_AGENTS.includes(agent)) throw invalid(`agent must be one of: ${TASK_AGENTS.join(', ')}`);
    const goal = textOf(args.goal).trim();
    if (!goal) throw invalid('a goal is required');
    const requester = requesterOf(context);
    // Only an owner may have this machine read, through the persona or not.
    if (agent === 'server' && requester.kind !== 'owner')
      throw denied('only an owner may ask for the server agent', CODE.OWNER_ONLY);
    const scope = inPrivate(context) ? 'dm' : 'group';
    // Her own call carries its turn and its idempotency key (src/tools/executors.ts); a command neither.
    const persona = context?.actor === 'persona';
    const origin = {
      placeId: env.chatOf(context),
      messageId: context?.sourceMessageId ? idText(context.sourceMessageId) : null,
      ...(persona && context?.turnId ? { turnId: idText(context.turnId) } : {}),
      ...(context?.publicationBoundary ? { publicationBoundary: context.publicationBoundary } : {}),
    };
    const idempotencyKey = persona && typeof context?.idempotencyKey === 'string' ? context.idempotencyKey : null;
    const submitted = errands().submit({
      agent,
      goal,
      requester,
      origin,
      scope,
      idempotencyKey,
    });
    if (!submitted.ok) return refusal(submitted.code);
    const { errand } = submitted;
    // An intention of the same turn waiting for the errand it hands off is linked to it now
    // (src/intentions/service.ts#linkTurnErrand); a refused errand above links nothing.
    if (origin.turnId) env.intentions?.linkTurnErrand?.({ turnId: origin.turnId, errandId: errand.id });
    return {
      status: 'ok',
      code: CODE.OK,
      summary: `errand ${errand.id}: queued (${agent})`,
      data: { text: `errand ${errand.id}: queued (${agent})`, task: { id: errand.id, agent, state: errand.state } },
    };
  }

  /** `errand.list [id]`: one errand, the open and unread ones, or with a filter every errand that matches. */
  function cmdStatus(args: Obj, context: OpContext) {
    const store = errands().store();
    if (!store) throw Object.assign(new Error('no place'), { code: CODE.PLACE_REQUIRED });
    const id = textOf(args.id).trim();
    if (id) {
      const errand = store.get(id);
      if (!errand || !mayView(errand, context)) throw invalid(`no errand ${id}`, CODE.NOT_FOUND);
      const lines = [errandLine(errand)];
      const { result } = errand;
      if (errand.state === 'done' && result) {
        lines.push(
          `result: ${result.text ? `${result.text.length} chars` : 'empty'}, ${result.sources?.length ?? 0} sources, ${result.files?.length ?? 0} files`
        );
      }
      if (errand.usage)
        lines.push(
          `usage: ${errand.usage.steps ?? 0} steps, ${(errand.usage.usd ?? 0).toFixed(3)} USD, ${Math.round(errand.usage.seconds ?? 0)} s`
        );
      return lines.join('\n');
    }
    if (
      ['state', 'since', 'until', 'limit'].some(
        (key) => args[key] !== undefined && args[key] !== null && args[key] !== ''
      )
    )
      return listErrands(args, context, store);
    // The open errands, then the finished ones she has not read (their result is still waiting).
    const listed = [...store.open(), ...store.unread()].filter((errand) => mayView(errand, context));
    return listed.length > 0
      ? listed
          .map((errand) => (isOpenState(errand.state) ? errandLine(errand) : `${errandLine(errand)} (unread)`))
          .join('\n')
      : 'no open errands';
  }

  /** Every errand the store holds that the caller may view and the filters of `args` keep, newest first. */
  function listErrands(args: Obj, context: OpContext, store: { recent(n: number): Array<ErrandRecord> }) {
    const state = textOf(args.state).trim();
    if (state && !(ERRAND_STATES as ReadonlyArray<string>).includes(state))
      throw invalid(`state must be one of: ${ERRAND_STATES.join(', ')}`);
    const since = windowBound(args.since, 'since');
    const until = windowBound(args.until, 'until');
    const asked = args.limit;
    const limit = asked === undefined || asked === null || asked === '' ? ERRAND_LIST_COUNT : Number(asked);
    if (!Number.isInteger(limit) || limit < 1 || limit > ERRAND_LIST_MAX)
      throw invalid(`limit must be 1..${ERRAND_LIST_MAX}`);
    const kept = store
      .recent(Number.MAX_SAFE_INTEGER)
      .filter(
        (errand) =>
          mayView(errand, context) &&
          (!state || errand.state === state) &&
          (since === null || (errand.createdAt ?? 0) >= since) &&
          (until === null || (errand.createdAt ?? 0) <= until)
      )
      .slice(0, limit);
    return kept.length > 0 ? kept.map((errand) => errandLine(errand)).join('\n') : 'no errands match';
  }

  /** A finished errand of the caller's view, or an `invalid` error: not found, not viewable, still open. */
  function finishedErrand(args: Obj, context: OpContext) {
    const store = errands().store();
    if (!store) throw Object.assign(new Error('no place'), { code: CODE.PLACE_REQUIRED });
    const id = textOf(args.id).trim();
    if (!id) throw invalid('an id is required');
    const errand = store.get(id);
    if (!errand || !mayView(errand, context)) throw invalid(`no errand ${id}`, CODE.NOT_FOUND);
    if (isOpenState(errand.state)) throw invalid(`errand ${id} is still ${errand.state}`);
    return { store, errand };
  }

  /** `errand.read id [from]`: a finished errand's result in a page of `errands.resultMaxChars` characters. */
  function cmdRead(args: Obj, context: OpContext) {
    const { store, errand } = finishedErrand(args, context);
    const configured = hot.config?.errands?.resultMaxChars;
    const page = Number.isInteger(configured) && configured > 0 ? configured : DEFAULT_RESULT_MAX_CHARS;
    const text = typeof errand.result?.text === 'string' ? errand.result.text : '';
    const from = args.from === undefined || args.from === null || args.from === '' ? 0 : Number(args.from);
    if (!Number.isInteger(from) || from < 0 || (from > 0 && from >= text.length))
      throw invalid(`from must be between 0 and ${Math.max(0, text.length - 1)}`);
    const to = Math.min(text.length, from + page);
    const lines = [errandLine(errand)];
    if (from === 0) {
      if (errand.error && errand.state !== 'done') lines.push(`error: ${errand.error}`);
      const listedSources = errand.result?.sources;
      const sources = Array.isArray(listedSources)
        ? listedSources.filter((url) => typeof url === 'string' && url !== '')
        : [];
      for (const [i, url] of sources.entries()) lines.push(`source ${i + 1}: ${url}`);
      const listedFiles = errand.result?.files;
      for (const file of Array.isArray(listedFiles) ? listedFiles : []) {
        if (!file || typeof file.name !== 'string') continue;
        const meta = `${file.contentType || '-'}, ${Number(file.bytes) || 0} bytes`;
        lines.push(
          errand.filesExpired === true
            ? `file: ${file.name} (${meta}) expired, no handle`
            : `file: ${fileHandle(errand.id, file.name)} (${meta})`
        );
      }
    }
    lines.push(text ? `result: characters ${from}-${to} of ${text.length}` : 'result: empty');
    if (text) lines.push(text.slice(from, to));
    const more = to < text.length;
    if (more) lines.push(`next: from=${to}`);
    // Read when the last page is in her hands.
    else store.markRead(errand.id);
    return lines.join('\n');
  }

  /** `errand.resolve id`: a finished errand closed, its result dealt with. */
  function cmdResolve(args: Obj, context: OpContext) {
    const { store, errand } = finishedErrand(args, context);
    store.resolve(errand.id);
    store.markRead(errand.id);
    return `errand ${errand.id}: resolved`;
  }

  /** `errand.cancel id`: for the requester of the errand or an owner. */
  function cmdCancel(args: Obj, context: OpContext) {
    const id = textOf(args.id).trim();
    if (!id) throw invalid('an id is required');
    const service = errands();
    const store = service.store();
    const errand = store?.get(id) ?? null;
    if (!errand || !mayView(errand, context)) throw invalid(`no errand ${id}`, CODE.NOT_FOUND);
    const own = Boolean(context?.accountId) && idText(context.accountId) === errand.requester?.accountId;
    const hers = context?.actor === 'persona' && errand.requester?.kind === 'persona';
    if (!ownerCalls(context) && !own && !hers)
      throw denied('only the requester of the errand or an owner may cancel it', CODE.NOT_REQUESTER);
    // Who cancelled it, as the service is told.
    const by = context?.actor === 'persona' ? 'persona' : ownerCalls(context) ? 'owner' : 'requester';
    const cancelled = service.cancel({ id, by });
    if (!cancelled.ok)
      return {
        status: 'failed',
        code: cancelled.code,
        summary: `errand ${id}: ${cancelled.code === CODE.NOT_OPEN ? `already ${errand.state}` : cancelled.code}`,
        data: null,
      };
    return `errand ${id}: cancelled`;
  }

  return { cmdRun, cmdStatus, cmdCancel, cmdRead, cmdResolve };
});

defineOp({
  name: 'errand.run',
  rights: { kind: 'write', member: true },
  run: (args, ctx) => handlers(ctx.env).cmdRun(args, ctx),
});
defineOp({
  name: 'errand.list',
  rights: { kind: 'read', member: true },
  run: (args, ctx) => handlers(ctx.env).cmdStatus(args, ctx),
});
defineOp({
  name: 'errand.cancel',
  rights: { kind: 'write', member: true },
  run: (args, ctx) => handlers(ctx.env).cmdCancel(args, ctx),
});
defineOp({
  name: 'errand.read',
  rights: { kind: 'read', member: true },
  run: (args, ctx) => handlers(ctx.env).cmdRead(args, ctx),
});
defineOp({
  name: 'errand.resolve',
  rights: { kind: 'write', member: true },
  run: (args, ctx) => handlers(ctx.env).cmdResolve(args, ctx),
});
