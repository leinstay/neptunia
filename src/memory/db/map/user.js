// Mapper: a member's public profile `users/<id>.json` <-> rows.
//
//   people          the member (first/last seen, message count, real name, the affinity score, reason and decay stamp)
//   accounts        the Discord account (id, display names, avatar)
//   memberships     the guild membership, only when the file has `addressedAs`
//   claims          details, interests, aliases (current) and closed items (truth historical)
//   descriptions    character, style, relationship with their text as one legacy version
//   episodes        the profile's episodes (kind profile)
//   affinity_events the affinity history
//
// Every other field (counters, portrait stamps, detailsSeq, `updatedAt`, ...) is in `people.extra`.
//
// toRows(rel, value, ctx) -> { people, accounts, ... }       ctx: { guildId? }
// fromRows(rows, ctx) -> the file's value

import { IFACE, accountId, guildPlaceId, personId } from '../ids.js';
import { groupScope } from '../scope.js';
import { AFFINITY_SPEC, affinityFrom, profileFrom, profileRows } from './lists.js';
import { extraText, isPlainObject, join, parseExtra, put, rowsOf, split } from './common.js';

const PEOPLE_SPEC = [
  { col: 'first_seen_at', key: 'firstSeen', type: 'text' },
  { col: 'last_seen_at', key: 'lastSeen', type: 'text' },
  { col: 'message_count', key: 'messageCount', type: 'num' },
  { col: 'real_name', key: 'realName', type: 'json' },
];
const ACCOUNT_SPEC = [
  { col: 'native_id', key: 'id', type: 'text' },
  { col: 'names', key: 'names', type: 'json' },
  { col: 'avatar', key: 'avatar', type: 'json' },
];
const MEMBERSHIP_SPEC = [{ col: 'addressed_as', key: 'addressedAs', type: 'json' }];

const FIELDS = ['character', 'style', 'relationship'];

/** The member id in `users/<id>.json`. */
export const userIdOf = (rel) => /([^/]+)\.json$/.exec(String(rel))?.[1] ?? String(rel);

export function toRows(rel, value, ctx = {}) {
  const userId = userIdOf(rel);
  const person = personId(userId);
  const scope = groupScope();
  const rows = {};
  const { rest, affinity } = profileRows(rows, value, { rel, person, owner: person, tag: '', scope, descFields: FIELDS });
  const people = split(rest, PEOPLE_SPEC);
  const account = split(people.rest, ACCOUNT_SPEC);
  const left = account.rest;
  let affinityCols = { affinity: null, affinity_reason: null, affinity_decayed_at: null };
  if (affinity) {
    const part = split(affinity, AFFINITY_SPEC);
    affinityCols = part.cols;
    if (Object.keys(part.rest).length) left.affinity = part.rest;
  }
  let membership = null;
  if (Object.hasOwn(left, 'addressedAs')) {
    membership = split({ addressedAs: left.addressedAs }, MEMBERSHIP_SPEC);
    delete left.addressedAs;
  }
  put(rows, 'people', { id: person, kind: 'member', ...people.cols, ...affinityCols, extra: extraText(left), retired_at: null, owner_file: rel });
  put(rows, 'accounts', {
    id: accountId(userId), iface: IFACE, ...account.cols, person_id: person, link: 'verified', linked_by: null, linked_at: null,
    extra: null, owner_file: rel,
  });
  if (membership) {
    put(rows, 'memberships', {
      id: `mem:${accountId(userId)}:${ctx.guildId ?? 'unknown'}`,
      account_id: accountId(userId),
      place_id: guildPlaceId(ctx.guildId ?? 'unknown'),
      nick: null, roles: null, pings_off: null,
      ...membership.cols,
      extra: extraText(membership.rest),
      valid_from_at: null, valid_to_at: null, owner_file: rel,
    });
  }
  return rows;
}

export function fromRows(rows) {
  const personRow = rows.people[0];
  const rest = parseExtra(personRow.extra);
  const has = Array.isArray(rest.$has) ? rest.$has : [];
  delete rest.$has;
  const affinityLeft = has.includes('affinity') && isPlainObject(rest.affinity) ? rest.affinity : {};
  if (has.includes('affinity')) delete rest.affinity;
  const obj = join(personRow, rest, PEOPLE_SPEC);
  const accountRow = rowsOf(rows, 'accounts')[0];
  Object.assign(obj, join(accountRow, accountRow.extra, ACCOUNT_SPEC));
  const membership = rowsOf(rows, 'memberships')[0];
  if (membership) Object.assign(obj, join(membership, membership.extra, MEMBERSHIP_SPEC));
  Object.assign(obj, profileFrom(rows, has));
  if (has.includes('affinity')) obj.affinity = affinityFrom(rows, personRow, affinityLeft, has);
  return obj;
}
