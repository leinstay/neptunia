// A synthetic Claude session transcript for the watcher's tests: the record shapes of
// `<data>/subharness/claude/home/projects/<project>/<id>.jsonl` with invented content. `api-request-shape` holds the
// system blocks and the tools under a hash, `api-request-blob` one message under a hash, `api-request` the model, the
// effort and the messages as `keep` (how many of the previous request's stay) plus `tail` (blob hashes added), and an
// `assistant` record the answer and usage of the request named by its `requestRef`.
import fs from 'node:fs';
import path from 'node:path';

export type TranscriptRecord = Record<string, unknown>;

export const SESSION = '00000000-0000-4000-8000-000000000001';
export const PROJECT = '-tmp-synthetic-worktree';

export const shapeRecord = (hash: string, system: ReadonlyArray<string>, tools: ReadonlyArray<string> = []): TranscriptRecord => ({
  type: 'api-request-shape',
  sessionId: SESSION,
  shapeHash: hash,
  timestamp: '2026-11-04T01:00:00.000Z',
  version: '0.0.0-synthetic',
  shape: {
    system: system.map((text) => ({ type: 'text', text })),
    tools: tools.map((name) => ({ name, description: `what ${name} does`, input_schema: { type: 'object' } })),
  },
});

export const blobRecord = (hash: string, role: string, content: ReadonlyArray<Record<string, unknown>>): TranscriptRecord => ({
  type: 'api-request-blob',
  sessionId: SESSION,
  hash,
  message: { role, content },
});

export const textBlob = (hash: string, role: string, text: string): TranscriptRecord =>
  blobRecord(hash, role, [{ type: 'text', text }]);

export const requestRecord = (
  id: string,
  at: string,
  fields: { shapeHash?: string; keep?: number; tail?: ReadonlyArray<string>; model?: string; effort?: string } = {}
): TranscriptRecord => ({
  type: 'api-request',
  sessionId: SESSION,
  id,
  timestamp: at,
  version: '0.0.0-synthetic',
  querySource: 'sdk',
  shapeHash: fields.shapeHash ?? 'shape-1',
  params: {
    model: fields.model ?? 'model-from-transcript',
    max_tokens: 1000,
    output_config: { effort: fields.effort ?? 'medium' },
  },
  keep: fields.keep ?? 0,
  tail: fields.tail ?? [],
  requestDigest: `digest-${id}`,
});

export const answerRecord = (requestRef: string, at: string, text: string): TranscriptRecord => ({
  type: 'assistant',
  sessionId: SESSION,
  requestRef,
  requestId: `provider-${requestRef}`,
  timestamp: at,
  cwd: '/tmp/synthetic-worktree',
  message: {
    role: 'assistant',
    content: [{ type: 'text', text }],
    usage: { input_tokens: 11, output_tokens: 7 },
  },
});

/** Writes one session file under `home`; a string among the records is written as it is, for a broken line. */
export function writeTranscript(
  home: string,
  records: ReadonlyArray<TranscriptRecord | string>,
  place: { project?: string; session?: string } = {}
): string {
  const dir = path.join(home, 'projects', place.project ?? PROJECT);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${place.session ?? SESSION}.jsonl`);
  fs.writeFileSync(
    file,
    `${records.map((record) => (typeof record === 'string' ? record : JSON.stringify(record))).join('\n')}\n`
  );
  return file;
}

/** One complete session of one request at `at`, answered a minute later by default. */
export function oneRequest(at: string, mark = 'x'): Array<TranscriptRecord> {
  return [
    shapeRecord('shape-1', [`EFFECTIVE-SYSTEM ${mark}`], ['Bash']),
    textBlob('b-user', 'user', `ASKED ${mark}`),
    requestRecord(`req-${mark}`, at, { tail: ['b-user'] }),
    answerRecord(`req-${mark}`, at, `ANSWERED ${mark}`),
  ];
}
