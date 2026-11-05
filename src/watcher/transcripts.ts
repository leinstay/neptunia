// What Claude recorded of the agents' subprocess runs: its session transcripts under
// `<data>/subharness/claude/home/projects/<project>/<id>.jsonl`. An `api-request-shape` holds the system blocks and the tools
// under a hash, an `api-request-blob` one message under a hash, an `api-request` the model, the effort and its messages as
// `keep` (how many of the previous request's stay) plus `tail` (hashes added), and an `assistant` record names its request by
// `requestRef`. A session belongs to the window its last request falls in. What a session does not hold is a gap on the
// request, and nothing stands in for it: hashes resolve within their own file only. A read changes nothing.

import fs from 'node:fs';
import path from 'node:path';
import type { RequestOutcome } from '../llm/archive.ts';
import { fillPage, maskFields, offsetOf } from './requests.ts';
import type { PageGap, RecordedRequest, RecordedRun, RecordedRunPage } from './requests.ts';

type Row = Record<string, unknown>;
type Part = { type?: unknown; text?: unknown };

export type TranscriptQuery = {
  home: string;
  from: number;
  to: number;
  maxChars: number;
  cursor?: string | null;
  /** The page already holds something: a run that does not fit waits for the next page. */
  fitOnly?: boolean;
  excludeSessions?: ReadonlyArray<string>;
  /** The service of a session by its project and id; with it, a session it cannot place carries a gap. */
  attribute?: (project: string, session: string) => string | null;
  /** What became of the session's run, where something else knows. */
  outcome?: (session: string) => RequestOutcome | null;
};

type Session = { project: string; session: string; file: string; last: string };

const UNLINKED: RequestOutcome = { kind: 'none', state: 'unlinked', ref: null };
const isRow = (value: unknown): value is Row => typeof value === 'object' && value !== null;

/** The session files under `home`, with the last request's moment read cheaply: only request lines are parsed. */
function sessionsIn(query: TranscriptQuery): Array<Session> {
  const root = path.join(query.home, 'projects');
  const skip = new Set(query.excludeSessions ?? []);
  const fromIso = new Date(query.from).toISOString();
  const toIso = new Date(query.to).toISOString();
  let projects: Array<string> = [];
  try {
    projects = fs.readdirSync(root);
  } catch {
    return [];
  }
  const found: Array<Session> = [];
  for (const project of projects) {
    let names: Array<string> = [];
    try {
      names = fs.readdirSync(path.join(root, project)).filter((name) => name.endsWith('.jsonl'));
    } catch {
      continue;
    }
    for (const name of names) {
      const session = name.slice(0, -'.jsonl'.length);
      const file = path.join(root, project, name);
      if (skip.has(session)) continue;
      // A file last written before the window holds no request inside it.
      if (fs.statSync(file).mtimeMs <= query.from) continue;
      const last = lastRequestAt(file);
      if (last !== null && last > fromIso && last <= toIso) found.push({ project, session, file, last });
    }
  }
  return found.sort((a, b) => (a.last === b.last ? (a.session < b.session ? -1 : 1) : a.last < b.last ? -1 : 1));
}

function lastRequestAt(file: string): string | null {
  let last: string | null = null;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.includes('"api-request"')) continue;
    try {
      const row = JSON.parse(line) as Row;
      if (row.type === 'api-request' && typeof row.timestamp === 'string') last = row.timestamp;
    } catch {
      // A torn line is counted when the session is read.
    }
  }
  return last;
}

/** The records of a session and how many lines were no record. */
function parseFile(file: string): { records: Array<Row>; broken: number } {
  const records: Array<Row> = [];
  let broken = 0;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (line.trim() === '') continue;
    try {
      const row: unknown = JSON.parse(line);
      if (isRow(row)) records.push(row);
      else broken += 1;
    } catch {
      broken += 1;
    }
  }
  return { records, broken };
}

const textOf = (content: unknown): string =>
  (Array.isArray(content) ? (content as Array<Part>) : [])
    .filter((part) => part.type === 'text' && typeof part.text === 'string')
    .map((part) => String(part.text))
    .join('');

/** The answer records of a session by the request they name. */
function answersIn(records: ReadonlyArray<Row>): Map<string, Array<Row>> {
  const answers = new Map<string, Array<Row>>();
  for (const row of records) {
    if (row.type !== 'assistant' || typeof row.requestRef !== 'string') continue;
    answers.set(row.requestRef, [...(answers.get(row.requestRef) ?? []), row]);
  }
  return answers;
}

type Blob = { role: unknown; content: unknown };

type SessionIndex = {
  shapes: Map<unknown, Row>;
  blobs: Map<unknown, Blob>;
  answers: Map<string, Array<Row>>;
  service: string | null;
  attributed: boolean;
  outcome: RequestOutcome;
  session: string;
};

/** The system text a request received: the shape's blocks, then the system messages it carried. */
function systemOf(shape: Row | undefined, present: ReadonlyArray<Blob>): string | null {
  const blocks = Array.isArray(shape?.system) ? (shape.system as Array<Part>).map((part) => String(part.text)) : [];
  const blobs = present.filter((one) => one.role === 'system').map((one) => textOf(one.content));
  return blocks.length + blobs.length === 0 ? null : [...blocks, ...blobs].join('\n\n');
}

/** What the answer records of a request hold. */
function answerOf(said: ReadonlyArray<Row>) {
  const message = (one: Row | undefined): Row => (isRow(one?.message) ? one.message : {});
  const contents = said.flatMap((one) => {
    const { content } = message(one);
    return Array.isArray(content) ? (content as Array<Part>) : [];
  });
  const calls = contents.filter((part) => part.type === 'tool_use');
  const { usage } = message(said.at(-1));
  const moment = said.at(-1)?.timestamp;
  return {
    responseText: said.length === 0 ? null : textOf(contents),
    toolCalls: calls.length === 0 ? null : JSON.stringify(calls),
    usage: usage === undefined ? null : JSON.stringify(usage),
    finishedAt: typeof moment === 'string' ? moment : null,
  };
}

/** One request with the messages it holds at this point of its session. */
function requestOf(row: Row, held: ReadonlyArray<Blob | null>, index: SessionIndex): RecordedRequest {
  const present = held.filter((one): one is Blob => one !== null);
  const shape = index.shapes.get(row.shapeHash);
  const said = index.answers.get(String(row.id)) ?? [];
  const params = isRow(row.params) ? row.params : {};
  const config = isRow(params.output_config) ? params.output_config : {};
  const { finishedAt, ...answer } = answerOf(said);
  const { masked, fields } = maskFields({
    systemText: systemOf(shape, present),
    messages: JSON.stringify(present.filter((one) => one.role !== 'system')),
    tools: shape?.tools === undefined ? null : JSON.stringify(shape.tools),
    ...answer,
  });
  const gaps = [
    ...(held.includes(null) ? ['missing-blob'] : []),
    ...(shape === undefined ? ['missing-system-text'] : []),
    ...(said.length === 0 ? ['absent-response'] : []),
    ...(masked ? ['credential-masked'] : []),
    ...(index.attributed && index.service === null ? ['unattributed-session'] : []),
  ];
  return {
    id: String(row.id),
    service: index.service,
    runId: index.session,
    backend: 'claude',
    model: typeof params.model === 'string' ? params.model : null,
    effort: typeof config.effort === 'string' ? config.effort : null,
    startedAt: String(row.timestamp),
    finishedAt,
    status: said.length === 0 ? 'unknown' : 'ok',
    errorCode: null,
    ...fields,
    outcome: index.outcome,
    gaps,
  };
}

/** The requests of one session, each with what it was really sent. */
function requestsOf(where: Session, records: ReadonlyArray<Row>, query: TranscriptQuery): Array<RecordedRequest> {
  const shapes = new Map<unknown, Row>();
  const blobs = new Map<unknown, Blob>();
  for (const row of records) {
    if (row.type === 'api-request-shape') shapes.set(row.shapeHash, isRow(row.shape) ? row.shape : {});
    if (row.type === 'api-request-blob' && isRow(row.message)) {
      blobs.set(row.hash, { role: row.message.role, content: row.message.content });
    }
  }
  const index: SessionIndex = {
    shapes,
    blobs,
    answers: answersIn(records),
    service: query.attribute?.(where.project, where.session) ?? null,
    attributed: query.attribute !== undefined,
    outcome: query.outcome?.(where.session) ?? UNLINKED,
    session: where.session,
  };
  let held: Array<Blob | null> = [];
  return records.flatMap((row) => {
    if (row.type !== 'api-request') return [];
    const keep = typeof row.keep === 'number' ? row.keep : 0;
    const tail = Array.isArray(row.tail) ? (row.tail as Array<unknown>) : [];
    held = [...held.slice(0, keep), ...tail.map((hash) => blobs.get(hash) ?? null)];
    return [requestOf(row, held, index)];
  });
}

/** The sessions whose last request fell in (`from`, `to`], paged under the bound with the counts of what is left. */
export function readTranscriptRuns(query: TranscriptQuery): RecordedRunPage {
  const sessions = sessionsIn(query);
  const byKey = new Map(sessions.map((one) => [`transcript:${one.project}/${one.session}`, one]));
  const gaps: Array<PageGap> = [];
  const { runs, nextCursor, examined } = fillPage(
    [...byKey.keys()],
    { offset: offsetOf(query.cursor), maxChars: query.maxChars, fitOnly: query.fitOnly === true },
    (runKey): RecordedRun => {
      const where = byKey.get(runKey) as Session;
      const { records, broken } = parseFile(where.file);
      if (broken > 0) gaps.push({ kind: 'unreadable-line', runKey, count: broken });
      return { runKey, requests: requestsOf(where, records, query) };
    }
  );
  const shown = new Set(runs.map((run) => run.runKey));
  return {
    runs,
    totalRuns: sessions.length,
    examinedRuns: examined,
    unreviewedRuns: sessions.length - examined,
    inFlightRuns: 0,
    nextCursor,
    gaps: gaps.filter((gap) => gap.runKey !== undefined && shown.has(gap.runKey)),
  };
}
