// The owner's pairing of his account on an interface (plan 2026-11-08-meta-person, slice 8), after Hermes's pairing
// (gateway/pairing.py). The owner opens pairing on an interface (`open`: `/interfaces pair open <name>`, or the end of
// `/interfaces setup <name>`), writes to her there in a direct message, and the door hands that message to `screen`
// before any turn: it answers in the same chat with a one-time phrase of six words (`labels.pairing.code`) and the line
// is only observed. `approve` (`/interfaces pair <phrase>` in the command line) binds the account that asked to the owner's
// meta-person by the rules of `/memory bind` (src/memory/db/person-bind.ts), the approval standing for the owner's
// yes to a merge. The account he paired last on an interface is his account there, and the earlier ones stay his
// (person-links.ts#ownerAccountOf). The owner's own accounts, her lines, group places and the command line pass.
// `isCodeLine` tells her own line that carries a phrase, which the door keeps out of memory. The phrase itself is never
// logged: the log says only that one was sent. Built by src/core.ts; the limits and the state file are
// src/interface/pairing.ts, the phrases src/interface/phrase-codes.ts.

import { log } from '../log.ts';
import { withIface } from '../memory/db/current-iface.ts';
import type { BindConfirm, BindInput, BindResult } from '../memory/db/person-bind.ts';
import { accountNodeOf, ownerAccountOf } from '../memory/db/person-links.ts';
import type { Db } from '../memory/db/types.ts';
import type { Adapter, MessageEvent } from '../protocol/adapter.ts';
import { nativeAuthorityOf } from '../protocol/identity.ts';
import { isOwnerId, ownerPersonOf } from '../tools/operations/grants.ts';
import { codesFileOf, createPairing } from './pairing.ts';
import type { Pairing, PairingAccount } from './pairing.ts';
import { PHRASE_PATTERN, phraseCodesOf } from './phrase-codes.ts';

/** The interface of the owner's command line, where he is the owner from the first line and pairs nothing. */
const CONSOLE_IFACE = 'cli';

export type OwnerPairingDeps = {
  /** The live config, prompts and layers: `bot.ownerPerson`, `bot.mnemonic` and `labels.pairing`, read at each use. */
  hot: {
    readonly config: unknown;
    readonly prompts?: unknown;
    readonly rootDir?: string;
    readonly privateDir?: string;
  };
  /** The phrases and their limits; a fresh `createPairing` over `now` and `file` when absent. */
  pairing?: Pairing;
  /** Where the waiting phrases and the limits survive a restart: `pairing-codes.json` of the data directory. */
  file?: string | null;
  now?: () => number;
  /** The memory database service: its read connection and the bind of `/memory bind`. */
  memoryDb: {
    database(): Db | null;
    personBind(input: BindInput, confirm: BindConfirm | null): Promise<BindResult>;
  } | null;
  port: Pick<Adapter, 'send'>;
  selfId: () => string;
};

/** The owner's answer to a pairing command. */
export type PairAnswer = { text: string; status: 'ok' | 'invalid' | 'failed' };

export type OwnerPairing = {
  /** What the door does with a new line: pass it on, or only observe it once a code answered it here. */
  screen(event: MessageEvent): Promise<'pass' | 'observe'>;
  /** True for a line that carries a pairing phrase as `labels.pairing.code` words it. */
  isCodeLine(content: unknown): boolean;
  /** Opens pairing on `iface` for an hour; the owner's answer. */
  open(iface: string): string;
  /** Approves the phrase the owner typed: the account that asked for it becomes his. */
  approve(text: string): Promise<PairAnswer>;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** `labels.pairing.<key>` of the live prompts, '' when it is missing. */
function labelOf(prompts: unknown, key: string): string {
  const labels = isRecord(prompts) ? prompts.labels : null;
  const pairing = isRecord(labels) ? labels.pairing : null;
  const text = isRecord(pairing) ? pairing[key] : null;
  return typeof text === 'string' ? text : '';
}

const escaped = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The label `template` filled with `values`, every other placeholder left as written. */
export function fillLabel(template: string, values: Readonly<Record<string, string>>): string {
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => values[name] ?? whole);
}

/** True when `content` is `template` with a phrase in its `{phrase}` and anything in its other placeholders. */
export function isCodeText(template: string, content: unknown): boolean {
  if (typeof content !== 'string' || template === '' || !template.includes('{phrase}')) return false;
  const pattern = template
    .split(/(\{\w+\})/)
    .map((part, index) => {
      if (index % 2 === 0) return escaped(part);
      return part === '{phrase}' ? PHRASE_PATTERN : '.+?';
    })
    .join('');
  return new RegExp(`^${pattern}$`, 'su').test(content.trim());
}

/** True when `content` carries a one-time phrase as a code label words it: `labels.pairing.code` or `labels.link.code`. */
export function hasCodeLine(prompts: unknown, content: unknown): boolean {
  const labels = isRecord(prompts) ? prompts.labels : null;
  const link = isRecord(labels) ? labels.link : null;
  const linkCode = isRecord(link) && typeof link.code === 'string' ? link.code : '';
  return isCodeText(labelOf(prompts, 'code'), content) || isCodeText(linkCode, content);
}

/** A direct chat of one person, the only place an account asks for a code. */
const isDirect = (event: MessageEvent): boolean => event.chat.rootId === null && event.chat.chatType !== 'group_dm';

export function createOwnerPairing({
  hot,
  now = Date.now,
  file = codesFileOf(hot, 'pairing-codes.json'),
  memoryDb,
  pairing = createPairing({ now, file, phrases: phraseCodesOf(hot, () => memoryDb?.database() ?? null) }),
  port,
  selfId,
}: OwnerPairingDeps): OwnerPairing {
  /** Sends the phrase to the chat the request came from; whether the interface took it. */
  async function sendCode(event: MessageEvent, phrase: string): Promise<boolean> {
    const template = labelOf(hot.prompts, 'code');
    if (template === '') return false;
    // The words count in any order, so a first word that reads as `/interfaces pair open` moves to the end.
    const words = phrase.split(' ');
    const shown = words[0] === 'open' ? [...words.slice(1), 'open'] : words;
    try {
      const delivery = await port.send(
        { iface: event.iface, chatId: event.chat.id },
        { text: fillLabel(template, { phrase: shown.join(' ') }), mentions: { users: [], repliedUser: false } }
      );
      return delivery.status === 'ok';
    } catch {
      // A send that threw is a code that never arrived; the log below says so.
      return false;
    }
  }

  async function screen(event: MessageEvent): Promise<'pass' | 'observe'> {
    const author = event.message.author;
    if (event.iface === CONSOLE_IFACE || !isDirect(event) || author === undefined) return 'pass';
    if (author.self === true || author.id === selfId()) return 'pass';
    if (!pairing.isOpen(event.iface) || ownerPersonOf(hot.config) === null) return 'pass';
    if (withIface(event.iface, () => isOwnerId(hot.config, author.id))) return 'pass';
    const asked = pairing.request({ iface: event.iface, native: String(author.id) });
    if (asked.kind === 'code') {
      const sent = await sendCode(event, asked.phrase);
      log.info('pairing: code', { iface: event.iface, sent });
    } else {
      log.info('pairing: no code', { iface: event.iface, reason: asked.kind });
    }
    return 'observe';
  }

  /** Binds the paired account to the owner's meta-person; the owner's answer. */
  async function bind(owner: string, account: PairingAccount): Promise<PairAnswer> {
    const db = memoryDb?.database() ?? null;
    if (memoryDb === null || db === null) return { text: 'the memory is closed; nothing is bound', status: 'failed' };
    const named = `${account.iface} ${account.native}`;
    const accountId = accountNodeOf(db, {
      interfaceId: account.iface,
      authorityId: nativeAuthorityOf(account.iface),
      nativeId: account.native,
      generation: 1,
    });
    if (accountId === null) return { text: `${named}: she has not stored that account yet`, status: 'failed' };
    const earlier = ownerAccountOf(db, owner, account.iface);
    // The approval is the owner's word for this account, so a merge needs no second question.
    const result = await memoryDb.personBind({ accountId, personId: owner }, () => Promise.resolve(true));
    log.info('pairing: approved', { iface: account.iface, status: result.status });
    switch (result.status) {
      case 'attached':
      case 'bound':
      case 'merged': {
        const kept = earlier !== null && earlier !== account.native ? `; ${account.iface} ${earlier} stays yours` : '';
        return { text: `${named} is your account on ${account.iface} now${kept}`, status: 'ok' };
      }
      case 'refused':
      case 'failed':
        return { text: `${named} could not be bound: ${result.code}`, status: 'failed' };
      case 'declined':
      case 'unconfirmed':
        return { text: `${named} could not be bound`, status: 'failed' };
    }
  }

  return {
    screen,
    isCodeLine: (content) => hasCodeLine(hot.prompts, content),
    open(iface) {
      if (iface === CONSOLE_IFACE) return 'the command line is yours already; pair another interface';
      if (ownerPersonOf(hot.config) === null) return 'you have no meta-person yet: write one line in this chat first';
      pairing.open(iface);
      log.info('pairing: open', { iface });
      return `pairing is open on ${iface} for an hour: write to her there in a direct message, then type /interfaces pair <phrase> here`;
    },
    async approve(text) {
      const owner = ownerPersonOf(hot.config);
      if (owner === null)
        return { text: 'you have no meta-person yet: write one line in this chat first', status: 'invalid' };
      const verdict = pairing.approve(text);
      switch (verdict.kind) {
        case 'locked':
          log.info('pairing: locked', {});
          return { text: 'five wrong phrases: approvals are locked for an hour', status: 'invalid' };
        case 'wrong':
          log.info('pairing: wrong code', {});
          return { text: 'that phrase is wrong or expired', status: 'invalid' };
        case 'approved':
          return bind(owner, verdict.account);
      }
    },
  };
}
