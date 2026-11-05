// Mapper: a member's public profile `users/<id>.json` <-> rows.
//
//   people          the member (first/last seen, message count, real name, the affinity score, reason, decay stamp;
//                   `affinity.moveId`, her session's last move the profile was read with, stays in `extra`)
//   accounts        the platform account (id, display names, avatar)
//   memberships     the guild membership, only when the file has `addressedAs`
//   claims          details, interests, aliases (current) and closed items (truth historical)
//   descriptions    character, style, relationship with their text as one legacy version
//   episodes        the profile's episodes (kind profile)
//   affinity_events the affinity history
//
// Every other field (counters, portrait stamps, detailsSeq, `updatedAt`, ...) is in `people.extra`.
//
// An account linked to a person whose profile another unit holds (`ctx.accountOnly`, person-links.ts#linkedProfileUnit)
// writes only `accounts` and `memberships`: its names, avatar and address. Its `people` row, when it has one from before
// the link, stays dormant under its own id until an unlink. A linked account's row keeps the link the database holds.
//
// toRows(rel, value, ctx) -> { people, accounts, ... }       ctx: { guildId? }
// fromRows(rows, ctx) -> the file's value

import { accountId, guildPlaceId, personId } from '../ids.ts';
import { groupScope } from '../scope.ts';
import { AFFINITY_SPEC, affinityFrom, profileFrom, profileRows } from './lists.ts';
import { extraText, ifaceOf, isPlainObject, join, parseExtra, put, rowsOf, split } from './common.ts';
import type { Row, Rows } from '../types.ts';
import type { MapContext, Spec } from './common.ts';

const PEOPLE_SPEC: Array<Spec> = [
  { col: 'first_seen_at', key: 'firstSeen', type: 'text' },
  { col: 'last_seen_at', key: 'lastSeen', type: 'text' },
  { col: 'message_count', key: 'messageCount', type: 'num' },
  { col: 'real_name', key: 'realName', type: 'json' },
];
const ACCOUNT_SPEC: Array<Spec> = [
  { col: 'native_id', key: 'id', type: 'text' },
  { col: 'names', key: 'names', type: 'json' },
  { col: 'avatar', key: 'avatar', type: 'json' },
];
const MEMBERSHIP_SPEC: Array<Spec> = [{ col: 'addressed_as', key: 'addressedAs', type: 'json' }];

const FIELDS = ['character', 'style', 'relationship'];

/** The member id in `users/<id>.json`. */
export const userIdOf = (rel: string): string => /([^/]+)\.json$/.exec(String(rel))?.[1] ?? String(rel);

const accountLinkOf = (ctx: MapContext, person: string): Row =>
  ctx.accountLink ?? { person_id: person, link: 'verified', linked_by: null, linked_at: null };

/** The rows of what belongs to the account itself; returns the fields of `value` that are not. */
function putAccount(
  rows: Rows,
  rel: string,
  value: Row,
  { iface, userId, guildId, link }: { iface: string; userId: string; guildId: string | undefined; link: Row }
): Row {
  const account = split(value, ACCOUNT_SPEC);
  const left = account.rest;
  put(rows, 'accounts', {
    id: accountId(iface, userId),
    iface,
    ...account.cols,
    ...link,
    extra: null,
    owner_file: rel,
  });
  if (Object.hasOwn(left, 'addressedAs')) {
    const membership = split({ addressedAs: left.addressedAs }, MEMBERSHIP_SPEC);
    delete left.addressedAs;
    put(rows, 'memberships', {
      id: `mem:${accountId(iface, userId)}:${guildId ?? 'unknown'}`,
      account_id: accountId(iface, userId),
      place_id: guildPlaceId(iface, guildId ?? 'unknown'),
      nick: null,
      roles: null,
      pings_off: null,
      ...membership.cols,
      extra: extraText(membership.rest),
      valid_from_at: null,
      valid_to_at: null,
      owner_file: rel,
    });
  }
  return left;
}

export function toRows(rel: string, value: Row, ctx: MapContext = {}): Rows {
  const iface = ifaceOf(ctx);
  const userId = ctx.subjectNativeId ?? userIdOf(rel);
  const person = ctx.subjectPersonId ?? personId(iface, userId);
  const scope = groupScope(iface);
  const rows: Rows = {};
  if (ctx.accountOnly) {
    putAccount(rows, rel, value, { iface, userId, guildId: ctx.guildId, link: accountLinkOf(ctx, person) });
    return rows;
  }
  const { rest, affinity } = profileRows(rows, value, {
    rel,
    person,
    owner: person,
    tag: '',
    scope,
    descFields: FIELDS,
  });
  const people = split(rest, PEOPLE_SPEC);
  const left = people.rest;
  let affinityCols: Row = { affinity: null, affinity_reason: null, affinity_decayed_at: null };
  if (affinity) {
    const part = split(affinity, AFFINITY_SPEC);
    affinityCols = part.cols;
    if (Object.keys(part.rest).length) left.affinity = part.rest;
  }
  const accountLeft = putAccount(rows, rel, left, {
    iface,
    userId,
    guildId: ctx.guildId,
    link: accountLinkOf(ctx, person),
  });
  put(rows, 'people', {
    id: person,
    kind: 'member',
    ...people.cols,
    ...affinityCols,
    extra: extraText(accountLeft),
    retired_at: null,
    owner_file: rel,
  });
  return rows;
}

/** `obj` with what belongs to the account itself. A unit that holds a person but lost its account row reads without. */
function accountFrom(rows: Rows, obj: Row): Row {
  const accountRow = rowsOf(rows, 'accounts')[0];
  if (accountRow) Object.assign(obj, join(accountRow, accountRow.extra, ACCOUNT_SPEC));
  const membership = rowsOf(rows, 'memberships')[0];
  if (membership) Object.assign(obj, join(membership, membership.extra, MEMBERSHIP_SPEC));
  return obj;
}

export function fromRows(rows: Rows): Row {
  const personRow = rows.people[0];
  if (personRow === undefined) return accountFrom(rows, {});
  const rest = parseExtra(personRow.extra);
  const has = Array.isArray(rest.$has) ? rest.$has : [];
  delete rest.$has;
  const affinityLeft = has.includes('affinity') && isPlainObject(rest.affinity) ? rest.affinity : {};
  if (has.includes('affinity')) delete rest.affinity;
  const obj = join(personRow, rest, PEOPLE_SPEC);
  accountFrom(rows, obj);
  Object.assign(obj, profileFrom(rows, has));
  if (has.includes('affinity')) obj.affinity = affinityFrom(rows, personRow, affinityLeft, has);
  return obj;
}
