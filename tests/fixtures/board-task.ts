// One board task with its events, read straight from the memory database's `board_tasks` and
// `board_events` tables, for the tests that check what the errand store wrote to the board.

/** A read connection that answers SQL, such as node:sqlite's. */
type Readable = { prepare(sql: string): { get(...args: Array<unknown>): unknown; all(...args: Array<unknown>): Array<unknown> } };

export type BoardTask = {
  task: { id: string; title: string; role: string; status: string; close_reason: string | null; metadata: string | null };
  events: Array<{ seq: number; actor: string | null; type: string; old: string | null; new: string | null }>;
};

/** Task `id` with its events in the order they were written; null when the board holds no such task. */
export function boardTaskOf(db: unknown, id: string): BoardTask | null {
  const conn = db as Readable;
  const task = conn
    .prepare('SELECT id, title, role, status, close_reason, metadata FROM board_tasks WHERE id = ?')
    .get(id) as BoardTask['task'] | undefined;
  if (task === undefined) return null;
  const events = conn
    .prepare('SELECT seq, actor, type, old, new FROM board_events WHERE task_id = ? ORDER BY seq')
    .all(id) as BoardTask['events'];
  return { task: { ...task }, events: events.map((event) => ({ ...event, seq: Number(event.seq) })) };
}
