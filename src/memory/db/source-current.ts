// Which rows of `sources` are a chat line as it stands now, as SQL. A leaf, because the store of media and recall both read it.

/** The rows `t` of the same message as the row `s`. */
const SOURCE_FAMILY = `t.native_id IS s.native_id AND t.iface IS s.iface AND t.place_id IS s.place_id
  AND COALESCE(t.authority_id, t.iface || '/global') IS COALESCE(s.authority_id, s.iface || '/global')
  AND COALESCE(t.native_kind, 'message') IS COALESCE(s.native_kind, 'message')
  AND COALESCE(t.generation, 1) IS COALESCE(s.generation, 1)`;
/** The newest revision of a chat line, once, deleted or not. Needs the alias `s`. */
export const CURRENT_REVISION = `s.kind IN ('seen', 'said') AND s.retired_at IS NULL
  AND s.revision IS (SELECT MAX(t.revision) FROM sources t WHERE ${SOURCE_FAMILY} AND t.kind IN ('seen', 'said') AND t.retired_at IS NULL)
  AND s.rowid = (SELECT MIN(t.rowid) FROM sources t WHERE ${SOURCE_FAMILY} AND t.kind IN ('seen', 'said') AND t.retired_at IS NULL AND t.revision IS s.revision)`;
/** Whether a `deleted` line stands for the message of the row `s`. */
export const SOURCE_DELETED = `EXISTS (SELECT 1 FROM sources d WHERE d.native_id IS s.native_id AND d.iface IS s.iface
    AND d.place_id IS s.place_id AND d.kind = 'deleted' AND d.retired_at IS NULL
    AND (d.authority_id IS NULL OR d.authority_id IS COALESCE(s.authority_id, s.iface || '/global'))
    AND (d.native_kind IS NULL OR d.native_kind IS COALESCE(s.native_kind, 'message'))
    AND (d.generation IS NULL OR d.generation IS COALESCE(s.generation, 1)))`;
/** `current`: the newest revision of a chat line, once, and not a deleted message. Needs the alias `s`. */
export const CURRENT_SOURCE = `${CURRENT_REVISION}
  AND NOT ${SOURCE_DELETED}`;
