// The memory graph (spec 2026-10-24-memory-schema-v7, section 3; section 11 item 5 overrides it): a projection of the
// typed tables into `graph_nodes`, `graph_edges` and `node_access`, and the traversal over it. The typed tables are the
// only authority; everything here is derived and rebuildable (tools/memory-db.mjs rebuild). The rules are the
// manifest's (graph-manifest.js).
//
// Projection
//   projectRow(handle, table, row, { at })   the unit a written row belongs to (a claim for one of its versions or
//       links, a source for one of its relations, ...) projected again from the database as it is now: its nodes, its
//       edges with their semantic keys and its witnesses in `node_access`. Called by every writer of a projected table
//       inside the writer's own transaction (rows.js, sync.js, observe.js, session-write.js, diary-media.js), so a remap
//       re-projects. An edge the unit still produces is upserted (a retired row projects its edges retired at the row's
//       time); an edge it produced before and no longer does is retired at `at` and loses its witnesses. Deterministic:
//       every time it writes comes from the rows, except the retirement time of such a stale edge.
//   reproject(handle, { tables, sliceUnits, at })   every unit of the given unit tables (all by default), in slices of
//       `sliceUnits` units, one transaction each. Idempotent: twice gives the same rows.
//   projectPending(handle, { at })   the projection the v9 migration left pending (`meta.graph_pending`, its progress
//       kept there), in slices; the key goes once everything is projected. Run by a full sync pass and by the last
//       slice of the first import.
//   rebuildGraph(handle)   drops the three tables' rows and projects everything again (the rebuildability contract).
// Schema v10: a publication (publish.js) is its own unit: its node, `published_as` from the entry it publishes and
// `publication_source` to each stored line its receipts name; the diary unit no longer reads `diary_mirrors`.
// An edge whose end has no typed row yet gets a placeholder node (the epoch as its time); the row's own projection
// fills it in. A node with its own audience witnesses itself; every live edge witnesses both ends with its audience.
// A retired row's own edges retire with it and its own witness goes, but a live edge of another row that names it (a
// reply to a retired line) still reaches it: the node is known in that edge's audience, and a reader of its typed row
// sees that the row is retired.
//
// Traversal (a context is required, as for every memory read; scope.ts#audiencesOf gives its audiences)
//   walk(db, ctx, { from, predicates, direction, maxDepth, maxRows, after })   a recursive CTE over the live edges whose
//       audience the context may read, to nodes the context may see (a witness in `node_access`), the audience checked
//       inside the recursion, cycles cut by the path, breadth first in a fixed order (depth, node, path). Returns
//       `{ rows, truncated, reason: 'depth' | 'rows' | null, next }`: `rows` one per node reached (its first path),
//       `reason` `rows` when more paths than `maxRows` were found (then `next` is the `after` of the next page), `depth`
//       when a node at `maxDepth` has further edges. `graph.maxDepth` (6) and `graph.maxRows` (2000) from the config are
//       the defaults.
//   saidBy, inPlace, repliesTo, continuationsOf: the four questions the spec names (see each).
// Logs: none; a caller logs codes.

import { createHash } from 'node:crypto';
import { log as engineLog } from '../../log.js';
import { canonicalKey } from './ids.ts';
import { AUD_INTERNAL, audienceParts, audiencesOf, dmAudienceId, groupAudienceId } from './scope.ts';
import { NODE_KINDS, RELATION_EDGES, UNIT_OF, UNIT_ORDER } from './graph-manifest.js';

export const EPOCH = '1970-01-01T00:00:00.000Z';
const SELF = 'person:self';
const CONTAINERS = new Set(['guild', 'server', 'workspace', 'category']);
const DEFAULTS = Object.freeze({ maxDepth: 6, maxRows: 2000 });
const PENDING_KEY = 'graph_pending';
const SLICE_UNITS = 2000;

const quote = (name) => `"${String(name).replace(/"/g, '""')}"`;
const filled = (value) => typeof value === 'string' && value !== '';
const dbOf = (handle) => handle?.db ?? handle;
const stamp = (at) => (filled(at) ? at : new Date().toISOString());

/** The node id of a typed row: `<kind>:<row id>` (never parsed: the row id is kept in `graph_nodes.row_id`). */
export const graphNodeId = (kind, rowId) => `${kind}:${rowId}`;
/** The semantic key of an edge: `<predicate>:<src>:<dst>[:<evidence>]`. */
export const projectionKey = (predicate, src, dst, evidence = null) =>
  [predicate, src, dst, ...(filled(evidence) ? [evidence] : [])].join(':');
/** The id of an edge: 32 hex digits of SHA-256 over the edge's tuple (unambiguous, whatever the ids hold). */
const edgeIdOf = (predicate, src, dst, evidence) =>
  `edge:${createHash('sha256')
    .update(canonicalKey(predicate, [src, dst, filled(evidence) ? evidence : null]))
    .digest('hex')
    .slice(0, 32)}`;

/** The graph settings of this moment (`graph` in the live config). */
export function graphSettings(config) {
  const given = config?.graph ?? {};
  const pos = (value, fallback) => (Number.isInteger(value) && value > 0 ? value : fallback);
  return { maxDepth: pos(given.maxDepth, DEFAULTS.maxDepth), maxRows: pos(given.maxRows, DEFAULTS.maxRows) };
}

// ---------- the connection ----------

const caches = new WeakMap();
function cacheOf(db) {
  let cache = caches.get(db);
  if (!cache) {
    const has =
      db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'graph_edges'").get() !== undefined;
    cache = { has, statements: new Map() };
    caches.set(db, cache);
  }
  return cache;
}
function prepared(db, sql) {
  const { statements } = cacheOf(db);
  if (!statements.has(sql)) statements.set(sql, db.prepare(sql));
  return statements.get(sql);
}
const one = (db, sql, ...params) => prepared(db, sql).get(...params);
const all = (db, sql, ...params) => prepared(db, sql).all(...params);

/**
 * The audience id an edge or a witness can carry: its row created when missing (an id of no known shape is internal).
 * Looked up every time, never cached: a rolled-back transaction takes the rows it created with it.
 */
function usableAudience(db, id) {
  const value = filled(id) ? id : AUD_INTERNAL;
  const parts = audienceParts(value);
  if (!parts) return usableAudience(db, AUD_INTERNAL);
  if (one(db, 'SELECT 1 AS ok FROM audiences WHERE id = ?', value)) return value;
  if (parts.kind === 'none' || parts.kind === 'internal') {
    prepared(db, 'INSERT OR IGNORE INTO audiences (id, kind) VALUES (?, ?)').run(value, parts.kind);
  } else if (parts.kind === 'group') {
    prepared(db, 'INSERT OR IGNORE INTO interfaces (id) VALUES (?)').run(parts.iface);
    prepared(db, "INSERT OR IGNORE INTO audiences (id, kind, iface) VALUES (?, 'group', ?)").run(value, parts.iface);
  } else {
    const place = one(db, 'SELECT iface FROM places WHERE id = ?', parts.place_id);
    if (!place || !filled(place.iface)) return usableAudience(db, AUD_INTERNAL);
    prepared(db, 'INSERT OR IGNORE INTO interfaces (id) VALUES (?)').run(place.iface);
    prepared(db, "INSERT OR IGNORE INTO audiences (id, kind, iface, place_id) VALUES (?, 'dm', ?, ?)").run(
      value,
      place.iface,
      parts.place_id
    );
  }
  return value;
}

/** A place's own audience: its conversation's (a container: the group of its interface; anything else internal). */
export function placeAudience(place) {
  if (!place) return AUD_INTERNAL;
  if (place.conversation === 'dm') return dmAudienceId(place.id);
  if (place.conversation === 'group' && filled(place.iface)) return groupAudienceId(place.iface);
  if (place.conversation == null && CONTAINERS.has(place.kind) && filled(place.iface))
    return groupAudienceId(place.iface);
  return AUD_INTERNAL;
}

const timeOf = (spec, row) => {
  if (!row) return EPOCH;
  const value = spec.created ? row[spec.created] : null;
  if (spec.ms && Number.isFinite(value)) return new Date(value).toISOString();
  if (filled(value)) return value;
  const fallback = spec.createdFallback ? row[spec.createdFallback] : null;
  return filled(fallback) ? fallback : EPOCH;
};

// ---------- the producers: one per unit table ----------
// Each returns { nodes: [{ id, kind, row_id, created_at }], own: [{ node, audience }], edges: [edge] } for one unit id.
// An edge: { predicate, src: [kind, row id], dst: [kind, row id], audience, evidence, from, to, recorded, retired }.

const node = (kind, row) => ({
  id: graphNodeId(kind, row[NODE_KINDS[kind].key]),
  kind,
  row_id: row[NODE_KINDS[kind].key],
  created_at: timeOf(NODE_KINDS[kind], row),
});
const edge = (predicate, src, dst, fields) => ({
  predicate,
  src,
  dst,
  evidence: null,
  from: null,
  to: null,
  recorded: EPOCH,
  retired: null,
  ...fields,
});
const recordedOf = (...values) => values.find(filled) ?? EPOCH;
const empty = () => ({ nodes: [], own: [], edges: [] });

/** The audience of an identity link: its evidence source's, else `fallback`. */
function linkAudience(db, link, fallback) {
  if (filled(link.evidence_id)) {
    const source = one(db, 'SELECT audience_id FROM sources WHERE id = ?', link.evidence_id);
    if (source && filled(source.audience_id)) return source.audience_id;
  }
  return fallback;
}
/** The edge of an identity link, or null (a proposed link projects nothing). */
function linkEdge(db, predicate, link, src, dst, fallback, retiredWith) {
  if (link.state !== 'verified' && link.state !== 'revoked') return null;
  const retired = link.state === 'revoked' ? recordedOf(link.valid_to_at, link.recorded_at) : (retiredWith ?? null);
  return edge(predicate, src, dst, {
    audience: linkAudience(db, link, fallback),
    evidence: link.evidence_id ?? null,
    from: link.valid_from_at ?? null,
    to: link.valid_to_at ?? null,
    recorded: recordedOf(link.recorded_at),
    retired,
  });
}

const PRODUCERS = {
  interfaces(db, id) {
    const row = one(db, 'SELECT id FROM interfaces WHERE id = ?', id);
    return row ? { ...empty(), nodes: [node('interface', row)] } : empty();
  },
  authorities(db, id) {
    const row = one(db, 'SELECT id FROM authorities WHERE id = ?', id);
    return row ? { ...empty(), nodes: [node('authority', row)] } : empty();
  },
  people(db, id) {
    const row = one(db, 'SELECT id, first_seen_at FROM people WHERE id = ?', id);
    return row ? { ...empty(), nodes: [node('person', row)] } : empty();
  },
  accounts(db, id) {
    const out = empty();
    const row = one(db, 'SELECT id, iface, retired_at FROM accounts WHERE id = ?', id);
    if (row) out.nodes.push(node('account', row));
    const fallback = row && filled(row.iface) ? groupAudienceId(row.iface) : AUD_INTERNAL;
    for (const link of all(db, 'SELECT * FROM account_person_links WHERE account_id = ? ORDER BY id', id)) {
      const person = one(db, 'SELECT retired_at FROM people WHERE id = ?', link.person_id);
      const made = linkEdge(
        db,
        'account_of',
        link,
        ['account', id],
        ['person', link.person_id],
        fallback,
        row?.retired_at ?? person?.retired_at ?? null
      );
      if (made) out.edges.push(made);
    }
    return out;
  },
  participants(db, id) {
    const out = empty();
    const row = one(db, 'SELECT id, scope_place_id, first_seen_at, recorded_at FROM participants WHERE id = ?', id);
    if (row) out.nodes.push(node('participant', row));
    const scope =
      row && filled(row.scope_place_id)
        ? one(db, 'SELECT id, iface, kind, conversation FROM places WHERE id = ?', row.scope_place_id)
        : null;
    const fallback = scope ? placeAudience(scope) : AUD_INTERNAL;
    for (const link of all(db, 'SELECT * FROM participant_links WHERE participant_id = ? ORDER BY id', id)) {
      const dst = filled(link.account_id) ? ['account', link.account_id] : ['person', link.person_id];
      const made = linkEdge(db, 'participant_of', link, ['participant', id], dst, fallback, null);
      if (made) out.edges.push(made);
    }
    return out;
  },
  places(db, id) {
    const out = empty();
    const row = one(db, 'SELECT * FROM places WHERE id = ?', id);
    if (!row) return out;
    out.nodes.push(node('place', row));
    const audience = placeAudience(row);
    const recorded = recordedOf(row.seen_from_at);
    if (filled(row.parent_id))
      out.edges.push(
        edge('contained_in', ['place', id], ['place', row.parent_id], {
          audience,
          recorded,
          retired: row.retired_at ?? null,
        })
      );
    if (filled(row.continues_place_id))
      out.edges.push(
        edge('continues', ['place', id], ['place', row.continues_place_id], {
          audience,
          recorded,
          retired: row.retired_at ?? null,
        })
      );
    return out;
  },
  memberships(db, id) {
    const out = empty();
    const row = one(db, 'SELECT * FROM memberships WHERE id = ?', id);
    if (!row) return out;
    out.nodes.push(node('membership', row));
    const place = filled(row.place_id)
      ? one(db, 'SELECT id, iface, kind, conversation FROM places WHERE id = ?', row.place_id)
      : null;
    const fields = {
      audience: placeAudience(place),
      from: row.valid_from_at ?? null,
      to: row.valid_to_at ?? null,
      recorded: recordedOf(row.valid_from_at),
      retired: row.retired_at ?? null,
    };
    if (filled(row.account_id))
      out.edges.push(edge('has_membership', ['account', row.account_id], ['membership', id], fields));
    if (filled(row.place_id))
      out.edges.push(edge('membership_in', ['membership', id], ['place', row.place_id], fields));
    return out;
  },
  sources(db, id) {
    const out = empty();
    const row = one(db, 'SELECT * FROM sources WHERE id = ?', id);
    if (!row) return out;
    out.nodes.push(node('source', row));
    const audience = filled(row.audience_id) ? row.audience_id : AUD_INTERNAL;
    const retired = row.retired_at ?? null;
    if (!retired) out.own.push({ node: graphNodeId('source', id), audience });
    const fields = { audience, evidence: id, recorded: recordedOf(row.recorded_at, row.occurred_at), retired };
    let author = null;
    if (row.author_kind === 'self') author = ['person', SELF];
    else if (filled(row.author_participant)) author = ['participant', row.author_participant];
    else if (filled(row.author_account)) author = ['account', row.author_account];
    if (author) out.edges.push(edge('authored_by', ['source', id], author, fields));
    if (filled(row.place_id)) out.edges.push(edge('located_in', ['source', id], ['place', row.place_id], fields));
    // Schema v9 follows v8: the relations table is there.
    const marks = RELATION_EDGES.map(() => '?').join(', ');
    for (const relation of all(
      db,
      `SELECT predicate, target_source_id, recorded_at FROM source_relations WHERE source_id = ? AND target_source_id IS NOT NULL AND predicate IN (${marks}) ORDER BY id`,
      id,
      ...RELATION_EDGES
    )) {
      out.edges.push(
        edge(relation.predicate, ['source', id], ['source', relation.target_source_id], {
          ...fields,
          recorded: recordedOf(relation.recorded_at, fields.recorded),
        })
      );
    }
    return out;
  },
  claims(db, id) {
    const out = empty();
    const row = one(db, 'SELECT * FROM claims WHERE id = ?', id);
    const audience = row && filled(row.audience_id) ? row.audience_id : AUD_INTERNAL;
    const claimRetired = row?.retired_at ?? null;
    if (row) {
      out.nodes.push(node('claim', row));
      if (!claimRetired) out.own.push({ node: graphNodeId('claim', id), audience });
      const recorded = recordedOf(row.created_at, row.first_seen_at);
      const subject = aboutTarget(row.subject_kind, row.subject_id);
      if (subject) out.edges.push(edge('about', ['claim', id], subject, { audience, recorded, retired: claimRetired }));
      if (filled(row.superseded_by))
        out.edges.push(
          edge('supersedes', ['claim', row.superseded_by], ['claim', id], { audience, recorded, retired: claimRetired })
        );
    }
    const versions = all(
      db,
      "SELECT * FROM claim_versions WHERE claim_id = ? ORDER BY COALESCE(recorded_at, ''), rowid",
      id
    );
    let previous = null;
    for (const version of versions) {
      const retired = version.retired_at ?? claimRetired;
      out.nodes.push(node('claim_version', version));
      if (!retired) out.own.push({ node: graphNodeId('claim_version', version.id), audience });
      const recorded = recordedOf(version.recorded_at);
      out.edges.push(edge('version_of', ['claim_version', version.id], ['claim', id], { audience, recorded, retired }));
      if (!version.retired_at) {
        if (previous)
          out.edges.push(
            edge('supersedes', ['claim_version', version.id], ['claim_version', previous.id], {
              audience,
              recorded,
              retired,
            })
          );
        previous = version;
      }
      for (const link of all(
        db,
        'SELECT source_id FROM claim_version_sources WHERE version_id = ? ORDER BY source_id',
        version.id
      )) {
        out.edges.push(
          edge('derived_from', ['claim_version', version.id], ['source', link.source_id], {
            audience,
            evidence: link.source_id,
            recorded,
            retired,
          })
        );
      }
    }
    const recorded = row ? recordedOf(row.created_at, row.first_seen_at) : EPOCH;
    out.edges.push(
      ...linkEdges(db, 'claim_sources', 'claim_id', id, ['claim', id], { audience, recorded, claimRetired })
    );
    return out;
  },
  descriptions(db, id) {
    const out = empty();
    const row = one(db, 'SELECT * FROM descriptions WHERE id = ?', id);
    const audience = row && filled(row.audience_id) ? row.audience_id : AUD_INTERNAL;
    const parentRetired = row?.retired_at ?? null;
    if (row) {
      out.nodes.push(node('description', row));
      if (!parentRetired) out.own.push({ node: graphNodeId('description', id), audience });
      const subject = aboutTarget(row.subject_kind, row.subject_id);
      if (subject) out.edges.push(edge('about', ['description', id], subject, { audience, retired: parentRetired }));
    }
    let previous = null;
    for (const version of all(
      db,
      "SELECT * FROM description_versions WHERE description_id = ? ORDER BY COALESCE(written_at, ''), rowid",
      id
    )) {
      const retired = version.retired_at ?? parentRetired;
      out.nodes.push(node('description_version', version));
      if (!retired) out.own.push({ node: graphNodeId('description_version', version.id), audience });
      const recorded = recordedOf(version.written_at);
      out.edges.push(
        edge('version_of', ['description_version', version.id], ['description', id], { audience, recorded, retired })
      );
      if (!version.retired_at) {
        if (previous)
          out.edges.push(
            edge('supersedes', ['description_version', version.id], ['description_version', previous.id], {
              audience,
              recorded,
              retired,
            })
          );
        previous = version;
      }
    }
    return out;
  },
  episodes(db, id) {
    const out = empty();
    const row = one(db, 'SELECT * FROM episodes WHERE id = ?', id);
    const audience = row && filled(row.audience_id) ? row.audience_id : AUD_INTERNAL;
    const parentRetired = row?.retired_at ?? null;
    const recorded = row ? recordedOf(row.created_at) : EPOCH;
    if (row) {
      out.nodes.push(node('episode', row));
      if (!parentRetired) out.own.push({ node: graphNodeId('episode', id), audience });
      if (filled(row.subject_id))
        out.edges.push(
          edge('about', ['episode', id], ['person', row.subject_id], { audience, recorded, retired: parentRetired })
        );
      if (filled(row.place_id))
        out.edges.push(
          edge('about', ['episode', id], ['place', row.place_id], { audience, recorded, retired: parentRetired })
        );
    }
    out.edges.push(
      ...linkEdges(db, 'episode_sources', 'episode_id', id, ['episode', id], {
        audience,
        recorded,
        claimRetired: parentRetired,
      })
    );
    return out;
  },
  diary(db, id) {
    const out = empty();
    const row = one(db, 'SELECT * FROM diary WHERE id = ?', id);
    const audience = row && filled(row.audience_id) ? row.audience_id : AUD_INTERNAL;
    const parentRetired = row?.retired_at ?? null;
    if (row) {
      out.nodes.push(node('diary', row));
      if (!parentRetired) out.own.push({ node: graphNodeId('diary', id), audience });
    }
    return out;
  },
  publications(db, id) {
    // Schema v10: a publication is its own unit (a diary mirror's is one); its node, the entry it publishes and the lines
    // its receipts became.
    const out = empty();
    const row = one(db, 'SELECT * FROM publications WHERE id = ?', id);
    if (!row) return out;
    out.nodes.push(node('publication', row));
    const audience = publicationAudience(db, row);
    const retired = row.retired_at ?? null;
    if (!retired) out.own.push({ node: graphNodeId('publication', id), audience });
    const recorded = recordedOf(row.sent_at, row.created_at);
    if (row.row_kind === 'diary' && filled(row.row_id))
      out.edges.push(edge('published_as', ['diary', row.row_id], ['publication', id], { audience, recorded, retired }));
    if (row.status === 'sent') {
      for (const source of receiptSources(db, row.receipts))
        out.edges.push(
          edge('publication_source', ['publication', id], ['source', source], {
            audience,
            evidence: source,
            recorded,
            retired,
          })
        );
    }
    return out;
  },
  media: ownOnly('media', 'media'),
  intentions: ownOnly('intentions', 'intention'),
  work: ownOnly('work', 'work'),
  decisions: ownOnly('decisions', 'decision'),
};

/**
 * The audience a publication is read with: once sent, its destination place's (the entry's own when it names no
 * destination); before that (queued, failed, unknown) internal: nothing outward has seen it.
 */
function publicationAudience(db, row) {
  if (row.status !== 'sent') return AUD_INTERNAL;
  if (filled(row.destination_place_id))
    return placeAudience(
      one(db, 'SELECT id, iface, kind, conversation FROM places WHERE id = ?', row.destination_place_id)
    );
  if (row.row_kind === 'diary' && filled(row.row_id)) {
    const entry = one(db, 'SELECT audience_id FROM diary WHERE id = ?', row.row_id);
    if (entry && filled(entry.audience_id)) return entry.audience_id;
  }
  return AUD_INTERNAL;
}

/** The stored lines a publication's receipts name (`[{ authority, kind, key }]`): the first stored revision of each. */
function receiptSources(db, receipts) {
  let list;
  try {
    list = JSON.parse(receipts ?? '[]');
  } catch {
    list = [];
  }
  const out = [];
  for (const receipt of Array.isArray(list) ? list : []) {
    if (!receipt || !filled(receipt.authority) || !filled(receipt.kind) || !filled(receipt.key)) continue;
    const found = one(
      db,
      `SELECT id FROM sources WHERE authority_id = ? AND native_kind = ? AND native_id = ? AND generation = 1
      AND kind IN ('said', 'seen') AND retired_at IS NULL ORDER BY revision, rowid LIMIT 1`,
      receipt.authority,
      receipt.kind,
      receipt.key
    );
    if (found && !out.includes(found.id)) out.push(found.id);
  }
  return out;
}

/** A table whose row is one node with its own audience (a decision is internal) and no edges. */
function ownOnly(table, kind) {
  return (db, id) => {
    const row = one(db, `SELECT * FROM ${quote(table)} WHERE id = ?`, id);
    if (!row) return empty();
    const audience = NODE_KINDS[kind].internal
      ? AUD_INTERNAL
      : filled(row.audience_id)
        ? row.audience_id
        : AUD_INTERNAL;
    return {
      nodes: [node(kind, row)],
      own: row.retired_at ? [] : [{ node: graphNodeId(kind, id), audience }],
      edges: [],
    };
  };
}

/** The node a claim or a description is about: a person (her own row for `self`) or a place. */
function aboutTarget(kind, id) {
  if (!filled(id)) return null;
  if (kind === 'person' || kind === 'self') return ['person', id];
  if (kind === 'place') return ['place', id];
  return null;
}

/** derived_from edges of a claim's or an episode's links, one per source (a live link wins over a retired one). */
function linkEdges(db, table, column, id, src, { audience, recorded, claimRetired }) {
  const bySource = new Map();
  for (const link of all(
    db,
    `SELECT source_id, retired_at FROM ${quote(table)} WHERE ${quote(column)} = ? AND source_id IS NOT NULL ORDER BY rowid`,
    id
  )) {
    const retired = link.retired_at ?? claimRetired ?? null;
    const known = bySource.get(link.source_id);
    if (known && known.retired === null) continue;
    bySource.set(
      link.source_id,
      edge('derived_from', src, ['source', link.source_id], { audience, evidence: link.source_id, recorded, retired })
    );
  }
  return [...bySource.values()];
}

// ---------- writing a unit ----------

const ownerKeyOf = (table, id) => `${table}:${id}`;

/** Writes the projection of one unit; returns `{ nodes, edges, retired }` (what it wrote). */
function writeUnit(db, table, id, at) {
  const produced = PRODUCERS[table](db, id);
  const owner = ownerKeyOf(table, id);
  const upsertNode = prepared(
    db,
    `INSERT INTO graph_nodes (id, kind, row_id, created_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET kind = excluded.kind, row_id = excluded.row_id, created_at = excluded.created_at
    WHERE graph_nodes.created_at IS NOT excluded.created_at OR graph_nodes.row_id IS NOT excluded.row_id`
  );
  const placeholder = prepared(
    db,
    'INSERT OR IGNORE INTO graph_nodes (id, kind, row_id, created_at) VALUES (?, ?, ?, ?)'
  );
  const witness = prepared(
    db,
    'INSERT OR IGNORE INTO node_access (node_id, audience_id, evidence_id) VALUES (?, ?, ?)'
  );
  const unwitness = prepared(db, 'DELETE FROM node_access WHERE evidence_id = ?');
  for (const n of produced.nodes) {
    upsertNode.run(n.id, n.kind, String(n.row_id), n.created_at);
    // A node's own witness is keyed by the node itself: dropped, then written again if the row is live.
    prepared(db, 'DELETE FROM node_access WHERE node_id = ? AND evidence_id = ?').run(n.id, n.id);
  }
  for (const w of produced.own) witness.run(w.node, usableAudience(db, w.audience), w.node);
  const keys = new Set();
  const upsertEdge = prepared(
    db,
    `INSERT INTO graph_edges (id, src, predicate, dst, audience_id, evidence_id, valid_from_at, valid_to_at, recorded_at, retired_at, projection_key, owner_key)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET audience_id = excluded.audience_id, evidence_id = excluded.evidence_id, valid_from_at = excluded.valid_from_at,
      valid_to_at = excluded.valid_to_at, recorded_at = excluded.recorded_at, retired_at = excluded.retired_at, owner_key = excluded.owner_key`
  );
  for (const e of produced.edges) {
    const src = graphNodeId(e.src[0], e.src[1]);
    const dst = graphNodeId(e.dst[0], e.dst[1]);
    // The evidence is part of the key only when it is not one of the edge's own ends (a line's own edges, a link to it).
    const evidence =
      (e.src[0] === 'source' && e.evidence === e.src[1]) || (e.dst[0] === 'source' && e.evidence === e.dst[1])
        ? null
        : e.evidence;
    const key = projectionKey(e.predicate, src, dst, evidence);
    if (keys.has(key)) continue;
    keys.add(key);
    placeholder.run(src, e.src[0], String(e.src[1]), EPOCH);
    placeholder.run(dst, e.dst[0], String(e.dst[1]), EPOCH);
    const audience = usableAudience(db, e.audience);
    const edgeId = edgeIdOf(e.predicate, src, dst, evidence);
    upsertEdge.run(
      edgeId,
      src,
      e.predicate,
      dst,
      audience,
      e.evidence ?? null,
      e.from ?? null,
      e.to ?? null,
      e.recorded ?? EPOCH,
      e.retired ?? null,
      key,
      owner
    );
    unwitness.run(edgeId);
    if (!e.retired) {
      witness.run(src, audience, edgeId);
      witness.run(dst, audience, edgeId);
    }
  }
  let retired = 0;
  for (const stale of all(
    db,
    'SELECT id, projection_key FROM graph_edges WHERE owner_key = ? AND retired_at IS NULL',
    owner
  )) {
    if (keys.has(stale.projection_key)) continue;
    prepared(db, 'UPDATE graph_edges SET retired_at = ? WHERE id = ?').run(stamp(at), stale.id);
    unwitness.run(stale.id);
    retired += 1;
  }
  return { nodes: produced.nodes.length, edges: keys.size, retired };
}

/** The units a written row of `table` belongs to: `[[unit table, id], ...]`. */
function unitsOfRow(db, table, row) {
  if (!Object.hasOwn(UNIT_OF, table) || !row) return [];
  const unit = UNIT_OF[table];
  if (unit === null) {
    if (!filled(row.id)) return [];
    const out = [[table, row.id]];
    // A person's retirement retires the links to it: their accounts are projected again.
    if (table === 'people')
      for (const link of all(db, 'SELECT DISTINCT account_id FROM account_person_links WHERE person_id = ?', row.id))
        out.push(['accounts', link.account_id]);
    return out;
  }
  const [parent, column] = unit;
  if (table === 'claim_version_sources') {
    const version = filled(row.version_id)
      ? one(db, 'SELECT claim_id FROM claim_versions WHERE id = ?', row.version_id)
      : null;
    return filled(version?.claim_id) ? [['claims', version.claim_id]] : [];
  }
  let id = row[column];
  if (!filled(id) && filled(row.id) && table !== 'source_relations')
    id = one(db, `SELECT ${quote(column)} AS v FROM ${quote(table)} WHERE id = ?`, row.id)?.v;
  return filled(id) ? [[parent, id]] : [];
}

/**
 * Projects again the unit of a written row (see the head of this file), inside the caller's transaction. A database
 * before v9 has no graph: nothing happens. Returns how many units were projected.
 * @param {object} handle  an `openMemoryDb` handle or a raw connection (the writer)
 * @param {string} table   the typed table the row was written to
 * @param {object} row     the row (its id, or the column naming its unit)
 * @param {{ at?: string }} [opts]  the writer's time (the retirement time of an edge the unit no longer produces)
 */
export function projectRow(handle, table, row, { at, log = engineLog } = {}) {
  const db = dbOf(handle);
  if (!cacheOf(db).has) return 0;
  let count = 0;
  for (const [unit, id] of unitsOfRow(db, table, row)) {
    // The projection never fails the typed write: a unit that cannot be projected is rolled back alone, logged with a
    // code, and the whole projection is marked pending so the next full pass projects it again.
    db.exec('SAVEPOINT graph_unit');
    try {
      writeUnit(db, unit, String(id), at);
      db.exec('RELEASE graph_unit');
      count += 1;
    } catch (error) {
      db.exec('ROLLBACK TO graph_unit');
      db.exec('RELEASE graph_unit');
      prepared(db, 'INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)').run(
        PENDING_KEY,
        JSON.stringify({ unit: 0, after: null })
      );
      log?.warn?.('memory graph: unit not projected, projection pending', {
        table: unit,
        code: error?.code ?? error?.name ?? 'ERROR',
      });
    }
  }
  return count;
}

/** Every unit id of a unit table, in id order after `after` (`limit` of them). */
function unitIds(db, table, after, limit) {
  const sources = {
    accounts: ['SELECT id FROM accounts', 'SELECT account_id FROM account_person_links'],
    participants: ['SELECT id FROM participants', 'SELECT participant_id FROM participant_links'],
    sources: ['SELECT id FROM sources WHERE id IS NOT NULL'],
    claims: ['SELECT id FROM claims', 'SELECT claim_id FROM claim_versions', 'SELECT claim_id FROM claim_sources'],
    descriptions: ['SELECT id FROM descriptions', 'SELECT description_id FROM description_versions'],
    episodes: ['SELECT id FROM episodes', 'SELECT episode_id FROM episode_sources'],
    diary: ['SELECT id FROM diary'],
  }[table] ?? [`SELECT id FROM ${quote(table)}`];
  return db
    .prepare(
      `SELECT v AS id FROM (${sources.map((sql) => sql.replace(/^SELECT (\S+)/, 'SELECT $1 AS v')).join(' UNION ')})
    WHERE v IS NOT NULL AND (? IS NULL OR v > ?) ORDER BY v LIMIT ?`
    )
    .all(after, after, limit)
    .map((r) => String(r.id));
}

/**
 * Projects every unit of the unit tables (all, by default), in slices of `sliceUnits`, one transaction each.
 * Idempotent. Returns `{ units, edges, retired, ms }`.
 * @param {object} handle  an `openMemoryDb` handle (the writer)
 * @param {{ tables?: string[], sliceUnits?: number, at?: string, clock?: () => number }} [opts]
 */
export function reproject(
  handle,
  { tables = UNIT_ORDER, sliceUnits = SLICE_UNITS, at, clock = () => performance.now() } = {}
) {
  const db = dbOf(handle);
  const transaction = handle.transaction ?? ((fn) => fn());
  const started = clock();
  const total = { units: 0, edges: 0, retired: 0 };
  if (!cacheOf(db).has) return { ...total, ms: 0 };
  const wanted = UNIT_ORDER.filter((table) => tables.includes(table) || tables.some((t) => UNIT_OF[t]?.[0] === table));
  for (const table of wanted) {
    let after = null;
    for (;;) {
      const ids = unitIds(db, table, after, sliceUnits);
      if (ids.length === 0) break;
      transaction(() => {
        for (const id of ids) {
          const done = writeUnit(db, table, id, at);
          total.units += 1;
          total.edges += done.edges;
          total.retired += done.retired;
        }
      });
      after = ids[ids.length - 1];
    }
  }
  return { ...total, ms: Math.round((clock() - started) * 10) / 10 };
}

/**
 * The projection the v9 migration left pending, from where it stopped (`meta.graph_pending`: the unit table and the last
 * id done, moved in the same transaction as each slice). Returns `{ done, units, ms }` (`done`: nothing is pending now).
 * `maxSlices` bounds one call (the writers' own job under authority `db`, stage W2a, gives the loop back between calls);
 * the rest stays pending for the next.
 * @param {object} handle  an `openMemoryDb` handle (the writer)
 * @param {{ sliceUnits?: number, maxSlices?: number, at?: string, clock?: () => number }} [opts]
 */
export function projectPending(
  handle,
  { sliceUnits = SLICE_UNITS, maxSlices = Infinity, at, clock = () => performance.now() } = {}
) {
  const db = dbOf(handle);
  const transaction = handle.transaction ?? ((fn) => fn());
  const started = clock();
  if (!cacheOf(db).has) return { done: true, units: 0, ms: 0 };
  const read = () => {
    const value = one(db, 'SELECT value FROM meta WHERE key = ?', PENDING_KEY)?.value;
    if (value === undefined || value === null) return null;
    try {
      return JSON.parse(value);
    } catch {
      return { unit: 0, after: null };
    }
  };
  let units = 0;
  let slices = 0;
  let state = read();
  while (state && slices < maxSlices) {
    slices += 1;
    const index = Number.isInteger(state.unit) && state.unit >= 0 ? state.unit : 0;
    if (index >= UNIT_ORDER.length) {
      transaction(() => prepared(db, 'DELETE FROM meta WHERE key = ?').run(PENDING_KEY));
      break;
    }
    const table = UNIT_ORDER[index];
    const ids = unitIds(db, table, state.after ?? null, sliceUnits);
    transaction(() => {
      for (const id of ids) writeUnit(db, table, id, at);
      const next =
        ids.length < sliceUnits ? { unit: index + 1, after: null } : { unit: index, after: ids[ids.length - 1] };
      prepared(
        db,
        'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
      ).run(PENDING_KEY, JSON.stringify(next));
    });
    units += ids.length;
    state = read();
  }
  return { done: read() === null, units, ms: Math.round((clock() - started) * 10) / 10 };
}

/** Whether a projection is pending (the v9 migration's, not yet done). */
export const graphPending = (handle) =>
  cacheOf(dbOf(handle)).has && one(dbOf(handle), 'SELECT 1 AS ok FROM meta WHERE key = ?', PENDING_KEY) !== undefined;

/** Drops every derived graph row and projects everything again; returns reproject's counts. */
export function rebuildGraph(handle, opts = {}) {
  const db = dbOf(handle);
  if (!cacheOf(db).has) return { units: 0, edges: 0, retired: 0, ms: 0 };
  const transaction = handle.transaction ?? ((fn) => fn());
  transaction(() => {
    db.exec('DELETE FROM node_access; DELETE FROM graph_edges; DELETE FROM graph_nodes;');
    prepared(db, 'DELETE FROM meta WHERE key = ?').run(PENDING_KEY);
  });
  return reproject(handle, opts);
}

// ---------- traversal ----------

/** The audience filter of a context: `{ sql(alias), node(expr), params }` (the internal context reads everything). */
function filterOf(ctx) {
  const ids = audiencesOf(ctx);
  if (ids === null) return { edge: () => '1 = 1', node: () => '1 = 1', edgeParams: [], nodeParams: [] };
  const marks = ids.map(() => '?').join(', ');
  return {
    edge: (alias) => `${alias}.audience_id IN (${marks})`,
    node: (expr) => `EXISTS (SELECT 1 FROM node_access a WHERE a.node_id = ${expr} AND a.audience_id IN (${marks}))`,
    edgeParams: ids,
    nodeParams: ids,
  };
}

/**
 * A traversal from one node or several (see the head of this file).
 * @param {object} db  a connection that can read
 * @param {object} ctx  a read context (scope.ts): group, DM or internal
 * @param {{ from: string|string[], predicates?: string[], direction?: 'out'|'in'|'both', maxDepth?: number, maxRows?: number,
 *   after?: number, config?: object }} opts  `after`: the `next` of a previous page
 * @returns {{ rows: Array<{ node: string, kind: string, rowId: string, depth: number, via: string|null, predicate: string|null, parent: string|null }>,
 *   truncated: boolean, reason: 'depth'|'rows'|null, next: number|null }}
 */
export function walk(
  db,
  ctx,
  { from, predicates = null, direction = 'out', maxDepth, maxRows, after = 0, config = null } = {}
) {
  const filter = filterOf(ctx);
  const settings = graphSettings(config);
  const depth = Number.isInteger(maxDepth) && maxDepth >= 0 ? maxDepth : settings.maxDepth;
  const cap = Number.isInteger(maxRows) && maxRows > 0 ? maxRows : settings.maxRows;
  const skip = Number.isInteger(after) && after > 0 ? after : 0;
  const starts = [...new Set((Array.isArray(from) ? from : [from]).filter(filled))];
  if (starts.length === 0 || !cacheOf(db).has) return { rows: [], truncated: false, reason: null, next: null };
  const predicateSql =
    Array.isArray(predicates) && predicates.length > 0
      ? `AND e.predicate IN (${predicates.map(() => '?').join(', ')})`
      : '';
  const predicateParams = Array.isArray(predicates) && predicates.length > 0 ? predicates : [];
  const hop =
    direction === 'in'
      ? { join: 'e.dst = r.node', next: 'e.src' }
      : direction === 'both'
        ? {
            join: 'e.rowid IN (SELECT rowid FROM graph_edges WHERE src = r.node UNION ALL SELECT rowid FROM graph_edges WHERE dst = r.node)',
            next: 'CASE WHEN e.src = r.node THEN e.dst ELSE e.src END',
          }
        : { join: 'e.src = r.node', next: 'e.dst' };
  const sql = `WITH RECURSIVE r(node, depth, path, via, predicate, parent) AS (
      SELECT n.id, 0, char(31) || n.id || char(31), NULL, NULL, NULL FROM graph_nodes n
       WHERE n.id IN (${starts.map(() => '?').join(', ')}) AND ${filter.node('n.id')}
      UNION ALL
      SELECT ${hop.next}, r.depth + 1, r.path || ${hop.next} || char(31), e.id, e.predicate, r.node
        FROM r JOIN graph_edges e ON ${hop.join}
       WHERE r.depth <= ? AND e.retired_at IS NULL ${predicateSql} AND ${filter.edge('e')}
         AND instr(r.path, char(31) || ${hop.next} || char(31)) = 0 AND ${filter.node(hop.next)}
      ORDER BY 2, 1, 3
      LIMIT ?
    )
    SELECT r.node AS node, r.depth AS depth, r.path AS path, r.via AS via, r.predicate AS predicate, r.parent AS parent, n.kind AS kind, n.row_id AS row_id
      FROM r JOIN graph_nodes n ON n.id = r.node ORDER BY r.depth, r.node, r.path`;
  // The recursion runs one level past maxDepth: a row there says the walk stopped at the depth cap.
  const limit = skip + cap + 1;
  const found = db
    .prepare(sql)
    .all(...starts, ...filter.nodeParams, depth, ...predicateParams, ...filter.edgeParams, ...filter.nodeParams, limit);
  const shallow = found.filter((row) => row.depth <= depth);
  const deeper = found.some((row) => row.depth > depth);
  let truncated = false;
  let reason = null;
  let next = null;
  let page = shallow.slice(skip, skip + cap);
  if (shallow.length > skip + cap) {
    truncated = true;
    reason = 'rows';
    next = skip + cap;
  } else if (deeper) {
    truncated = true;
    reason = 'depth';
  }
  const seen = new Set();
  page = page.filter((row) => (seen.has(row.node) ? false : (seen.add(row.node), true)));
  return {
    rows: page.map((row) => ({
      node: row.node,
      kind: row.kind,
      rowId: row.row_id,
      depth: row.depth,
      via: row.via ?? null,
      predicate: row.predicate ?? null,
      parent: row.parent ?? null,
    })),
    truncated,
    reason,
    next,
  };
}

/** The later of two ISO times, null meaning unbounded (open start). */
const laterOf = (a, b) => (a == null ? (b ?? null) : b == null ? a : a > b ? a : b);
/** The earlier of two ISO times, null meaning unbounded (open end). */
const earlierOf = (a, b) => (a == null ? (b ?? null) : b == null ? a : a < b ? a : b);

/**
 * Everything a person said anywhere: the sources authored by an account verified for the person at the source's time
 * (the account_of window holds `occurred_at`), by a participant linked to the person or to such an account, or by the
 * person directly (her own lines). In event time, then node id. `{ rows: [{ node, rowId, occurredAt, via }], truncated, reason, next }`.
 */
export function saidBy(db, ctx, personId, { maxRows, after = 0, config = null } = {}) {
  const settings = graphSettings(config);
  const cap = Number.isInteger(maxRows) && maxRows > 0 ? maxRows : settings.maxRows;
  const skip = Number.isInteger(after) && after > 0 ? after : 0;
  const person = graphNodeId('person', personId);
  const identities = walk(db, ctx, {
    from: person,
    predicates: ['account_of', 'participant_of'],
    direction: 'in',
    maxDepth: 2,
    maxRows: settings.maxRows,
    config,
  });
  if (identities.rows.length === 0) return { rows: [], truncated: false, reason: null, next: null };
  const windowOf = prepared(db, 'SELECT valid_from_at, valid_to_at FROM graph_edges WHERE id = ?');
  const byNode = new Map(identities.rows.map((row) => [row.node, row]));
  const ids = identities.rows.map((row) => {
    let from = null;
    let to = null;
    for (let at = row; at && at.via; at = byNode.get(at.parent)) {
      const w = windowOf.get(at.via);
      from = laterOf(from, w?.valid_from_at ?? null);
      to = earlierOf(to, w?.valid_to_at ?? null);
    }
    return { n: row.node, f: from, t: to };
  });
  const filter = filterOf(ctx);
  const rows = db
    .prepare(
      `WITH ids AS (SELECT json_extract(value, '$.n') AS node, json_extract(value, '$.f') AS f, json_extract(value, '$.t') AS t FROM json_each(?))
    SELECT DISTINCT e.src AS node, n.row_id AS row_id, s.occurred_at AS occurred_at, ids.node AS via
      FROM ids JOIN graph_edges e ON e.dst = ids.node AND e.predicate = 'authored_by'
      JOIN graph_nodes n ON n.id = e.src JOIN sources s ON s.id = n.row_id
     WHERE e.retired_at IS NULL AND ${filter.edge('e')} AND ${filter.node('e.src')}
       AND (ids.f IS NULL OR s.occurred_at >= ids.f) AND (ids.t IS NULL OR s.occurred_at < ids.t)
     ORDER BY s.occurred_at, e.src LIMIT ? OFFSET ?`
    )
    .all(JSON.stringify(ids), ...filter.edgeParams, ...filter.nodeParams, cap + 1, skip);
  const truncated = rows.length > cap || identities.truncated;
  return {
    rows: rows
      .slice(0, cap)
      .map((row) => ({ node: row.node, rowId: row.row_id, occurredAt: row.occurred_at, via: row.via })),
    truncated,
    reason: rows.length > cap ? 'rows' : identities.reason,
    next: rows.length > cap ? skip + cap : null,
  };
}

const sourcesOnly = (result) => ({ ...result, rows: result.rows.filter((row) => row.kind === 'source') });

/** What happened in a place: the sources located in it and in every place it contains (down to the depth cap). */
export function inPlace(db, ctx, placeId, opts = {}) {
  return sourcesOnly(
    walk(db, ctx, {
      ...opts,
      from: graphNodeId('place', placeId),
      predicates: ['contained_in', 'located_in'],
      direction: 'in',
    })
  );
}

/** Who replied to a line: the sources that reply to it, and the replies to those (down to the depth cap). */
export function repliesTo(db, ctx, sourceId, opts = {}) {
  const start = graphNodeId('source', sourceId);
  const result = walk(db, ctx, { ...opts, from: start, predicates: ['replies_to'], direction: 'in' });
  return { ...result, rows: result.rows.filter((row) => row.node !== start) };
}

/** The places that continue a place (a group that grew out of a DM, a DM that went on from a group), transitively. */
export function continuationsOf(db, ctx, placeId, opts = {}) {
  const start = graphNodeId('place', placeId);
  const result = walk(db, ctx, { ...opts, from: start, predicates: ['continues'], direction: 'in' });
  return { ...result, rows: result.rows.filter((row) => row.node !== start) };
}
