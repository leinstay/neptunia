// Schema v17's data step (schema.js, MIGRATIONS): a repair of what the unit sync undid before her memory session's rows were kept apart from the files' (upsert.js wrote the
// file's copy of a row back over her session's change). For each row a file owns, it takes the latest state her
// session recorded and sets the row back to it, when that state is newer than the row's last change by the file:
//   - a claim: her session's newest version (`claim_versions`, origin `session`) gives the text, the last-seen time
//     and, for a retire, the truth; the claim becomes hers (`owner_file` null, no `co_owners`). The file's last change
//     is the claim's first or last seen time, or a version of another origin;
//   - a description: her newest reviewed version (`description_versions`, origin `review`) becomes current again
//     when the current one is the file's (origin `legacy`); the file's last change is its newest legacy version;
//   - a person's attitude: the reason of her newest move (`affinity_events` without an owner), when the file's newest
//     move is older. The score stays: decay moves it without a move.
// It sends nothing and asks no model. One `decisions` row (`migration:v17:session_rows_repaired`) counts what was set
// back, none when nothing was.

type Row = Record<string, unknown>;
type Statement = {
  all(...params: Array<unknown>): Array<Row>;
  get(...params: Array<unknown>): Row | undefined;
  run(...params: Array<unknown>): unknown;
};
type Db = { prepare(sql: string): Statement };

const text = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);
/** The newest of some ISO times, '' when there is none. */
const newest = (...times: Array<unknown>): string =>
  times.reduce<string>((top, time) => {
    const at = text(time);
    return at !== null && at > top ? at : top;
  }, '');

function repairClaims(db: Db): number {
  let count = 0;
  const claims = db
    .prepare(
      `SELECT c.id, c.first_seen_at, c.last_seen_at, c.valid_to FROM claims c WHERE c.owner_file IS NOT NULL AND c.retired_at IS NULL
        AND EXISTS (SELECT 1 FROM claim_versions v WHERE v.claim_id = c.id AND v.origin = 'session' AND v.retired_at IS NULL)`
    )
    .all();
  const latest = db.prepare(
    "SELECT text, recorded_at, event, extra FROM claim_versions WHERE claim_id = ? AND origin = 'session' AND retired_at IS NULL ORDER BY COALESCE(recorded_at, '') DESC, rowid DESC LIMIT 1"
  );
  const other = db.prepare(
    "SELECT MAX(recorded_at) AS at FROM claim_versions WHERE claim_id = ? AND origin IS NOT 'session' AND retired_at IS NULL"
  );
  for (const claim of claims) {
    const version = latest.get(claim.id);
    const at = text(version?.recorded_at);
    if (!version || at === null) continue;
    if (newest(claim.first_seen_at, claim.last_seen_at, other.get(claim.id)?.at) >= at) continue;
    db.prepare('UPDATE claims SET text = ?, last_seen_at = ?, owner_file = NULL WHERE id = ?').run(
      version.text,
      at,
      claim.id
    );
    if (version.event === 'retire') {
      let truth: unknown = null;
      try {
        truth = (JSON.parse(String(version.extra)) as { truth?: unknown }).truth;
      } catch {
        // a version without a readable truth leaves the claim's truth as it is
      }
      if (typeof truth === 'string') {
        const disputed = truth === 'disputed';
        db.prepare('UPDATE claims SET truth = ?, shown = ?, valid_to = ? WHERE id = ?').run(
          truth,
          disputed ? 1 : 0,
          disputed ? (claim.valid_to ?? null) : at,
          claim.id
        );
      }
    }
    db.prepare("DELETE FROM co_owners WHERE tbl = 'claims' AND key = ?").run(claim.id);
    count += 1;
  }
  return count;
}

function repairDescriptions(db: Db): number {
  let count = 0;
  const descriptions = db
    .prepare(
      `SELECT d.id FROM descriptions d WHERE d.owner_file IS NOT NULL AND d.retired_at IS NULL
        AND (d.current_version IS NULL OR EXISTS (SELECT 1 FROM description_versions c WHERE c.id = d.current_version AND c.origin = 'legacy'))`
    )
    .all();
  const review = db.prepare(
    "SELECT id, written_at FROM description_versions WHERE description_id = ? AND origin = 'review' AND retired_at IS NULL ORDER BY COALESCE(written_at, '') DESC, rowid DESC LIMIT 1"
  );
  const legacy = db.prepare(
    "SELECT MAX(written_at) AS at FROM description_versions WHERE description_id = ? AND origin = 'legacy' AND retired_at IS NULL"
  );
  for (const description of descriptions) {
    const version = review.get(description.id);
    const at = text(version?.written_at);
    if (!version || at === null || newest(legacy.get(description.id)?.at) >= at) continue;
    db.prepare('UPDATE descriptions SET current_version = ? WHERE id = ?').run(version.id, description.id);
    count += 1;
  }
  return count;
}

function repairAttitudes(db: Db): number {
  let count = 0;
  const people = db
    .prepare(
      `SELECT p.id, p.affinity_reason FROM people p WHERE p.owner_file IS NOT NULL AND p.retired_at IS NULL
        AND EXISTS (SELECT 1 FROM affinity_events e WHERE e.person_id = p.id AND e.owner_file IS NULL AND e.retired_at IS NULL)`
    )
    .all();
  const latest = db.prepare(
    "SELECT at, reason FROM affinity_events WHERE person_id = ? AND owner_file IS NULL AND retired_at IS NULL ORDER BY COALESCE(at, '') DESC, rowid DESC LIMIT 1"
  );
  const filed = db.prepare(
    'SELECT MAX(at) AS at FROM affinity_events WHERE person_id = ? AND owner_file IS NOT NULL AND retired_at IS NULL'
  );
  for (const person of people) {
    const move = latest.get(person.id);
    const at = text(move?.at);
    if (!move || at === null || newest(filed.get(person.id)?.at) >= at || person.affinity_reason === move.reason)
      continue;
    db.prepare('UPDATE people SET affinity_reason = ? WHERE id = ?').run(move.reason, person.id);
    count += 1;
  }
  return count;
}

/** Schema v17 on `connection` (a node:sqlite connection, inside the migration's transaction). */
export function repairSessionRows(connection: unknown): void {
  const db = connection as Db; // open.js#migrate hands every step its connection
  const claims = repairClaims(db);
  const descriptions = repairDescriptions(db);
  const reasons = repairAttitudes(db);
  if (claims + descriptions + reasons === 0) return;
  db.prepare(
    `INSERT OR IGNORE INTO decisions (id, at, by, target_kind, target_id, action, reason, extra, owner_file, position, retired_at)
      VALUES ('migration:v17:session_rows_repaired', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'migration', 'table', 'claims',
        'migration:session_rows_repaired', 'the unit sync wrote files over her memory session''s rows', ?, NULL, NULL, NULL)`
  ).run(JSON.stringify({ claims, descriptions, reasons }));
}
