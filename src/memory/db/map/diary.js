// Mapper: `diary.json` (`{ posts: [...], updatedAt }`, what she wrote in her diary and posted) <-> `diary` rows,
// `diary_mirrors` (the platform's message ids a post was sent as: one mirror row per post that has a `messageIds`
// array, the ids in `native_ids`) and `operational` (kind diary) for the rest of the file (`updatedAt`).
//
// A post's id is its `itemId` (a derived one, marked `$derived`, when it has none); `at` is at_ms, `picture` is
// picture_prompt, `search` the search column (null stays null through the `$null` list). `pictures` (a count) and
// anything else no column names stay in `extra`. A post that carries its `text` (an entry recorded before it is sent,
// src/behavior/diary-turn.ts) sets the `text` column; any other leaves `text` and `lost` alone (a re-map does too):
// src/memory/db/diary-media.js fills them for the older posts from the interface, with the pictures. The old JSON has
// no such fields, so the export leaves them out.
// The diary is public: scope group.
//
// toRows(rel, value, ctx) -> { diary, diary_mirrors, operational }     fromRows(rows, ctx) -> the file's value

import { itemOrDerivedId, uniqueIds } from '../ids.ts';
import { groupScope } from '../scope.ts';
import { extraText, ifaceOf, isPlainObject, join, ordered, parseExtra, put, rowsOf, split } from './common.js';

const SPEC = [
  { col: 'at_ms', key: 'at', type: 'num' },
  { col: 'kind', key: 'kind', type: 'text' },
  { col: 'gist', key: 'gist', type: 'text' },
  { col: 'picture_prompt', key: 'picture', type: 'text' },
  { col: 'search', key: 'search', type: 'text' },
];

const isIds = (value) => Array.isArray(value) && value.every((id) => typeof id === 'string');

export function toRows(rel, value, ctx = {}) {
  const iface = ifaceOf(ctx);
  const rows = {};
  const rest = { ...value };
  const has = [];
  if (Array.isArray(value.posts) && value.posts.every(isPlainObject)) {
    const uniq = uniqueIds();
    value.posts.forEach((post, position) => {
      const body = { ...post };
      const mirrored = isIds(post.messageIds);
      if (mirrored) delete body.messageIds;
      // The entry's text, when the post carries it (a post recorded before it is sent), is the row's.
      const given = /** @type {{ text?: unknown, itemId?: unknown }} */ (post);
      const text = typeof given.text === 'string' ? given.text : null;
      if (text !== null) delete body.text;
      const part = split(body, SPEC);
      const itemId = typeof given.itemId === 'string' && given.itemId ? given.itemId : null;
      const base = itemId ?? itemOrDerivedId(null, 'diary', '', post.at ?? '', post.gist ?? position);
      const id = uniq(base);
      if (itemId && id === base) delete part.rest.itemId;
      else part.rest.$derived = true;
      put(rows, 'diary', {
        id,
        ...part.cols,
        ...(text !== null ? { text } : {}),
        topic: null,
        world: null,
        status: null,
        perspective: null,
        ...groupScope(iface),
        extra: extraText(part.rest),
        owner_file: rel,
        position,
      });
      if (mirrored) {
        put(rows, 'diary_mirrors', {
          diary_id: id,
          iface,
          place_id: null,
          native_ids: JSON.stringify(post.messageIds),
          posted_at: null,
        });
      }
    });
    delete rest.posts;
    has.push('posts');
  }
  rest.$has = has;
  put(rows, 'operational', { kind: 'diary', owner: rel, value: JSON.stringify(rest), owner_file: rel });
  return rows;
}

export function fromRows(rows) {
  const rest = parseExtra(rowsOf(rows, 'operational')[0]?.value);
  const has = Array.isArray(rest.$has) ? rest.$has : [];
  delete rest.$has;
  const obj = { ...rest };
  if (has.includes('posts')) {
    const mirrors = new Map(rowsOf(rows, 'diary_mirrors').map((row) => [row.diary_id, row]));
    obj.posts = ordered(rows, 'diary').map((row) => {
      const extra = parseExtra(row.extra);
      const derived = extra.$derived === true;
      delete extra.$derived;
      const post = join(row, extra, SPEC);
      if (!derived) post.itemId = row.id;
      const mirror = mirrors.get(row.id);
      if (mirror) post.messageIds = JSON.parse(mirror.native_ids);
      return post;
    });
  }
  return obj;
}
