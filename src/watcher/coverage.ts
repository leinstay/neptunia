// What the record of each service holds, checked against the code by tests/watcher-coverage.test.ts: each field is recorded at
// a file and a symbol, or a gap with its reason. Chat clients go through `archivedLlm`; agents' subprocess runs are read from
// Claude's transcripts. Every gap here is one the read can name, so the report's `Unavailable checks` uses these words.

export const COVERAGE_GAPS = [
  'absent-response',
  'absent-transcript',
  'archive-write-failed',
  'credential-masked',
  'memory-unavailable',
  'missing-blob',
  'missing-media',
  'missing-system-text',
  'no-request-row',
  'session-map-write-failed',
  'truncated-tool-output',
  'unattributed-session',
  'unreadable-line',
  'vendor-instructions',
] as const;
export type CoverageGap = (typeof COVERAGE_GAPS)[number];

export type CoverageField = { state: 'recorded'; where: string } | { state: 'gap'; reason: string };
export type CoveragePath =
  | { path: string; state: 'recorded'; where: string; reason?: undefined }
  | { path: string; state: 'gap'; reason: string };
export type CoverageEntry = {
  service: string;
  path: 'chat-client' | 'subprocess';
  fields: Record<
    'request' | 'toolResults' | 'backend' | 'model' | 'runIdentity' | 'timestamps' | 'outcomeLink',
    CoverageField
  >;
  paths: Array<CoveragePath>;
  gaps: Array<CoverageGap>;
  transcripts?: { backend: 'claude'; path: string };
};

const at = (where: string): CoverageField => ({ state: 'recorded', where });
const gap = (reason: string): CoverageField => ({ state: 'gap', reason });

const ARCHIVE = 'src/llm/archive.ts';
const ROWS = 'src/memory/db/request-archive.ts';
const CHAT_PATH: CoveragePath = { path: ARCHIVE, state: 'recorded', where: `${ARCHIVE}#archivedLlm` };

const chatFields = (outcomeLink: CoverageField): CoverageEntry['fields'] => ({
  request: at(`${ARCHIVE}#storedMessages`),
  toolResults: at(`${ARCHIVE}#storedMessages`),
  backend: at(`${ROWS}#backend`),
  model: at(`${ROWS}#model`),
  runIdentity: at(`${ARCHIVE}#run_id`),
  timestamps: at(`${ROWS}#started_at`),
  outcomeLink,
});

const CHAT_GAPS: Array<CoverageGap> = [
  'archive-write-failed',
  'missing-media',
  'absent-response',
  'truncated-tool-output',
];

const TURN_OUTCOME = at(`${ARCHIVE}#turnOutcome`);

const chat = (service: string, outcomeLink: CoverageField = TURN_OUTCOME): CoverageEntry => ({
  service,
  path: 'chat-client',
  fields: chatFields(outcomeLink),
  paths: [CHAT_PATH],
  gaps: CHAT_GAPS,
});

const TRANSCRIPTS = 'src/watcher/transcripts.ts';

const agent = (service: string, outcomeLink: CoverageField): CoverageEntry => ({
  service,
  path: 'subprocess',
  fields: {
    request: at(`${TRANSCRIPTS}#requestsOf`),
    toolResults: at(`${TRANSCRIPTS}#api-request-blob`),
    backend: at('src/subharness/sessions.ts#backend'),
    model: at(`${TRANSCRIPTS}#params.model`),
    runIdentity: at('src/subharness/sessions.ts#recordSession'),
    timestamps: at(`${TRANSCRIPTS}#timestamp`),
    outcomeLink,
  },
  paths: [
    { path: 'claude', state: 'recorded', where: `${TRANSCRIPTS}#readTranscriptRuns` },
    { path: 'codex', state: 'gap', reason: 'its sessions are not read, so a run on codex has no recorded request' },
    {
      path: 'opencode',
      state: 'gap',
      reason: 'its sessions are not read, so a run on opencode has no recorded request',
    },
  ],
  gaps: [
    'missing-blob',
    'missing-system-text',
    'absent-response',
    'unattributed-session',
    'unreadable-line',
    'session-map-write-failed',
  ],
  transcripts: { backend: 'claude', path: 'subharness/claude/home/projects/<project>/<id>.jsonl' },
});

const TASK_OUTCOME = at('src/watcher/requests.ts#taskOutcomes');

/** One entry per service whose requests the watcher reviews. */
export const ARCHIVE_COVERAGE: ReadonlyArray<CoverageEntry> = [
  chat('core'),
  {
    ...chat('memory', at(`${ROWS}#setRequestOutcome`)),
    paths: [
      CHAT_PATH,
      {
        path: 'src/subharness/memory-writer.ts',
        state: 'recorded',
        where: 'src/subharness/memory-writer.ts#subprocess',
      },
    ],
    gaps: [...CHAT_GAPS, 'vendor-instructions', 'absent-transcript'],
  },
  chat('heartbeat'),
  chat('selfreflection'),
  chat('selfimprovement'),
  {
    ...chat('helpers', gap('a helper answers its caller, and no receipt says what the caller did with it')),
    paths: [
      CHAT_PATH,
      { path: 'src/llm/embed.ts', state: 'gap', reason: 'an embedding request bypasses `complete` and has no row' },
      { path: 'src/speech/synth.ts', state: 'gap', reason: 'a speech request bypasses `complete` and has no row' },
    ],
    gaps: [...CHAT_GAPS, 'no-request-row'],
  },
  agent('thinker', TASK_OUTCOME),
  agent('dev', TASK_OUTCOME),
  agent('scout', TASK_OUTCOME),
  agent('server', TASK_OUTCOME),
  agent('watcher', gap('an inspection is judged by its own saved report and receipts, not by a row')),
];
