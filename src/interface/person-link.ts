// Her tool `person.link` (plan 2026-11-08-meta-person, "Linking accounts by her own tool"), after Hermes's pairing. In
// a conversation with account A she names the meta-person she believes the person is. `start` sends a one-time phrase
// of six words (`labels.link.code`, naming A's handle and interface) in a direct message to an account of that
// meta-person, B, on any interface that reaches one, and answers her with the rule of the next message
// (`labels.tools.tools.link.sent`), never with the phrase. The door hands every new line to `screen` first: the next
// message of A in that conversation ends the attempt. A message that holds the six words in any order and any form
// (src/interface/phrase-codes.ts) is dropped before memory or a turn sees it, its message id is withheld from every chat a turn reads, and the bind
// of `/memory bind` runs (src/memory/db/person-bind.ts, `by` `code`): B's meta-person wins, A's merges into it, and the
// private layers join. Any other message is passed on and counted as a failure.
//
// Hermes's limits (gateway/pairing.py): a code lives an hour, an account asks once per ten minutes, five failures lock
// it for an hour. The owner's meta-person is never touched, neither as B nor as A's. A closed direct chat, or no
// interface that reaches B, is refused and nothing waits. The waiting seals, the limits and the withheld message ids
// are written to the state file, so a restart neither drops a waiting phrase nor reopens an ended attempt. Logs carry
// interfaces and outcomes, never the phrase. Built by src/core.ts; the limits and the file are src/interface/pairing.ts.

import { log } from '../log.ts';
import { peopleOfHandle } from '../memory/db/direct-chats.ts';
import { survivorOf } from '../memory/db/ids.ts';
import { personOfAccount } from '../memory/db/meta-person.ts';
import type { BindConfirm, BindInput, BindResult } from '../memory/db/person-bind.ts';
import { accountNodeOf } from '../memory/db/person-links.ts';
import type { Db } from '../memory/db/types.ts';
import type { Adapter, MessageEvent } from '../protocol/adapter.ts';
import { nativeAuthorityOf } from '../protocol/identity.ts';
import { CODE } from '../tools/codes.ts';
import { ownerPersonOf } from '../tools/operations/grants.ts';
import { fillLabel, hasCodeLine } from './owner-pairing.ts';
import type { OwnerPairing } from './owner-pairing.ts';
import { CODE_TTL_MS, LOCK_MS, MAX_FAILURES, REQUEST_EVERY_MS, codesFileOf, createCodeFile } from './pairing.ts';
import { phraseCodesOf } from './phrase-codes.ts';
import type { PhraseCodes, Seal } from './phrase-codes.ts';

/** The interface of the owner's command line, which reaches nobody else. */
const CONSOLE_IFACE = 'cli';
/** How many withheld message ids the process keeps, the oldest going first. */
const WITHHELD_KEPT = 1000;

export type PersonLinksDeps = {
  /** The live config, prompts and layers: `bot.ownerPerson`, `bot.mnemonic` and the link labels, read at each use. */
  hot: {
    readonly config: unknown;
    readonly prompts?: unknown;
    readonly rootDir?: string;
    readonly privateDir?: string;
  };
  memoryDb: {
    database(): Db | null;
    personBind(input: BindInput, confirm: BindConfirm | null): Promise<BindResult>;
  } | null;
  port: Pick<Adapter, 'send' | 'dmChatOf'>;
  now?: () => number;
  /** The phrases; the list `bot.mnemonic` picks and the memory's stemmer when absent. */
  phrases?: PhraseCodes;
  /** Where the waiting seals, the limits and the withheld message ids survive a restart: `link-codes.json` of the data directory. */
  file?: string | null;
};

/** What she asked: the account she talks with (its interface, platform id and conversation) and the meta-person. */
export type LinkAsk = { iface: string; native: string; chatId: string; person: string };

/** The tool's answer: a status, a result code on a refusal, and the text she reads on success. */
export type LinkStart = {
  status: 'ok' | 'denied' | 'invalid' | 'failed';
  code?: string;
  data?: { text: string };
};

export type PersonLinks = {
  start(ask: LinkAsk): Promise<LinkStart>;
  /** What the door does with a new line: drop the right code of the account that asked, or pass it on. */
  screen(event: MessageEvent): Promise<'pass' | 'drop'>;
  isCodeLine(content: unknown): boolean;
  /** True for a message that carried a phrase, kept out of every chat a turn reads. */
  isWithheld(iface: string, chatId: string, messageId: string): boolean;
};

type Waiting = { chatId: string; accountId: string; person: string; seal: Seal; at: number };
type Limits = { askedAt: number; failures: number; lockedUntil: number };
type LinkState = { waiting: Record<string, Waiting>; limits: Record<string, Limits>; withheld: Array<string> };

const emptyState = (): LinkState => ({ waiting: {}, limits: {}, withheld: [] });

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** The label at `path` of the live prompts' labels, '' when missing. */
function labelAt(prompts: unknown, path: ReadonlyArray<string>): string {
  let node: unknown = isRecord(prompts) ? prompts.labels : null;
  for (const key of path) node = isRecord(node) ? node[key] : null;
  return typeof node === 'string' ? node : '';
}

/** Whether `person` is a meta-person that stands: marked `meta`, not merged away, not retired. */
function isStandingMeta(db: Db, person: string): boolean {
  const row = db.prepare('SELECT meta, status, retired_at FROM people WHERE id = ?').get(person);
  if (row === undefined) return false;
  const merged = typeof row.status === 'string' && row.status.startsWith('merged_into:');
  return row.meta === 1 && !merged && row.retired_at == null;
}

/** The accounts of `person` a direct message may reach, the asking account and the command line left out. */
function reachableAccounts(db: Db, person: string, except: string): Array<{ iface: string; native: string }> {
  return db
    .prepare(
      `SELECT iface, platform_id FROM person_accounts WHERE person_id = ? AND id <> ? AND iface <> ?
       ORDER BY recorded_at DESC, id`
    )
    .all(person, except, CONSOLE_IFACE)
    .map((row) => ({ iface: String(row.iface), native: String(row.platform_id) }));
}

const keyOf = (iface: string, native: string): string => JSON.stringify([iface, native]);

/** How the message names account A: its handle, else its display name, else its platform id. */
function handleOfAccount(db: Db, accountId: string, native: string): string {
  const row = db.prepare('SELECT handle, display_name FROM person_accounts WHERE id = ?').get(accountId);
  for (const value of [row?.handle, row?.display_name]) if (typeof value === 'string' && value !== '') return value;
  return native;
}

/** The person she named: the id of a stored person as she reads it, or the member handle of exactly one person's account. */
function personNamed(db: Db, reference: string): string | null {
  const given = reference.trim().replace(/^@/, '');
  if (db.prepare('SELECT 1 FROM people WHERE id = ?').get(given)) return given;
  const people = [...peopleOfHandle(db, given)];
  return people.length === 1 ? (people[0] ?? null) : null;
}

export function createPersonLinks({
  hot,
  memoryDb,
  port,
  now = Date.now,
  phrases = phraseCodesOf(hot, () => memoryDb?.database() ?? null),
  file = codesFileOf(hot, 'link-codes.json'),
}: PersonLinksDeps): PersonLinks {
  const store = createCodeFile(file, emptyState);
  const state = store.load();
  const save = (): void => store.save(state);

  function limitsOf(key: string): Limits {
    // The ten-minute limit starts at the first ask; a past far enough away stands for never.
    const found = state.limits[key] ?? { askedAt: -REQUEST_EVERY_MS - 1, failures: 0, lockedUntil: 0 };
    state.limits[key] = found;
    return found;
  }

  function withhold(event: MessageEvent): void {
    state.withheld = [...state.withheld, JSON.stringify([event.iface, event.chat.id, event.message.id])].slice(
      -WITHHELD_KEPT
    );
  }

  /** Sends the phrase to the first account of `person` an interface reaches; whether one took it. */
  async function sendCode(db: Db, person: string, accountId: string, text: string): Promise<boolean> {
    for (const target of reachableAccounts(db, person, accountId)) {
      try {
        const chat = await port.dmChatOf({ iface: target.iface, accountId: target.native });
        if (chat.status !== 'ok') continue;
        const delivery = await port.send(
          { iface: target.iface, chatId: chat.chatId },
          { text, mentions: { users: [], repliedUser: false } }
        );
        if (delivery.status === 'ok') return true;
      } catch {
        // An interface that threw reaches nobody now; the next account is tried.
      }
    }
    return false;
  }

  async function start(ask: LinkAsk): Promise<LinkStart> {
    const db = memoryDb?.database() ?? null;
    if (db === null) return { status: 'failed', code: CODE.MEMORY_CLOSED };
    const accountId = accountNodeOf(db, {
      interfaceId: ask.iface,
      authorityId: nativeAuthorityOf(ask.iface),
      nativeId: ask.native,
      generation: 1,
    });
    if (accountId === null) return { status: 'invalid', code: CODE.UNKNOWN_MEMBER };
    const named = personNamed(db, ask.person);
    const target = named === null ? '' : survivorOf(db, named);
    if (named === null || !isStandingMeta(db, target)) return { status: 'invalid', code: CODE.PERSON_NOT_FOUND };
    const owner = ownerPersonOf(hot.config);
    const current = personOfAccount(db, accountId);
    const ownerSurvivor = owner === null ? null : survivorOf(db, owner);
    if (
      ownerSurvivor !== null &&
      (target === ownerSurvivor || current === ownerSurvivor || ask.iface === CONSOLE_IFACE)
    ) {
      log.info('link: refused', { iface: ask.iface, reason: 'owner' });
      return { status: 'denied', code: CODE.FORBIDDEN };
    }
    if (current === target)
      return { status: 'ok', data: { text: labelAt(hot.prompts, ['tools', 'tools', 'link', 'already']) } };
    const key = keyOf(ask.iface, ask.native);
    const limit = limitsOf(key);
    if (limit.lockedUntil > now() || now() - limit.askedAt <= REQUEST_EVERY_MS) {
      log.info('link: refused', { iface: ask.iface, reason: 'cooldown' });
      return { status: 'denied', code: CODE.COOLDOWN };
    }
    limit.askedAt = now();
    save();
    const template = labelAt(hot.prompts, ['link', 'code']);
    const issued = template === '' ? null : phrases.issue();
    const text =
      issued === null
        ? ''
        : fillLabel(template, {
            handle: handleOfAccount(db, accountId, ask.native),
            iface: ask.iface,
            phrase: issued.phrase,
          });
    if (issued === null || !(await sendCode(db, target, accountId, text))) {
      log.info('link: not sent', { iface: ask.iface, phrase: issued !== null });
      return { status: 'failed', code: CODE.CHAT_CLOSED };
    }
    state.waiting[key] = { chatId: ask.chatId, accountId, person: target, seal: issued.seal, at: now() };
    save();
    log.info('link: code sent', { iface: ask.iface });
    return { status: 'ok', data: { text: labelAt(hot.prompts, ['tools', 'tools', 'link', 'sent']) } };
  }

  async function screen(event: MessageEvent): Promise<'pass' | 'drop'> {
    const author = event.message.author;
    if (author === undefined || author.self === true || author.bot) return 'pass';
    const key = keyOf(event.iface, String(author.id));
    const asked = state.waiting[key];
    if (asked === undefined || asked.chatId !== event.chat.id) return 'pass';
    delete state.waiting[key];
    const isRight = now() - asked.at <= CODE_TTL_MS && phrases.holds(asked.seal, event.message.content);
    if (!isRight) {
      const limit = limitsOf(key);
      limit.failures += 1;
      if (limit.failures >= MAX_FAILURES) {
        limit.lockedUntil = now() + LOCK_MS;
        limit.failures = 0;
      }
      save();
      log.info('link: wrong answer', { iface: event.iface, locked: limit.lockedUntil > now() });
      return 'pass';
    }
    withhold(event);
    save();
    const result =
      memoryDb === null
        ? { status: 'failed' as const }
        : await memoryDb.personBind(
            { accountId: asked.accountId, personId: asked.person, by: 'code' },
            // The phrase is the person's proof, so the merge needs no second question.
            () => Promise.resolve(true)
          );
    log.info('link: answered', {
      iface: event.iface,
      status: result.status,
      code: (result as { code?: string }).code ?? null,
    });
    return 'drop';
  }

  return {
    start,
    screen,
    isCodeLine: (content) => hasCodeLine(hot.prompts, content),
    isWithheld: (iface, chatId, messageId) => state.withheld.includes(JSON.stringify([iface, chatId, messageId])),
  };
}

/** The door's one screen: her link codes first, then the owner's pairing. */
export function joinScreens(
  links: PersonLinks,
  pairing: Pick<OwnerPairing, 'screen' | 'isCodeLine'>
): { screen(event: MessageEvent): Promise<'pass' | 'observe' | 'drop'>; isCodeLine(content: unknown): boolean } {
  return {
    screen: async (event) => {
      const linked = await links.screen(event);
      return linked === 'pass' ? pairing.screen(event) : linked;
    },
    isCodeLine: (content) => links.isCodeLine(content) || pairing.isCodeLine(content),
  };
}
