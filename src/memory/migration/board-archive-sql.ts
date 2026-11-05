// The shipped board step that moves the archived errands into the board (board schema v3), as it ran: the owner paths and
// the metadata of that release stay spelled the way that release stored them.

const isoSql = (ms: string): string =>
  `CASE WHEN ${ms} IS NULL THEN NULL ELSE strftime('%Y-%m-%dT%H:%M:%S', ${ms} / 1000, 'unixepoch') || '.' || ` +
  `printf('%03d', ${ms} % 1000) || 'Z' END`;
/** The board status of an errand state held in an SQL expression, as `statusOfState` maps it. */
const statusSql = (state: string): string =>
  `CASE ${state} WHEN 'queued' THEN 'approved' WHEN 'running' THEN 'in_progress' WHEN 'done' THEN 'done' ` +
  `WHEN 'cancelled' THEN 'cancelled' ELSE 'failed' END`;
const field = (key: string): string => `json_extract(w.record, '$.${key}')`;

/**
 * Board v3's data step (src/board/schema.ts), run in the board's migration transaction after the memory schema: every
 * `work` row of kind errand (the retired ones too, the errands a list let go of) becomes an errand task with its id
 * and the fields `metadataOf` keeps, its result text a handoff, and each of its `work_events` lines a status event in
 * line order (one event at its status when it has none). A row whose record does not parse, does not carry its id, or
 * whose unit names no server stays in the archive only. Nothing is written to `work` or `work_events`.
 */
export const MOVE_ARCHIVE_SQL = `
CREATE TEMP TABLE board_v3_errands AS
  SELECT w.id AS id, w.record AS record, w.rowid AS seq,
    substr(w.owner_file, 8, instr(substr(w.owner_file, 8), '/') - 1) AS guild,
    COALESCE(${isoSql(field('createdAt'))}, '1970-01-01T00:00:00.000Z') AS created,
    COALESCE(${isoSql(`COALESCE(${field('endedAt')}, ${field('startedAt')}, ${field('createdAt')})`)},
      '1970-01-01T00:00:00.000Z') AS updated
  FROM work w
  WHERE w.kind = 'errand' AND json_valid(w.record) AND json_type(w.record) = 'object'
    AND json_extract(w.record, '$.id') = w.id AND w.owner_file GLOB 'guilds/?*/*'
  ORDER BY w.created_ms, w.rowid;
INSERT INTO board_tasks (id, lane, title, requester, role, status, close_reason, subscriber, created_at, updated_at,
    metadata)
  SELECT id, 'errand', COALESCE(json_extract(record, '$.goal'), ''), 'persona',
    COALESCE(json_extract(record, '$.agent'), ''), ${statusSql("json_extract(record, '$.state')")},
    CASE WHEN json_type(record, '$.error') = 'text' THEN json_extract(record, '$.error') END, 'persona', created,
    updated,
    json_object('guildId', guild, 'errand',
      json_remove(record, '$.id', '$.agent', '$.goal', '$.state', '$.error', '$.result.text'))
  FROM board_v3_errands ORDER BY seq;
INSERT INTO board_results (id, task_id, attempt_id, kind, body, uri, created_at)
  SELECT 'R-' || id, id, NULL, 'handoff',
    json_object(
      'result', CASE WHEN json_type(record, '$.result.text') = 'text' THEN json_extract(record, '$.result.text') ELSE '' END,
      'evidence', json((SELECT json_group_array(value) FROM json_each(record, '$.result.sources') WHERE type = 'text')),
      'artifacts', json((SELECT json_group_array(json_extract(value, '$.name')) FROM json_each(record, '$.result.files')
        WHERE json_type(value, '$.name') = 'text')),
      'tests', json('[]'), 'open_issues', json('[]')),
    NULL, updated
  FROM board_v3_errands WHERE json_type(record, '$.result') = 'object' ORDER BY seq;
INSERT INTO board_events (task_id, actor, type, old, new, created_at)
  SELECT task_id, 'core', 'status', LAG(status) OVER (PARTITION BY task_id ORDER BY owner_file, position), status, at
  FROM (
    SELECT e.work_id AS task_id, e.owner_file AS owner_file, e.position AS position,
      ${statusSql("json_extract(e.record, '$.state')")} AS status,
      COALESCE(${isoSql('e.at_ms')}, v.updated) AS at, v.seq AS seq
    FROM work_events e JOIN board_v3_errands v ON v.id = e.work_id
    WHERE json_valid(e.record)
  )
  ORDER BY seq, owner_file, position;
INSERT INTO board_events (task_id, actor, type, old, new, created_at)
  SELECT v.id, 'core', 'status', NULL, ${statusSql("json_extract(v.record, '$.state')")}, v.updated
  FROM board_v3_errands v WHERE NOT EXISTS (SELECT 1 FROM work_events e WHERE e.work_id = v.id AND json_valid(e.record))
  ORDER BY v.seq;
DROP TABLE board_v3_errands;
`;
