// The direct chat opened ahead: for an account of a person a memory session came across
// (src/memory/db/service.ts#onSessionAccounts), the core opens the direct chat with that account on its interface and
// stores it as the place a first direct message of the person makes, so she may write there through `place` like in
// any place. It opens nothing on the command line, for an account memory stores a live direct chat with, or unless
// the reply gate passes for the account (src/behavior/private.ts#privateGate: `dm.enabled`, the account's stored
// profile and `private.minAffinity`, the owner's bypass included). The chat comes from the interface's
// `dm.chat` read, sending nothing, and is stored through the one writer (observe.ts#applyPlaceAddress). An account the
// interface refused is kept in this function's closure and not asked again by this process. Built by src/core.ts.

import { privateGate } from '../behavior/private.ts';
import { CLI_IFACE } from '../behavior/core-pause.ts';
import { log } from '../log.ts';
import { accountOf } from '../memory/addresses.ts';
import { withIface } from '../memory/db/current-iface.ts';
import { dmOfPlatformId } from '../memory/db/meta-person.ts';
import type { Db } from '../memory/db/types.ts';
import { isOwnerId } from '../tools/operations/grants.ts';
import type { Reads } from './reads.ts';

export type DmAheadDeps = {
  /** The live config, read at each call: `dm.enabled`, `private.minAffinity` and the owner. */
  hot: { readonly config: unknown };
  /** The public profile of an account, as the reply gate reads it. */
  store: { getUser: (accountId: string) => object | null } | null;
  reads: Pick<Reads, 'answer'>;
  memoryDb: { database(): Db | null; memoryWrite(update: unknown): Promise<unknown> };
  now: () => number;
};

export type DmAhead = { open(iface: string, native: string): Promise<void> };

export function createDmAhead({ hot, store, reads, memoryDb, now }: DmAheadDeps): DmAhead {
  /** The accounts whose chat the interface refused, by interface and platform id. */
  const refused = new Set<string>();

  async function open(iface: string, native: string): Promise<void> {
    const config = hot.config;
    const key = JSON.stringify([iface, native]);
    if (iface === CLI_IFACE || refused.has(key)) return;
    const db = memoryDb.database();
    if (db === null || dmOfPlatformId(db, iface, native) !== null) return;
    const gate = withIface(iface, () =>
      privateGate({
        config: config as Record<string, unknown>,
        isMember: true,
        profile: (store?.getUser(accountOf(store, native, iface)) as Record<string, unknown> | null) ?? null,
        isOwner: isOwnerId(config, native),
      })
    );
    if (!gate.ok) return;
    const opened = await reads.answer('dmChatOf', { iface, accountId: native });
    if (opened.status !== 'ok') {
      refused.add(key);
      log.info('dm ahead: refused', { iface, code: opened.code });
      return;
    }
    await memoryDb.memoryWrite({
      kind: 'place-address',
      iface,
      partner: native,
      address: opened.chatId,
      at: new Date(now()).toISOString(),
    });
  }

  return { open };
}
