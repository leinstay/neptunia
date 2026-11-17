// The direct chat of a person she names in `message.create` or `intention.set` (`person`, an `@handle` or a name, as
// `conversation.read` takes it, src/memory/db/direct-chats.ts). The person must be one memory knows, as the
// heartbeat's `<people>` list knows them (src/memory/db/known-people.ts), and pass the gate a direct message of theirs
// passes (src/behavior/private.ts#privateGate: `dm.enabled`, a stored profile and her attitude against
// `private.minAffinity`). Their newest stored direct chat is the place. A person with none has it opened through the
// interface's `dm.chat` read, account by account, and the answer is stored through the one writer as the place a first
// direct message of theirs makes (src/memory/db/observe.ts#applyPlaceAddress). Nothing is stored before the interface
// opened the chat. The posting checks then treat the place as any other (src/tools/operations/shared.ts).

import { privateGate } from '../../behavior/private.ts';
import { CLI_IFACE, dmChatsOff } from '../../behavior/core-pause.ts';
import { accountOf } from '../../memory/addresses.ts';
import { withIface } from '../../memory/db/current-iface.ts';
import { directChatsOf } from '../../memory/db/direct-chats.ts';
import { knownPersonIds, knownPersonOf } from '../../memory/db/known-people.ts';
import { internalContext } from '../../memory/db/scope.ts';
import type { MemoryDbService } from '../../memory/db/service.ts';
import { log } from '../../log.ts';
import { CODE } from '../codes.ts';
import { objOf } from '../types.ts';
import { isOwnerId } from './grants.ts';
import { denied, invalid } from './registry.ts';
import type { Env } from './env.ts';

/** The profile the reply gate reads for an account: the store's public profile of it. */
type ProfileStore = { getUser?: (accountId: string) => Record<string, unknown> | null };

/**
 * The place id of the direct chat with the person `reference` names, opened and stored when none is. Throws the
 * refusal: `unknown-member` for nobody memory knows, `dm-disabled`, `no-dm-account` with no account but the command
 * line, `attitude-low` for a person the reply gate refuses, `dm-unopened` when no interface opened the chat.
 */
export async function personPlace(env: Env, reference: string): Promise<string> {
  const memoryDb = env.memoryDb as MemoryDbService | null | undefined;
  const db = memoryDb?.database() ?? null;
  if (!memoryDb || db === null) throw Object.assign(new Error('memory is closed'), { code: CODE.MEMORY_CLOSED });
  const found = directChatsOf(db, internalContext(), reference);
  const person = found.kind === 'chats' ? knownPersonOf(db, found.personId) : null;
  if (found.kind !== 'chats' || person === null || !knownPersonIds(db).includes(found.personId))
    throw invalid(`no known person ${reference}`, CODE.UNKNOWN_MEMBER);
  const config: unknown = objOf(env.hot).config;
  const accounts = person.accounts.filter((one) => one.iface !== CLI_IFACE);
  if (dmChatsOff(config, { iface: accounts[0]?.iface ?? '' }))
    throw denied('direct chats are closed', CODE.DM_DISABLED);
  if (accounts.length === 0) throw invalid('no account to write to directly', CODE.NO_DM_ACCOUNT);
  const store = env.store as ProfileStore | null | undefined;
  const gates = accounts.map((one) =>
    withIface(one.iface, () =>
      privateGate({
        config: objOf(config),
        isMember: true,
        profile: store?.getUser?.(accountOf(store, one.platformId, one.iface)) ?? null,
        isOwner: isOwnerId(config, one.platformId),
      })
    )
  );
  if (!gates.some((gate) => gate.ok)) throw denied('the reply gate refuses this person', CODE.ATTITUDE_LOW);
  const [stored] = found.places;
  if (stored !== undefined) return stored;
  for (const one of accounts) {
    const opened = await env.reads?.answer('dmChatOf', { iface: one.iface, accountId: one.platformId });
    if (opened?.status !== 'ok') {
      log.info('person chat: not opened', { iface: one.iface, code: opened?.code ?? null });
      continue;
    }
    const written = objOf(
      await memoryDb.memoryWrite({
        kind: 'place-address',
        iface: one.iface,
        partner: one.platformId,
        address: opened.chatId,
        at: new Date().toISOString(),
      })
    );
    if (typeof written.placeId === 'string') return written.placeId;
  }
  throw Object.assign(new Error('no interface opened the direct chat'), { code: CODE.DM_UNOPENED });
}
