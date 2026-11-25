// The code catalogue (src/tools/codes.ts): every emitter imports its code from it, every code has
// its wording in the shipped labels, a code never falls to `other`, and the call mark and the
// `<result>` block word a code the same way with the same values.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CATALOGUE,
  CODE,
  FEATURE,
  INVALID_CODES,
  WHAT,
  httpCode,
  normalCode,
  reasonText,
  isCode,
} from '../../../src/tools/codes.ts';
import { joinLabels } from '../../../src/config/labels.ts';
import type { LabelsFile } from '../../../src/config/labels.ts';
import { callMarksFor, fill, formatTranscript } from '../../../src/format.ts';
import { orderedHistory } from '../../../src/turn/history.ts';
import { toolResultText } from '../../../src/tools/tool-calls.ts';
import { refusalStatus } from '../../../src/tools/executors.ts';
import { callMarksOf } from '../../../src/memory/journal.ts';
import { catalogueProblems, renderCodesTable } from '../../../scripts/lib/labels-catalogue.ts';
import { asRecord } from '../../fixtures/records.ts';
import type { Untyped } from '../../../src/tools/types.ts';
import { noMediaNames } from '../../fixtures/media-namer.ts';
import { useIface, useSelf } from '../../fixtures/turn-world.ts';
import type { labels as contractLabels } from '../../fixtures/labels.ts';

// The casts through `Parameters<typeof f>` hand a function a fake that carries only the fields the test reads.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
// The shipped labels live in config/labels.json under `model` and `owner`, read joined as the engine reads them.
const labelsFile: unknown = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'labels.json'), 'utf8'));
const shipped = joinLabels(labelsFile as LabelsFile);
const contract = fs.readFileSync(path.join(ROOT, 'docs', 'prompt-contract.md'), 'utf8');

// ---- the emitters ----------------------------------------------------------------------------

/** Where an emitter spells a code: a `code:` property, a comparison of a code, a refusal or failure call. */
const LITERAL = "'([a-z][a-z0-9]*(?:-[a-z0-9]+)*)'";
const POSITIONS = [
  new RegExp(`\\bcode: ${LITERAL}`, 'g'),
  new RegExp(`\\bcode\\s*[!=]==\\s*${LITERAL}`, 'g'),
  new RegExp(`\\bcode = ${LITERAL}`, 'g'),
  new RegExp(`\\b(?:refused|failSend|failedWith)\\(${LITERAL}`, 'g'),
  new RegExp(`\\.failed\\(${LITERAL}`, 'g'),
  new RegExp(`\\b(?:invalid|denied)\\([^\\n]*,\\s*${LITERAL}\\)`, 'g'),
  new RegExp(`\\bnotOk\\('[a-z]+',\\s*${LITERAL}`, 'g'),
];
/** Words in those positions that are not codes: a typeof test, the stage of a sandbox verdict. */
const NOT_CODES = new Set(['string', 'number', 'resolve', 'gateway']);
const SCANNED = [
  'src/skills',
  'src/ops',
  'src/admin.ts',
  'src/errands',
  'src/web',
  'src/intentions',
  'src/behavior/turn.ts',
  'src/behavior/inner-output.ts',
  'src/behavior/inner.ts',
  'src/behavior/recall-run.ts',
  'src/behavior/pipeline.ts',
  'src/behavior/pending.ts',
  'src/behavior/missed.ts',
  'src/interface',
  'interfaces/discord/port.ts',
];

function sourceFiles(entry: string): Array<string> {
  const full = path.join(ROOT, entry);
  if (!fs.existsSync(full)) return [];
  if (fs.statSync(full).isFile()) return [entry];
  return fs.readdirSync(full).flatMap((name) => sourceFiles(path.join(entry, name)));
}

test('codes: no emitter spells a code as a string literal; every code is imported from the catalogue', () => {
  const found: Array<string> = [];
  for (const file of SCANNED.flatMap(sourceFiles).filter(
    (name) => name.endsWith('.js') && name !== path.join('src', 'skills', 'codes.js')
  )) {
    fs.readFileSync(path.join(ROOT, file), 'utf8')
      .split('\n')
      .forEach((line, i) => {
        const trimmed = line.trim();
        if (trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*')) return;
        for (const pattern of POSITIONS) {
          pattern.lastIndex = 0;
          for (const match of line.matchAll(pattern))
            if (!NOT_CODES.has(match[1])) found.push(`${file}:${i + 1} '${match[1]}'`);
        }
      });
  }
  assert.deepEqual(found, []);
});

test('CODE: a name the catalogue does not have throws, a code is its upper-cased name', () => {
  assert.equal(CODE.NOT_FOUND, 'not-found');
  assert.equal(CODE.HTTP, 'http');
  assert.throws(() => CODE.NOT_A_CODE, /not a catalogued code/);
  for (const code of Object.keys(CATALOGUE)) assert.equal(CODE[code.toUpperCase().replaceAll('-', '_')], code);
});

test('catalogue: every entry has a known status, a group and only the values the families take', () => {
  // `refused` is one of the set. `intention-notice` is a call held before it ran, which every reader of a result
  // already words and counts as `refused` (src/tools/tool-calls.ts, src/behavior/inner/facts.ts), without the verdict of
  // `denied`'s lead.
  const statuses = new Set(['ok', 'denied', 'refused', 'invalid', 'not_configured', 'failed', 'partial', 'unknown']);
  for (const [code, entry] of Object.entries(CATALOGUE)) {
    assert.ok(statuses.has(entry.status), code);
    assert.ok(['skill', 'wake', 'internal', 'ok'].includes(entry.group), code);
    // `ability` and `why` are the values of `ability-unavailable`.
    // `minutes` and `window` are the values of `cooldown`: the minutes left and the window of the setting.
    assert.ok(
      entry.params.every((param) =>
        ['status', 'what', 'feature', 'ability', 'why', 'minutes', 'window'].includes(param)
      ),
      code
    );
  }
  assert.deepEqual(
    Object.keys(CATALOGUE)
      .filter((code) => (CATALOGUE as Record<string, Untyped>)[code].params.length > 0)
      .sort(),
    // `ability-unavailable` names the ability and why its role is down.
    // `cooldown` names the minutes left and the window of `tools.destructiveCooldownMinutes`.
    ['ability-unavailable', 'cap', 'cooldown', 'http', 'not-configured', 'provider', 'timeout']
  );
});

test('refusalStatus: a wrong call is invalid, a rule that said no is denied', () => {
  for (const code of [
    'not-own-message',
    'file-elsewhere',
    'target-required',
    'destination-required',
    'no-own-message',
    'message-deleted',
    'file-expired',
  ])
    assert.equal(refusalStatus(code), 'invalid', code);
  for (const code of ['safe-mode', 'owner-only', 'cooldown']) assert.equal(refusalStatus(code), 'denied', code);
  assert.ok(INVALID_CODES.includes('unknown-skill'));
});

// ---- the wording -----------------------------------------------------------------------------

test('labels: a code without its entry, an entry without its code and a value the code does not take are all caught', () => {
  const lacking = structuredClone(shipped);
  delete asRecord(lacking.tools).result.reasons['not-found'];
  assert.deepEqual(catalogueProblems({ catalogue: CATALOGUE, labels: lacking }), [
    'code not-found has no labels.tools.result.reasons.not-found',
  ]);
  const extra = structuredClone(shipped);
  asRecord(extra.tools).result.reasons['no-such-code'] = 'x';
  assert.deepEqual(catalogueProblems({ catalogue: CATALOGUE, labels: extra }), [
    'labels.tools.result.reasons.no-such-code has no catalogue code',
  ]);
  const odd = structuredClone(shipped);
  asRecord(odd.tools).result.reasons['not-found'] = 'nothing {what}';
  assert.deepEqual(catalogueProblems({ catalogue: CATALOGUE, labels: odd }), [
    'labels.tools.result.reasons.not-found names {what}, which the code does not take',
  ]);
  assert.match(
    catalogueProblems({
      catalogue: CATALOGUE,
      labels: shipped,
      docs: contract.replace(renderCodesTable(CATALOGUE), ''),
    })[0],
    /no generated codes table/
  );
  assert.match(
    catalogueProblems({
      catalogue: { ...CATALOGUE, ok: { ...CATALOGUE.ok } },
      labels: shipped,
      docs: contract.replace('| `not-found` |', '| `not-fund` |'),
    })[0],
    /out of date/
  );
});

/** A value for each parameter a code takes. */
const VALUES = { status: '502', what: WHAT.page, feature: FEATURE.web };
const valuesOf = (code: string) =>
  Object.fromEntries(
    (CATALOGUE as Record<string, Untyped>)[code].params.map((param: Untyped) => [
      param,
      (VALUES as Record<string, string>)[param],
    ])
  );

test('codes: no code of the catalogue reaches reasons.other, in the mark or in the <result> block', () => {
  const other = asRecord(shipped.tools).result.reasons.other;
  for (const [code] of Object.entries(CATALOGUE).filter(([, entry]) => entry.group === 'skill')) {
    const values = valuesOf(code);
    const text = reasonText(shipped, code, values, fill);
    assert.ok(text, code);
    // `error` is the generic failure: its words may be the fallback's.
    if (code !== CODE.ERROR) assert.notEqual(text, other, code);
    assert.ok(!/\{\w+\}/.test(text), `${code}: ${text}`);
    const block = toolResultText(
      { skill: 'message.create', status: (CATALOGUE as Record<string, Untyped>)[code].status, code, values },
      shipped
    );
    assert.ok(block.includes(text), `${code}: ${block}`);
  }
});

test('reasonText: the values fill, a {what} or {feature} goes through labels.tools.result.params, a missing value gives no text', () => {
  const labels = {
    tools: {
      result: {
        reasons: {
          timeout: '{what} did not answer',
          http: 'HTTP {status}',
          'not-configured': '{feature} is not set up',
          'not-found': 'nothing found',
        },
        params: { what: { page: 'the page' }, feature: { web: 'the web lookup' } },
      },
    },
  };
  assert.equal(reasonText(labels, 'timeout', { what: 'page' }, fill), 'the page did not answer');
  assert.equal(reasonText(labels, 'timeout', { what: 'elsewhere' }, fill), 'elsewhere did not answer');
  assert.equal(reasonText(labels, 'timeout', {}, fill), null);
  assert.equal(reasonText(labels, 'not-configured', { feature: 'web' }, fill), 'the web lookup is not set up');
  assert.equal(reasonText(labels, 'not-found', { status: '9' }, fill), 'nothing found');
  assert.equal(reasonText(labels, 'unheard-of', {}, fill), null);
  assert.equal(reasonText({}, 'timeout', {}, fill), null);
});

// Bug: a cooldown refusal stored before it carried values is shown with `{minutes}` and `{window}` left in the text
// instead of falling back to reasons.other.
test('reasonText: a cooldown with no values gives no text, and with its values names both numbers', () => {
  const labels = {
    tools: { result: { reasons: { cooldown: 'own call within {window} min, again in {minutes} min' } } },
  };
  assert.equal(reasonText(labels, 'cooldown', null, fill), null);
  assert.equal(reasonText(labels, 'cooldown', {}, fill), null);
  assert.equal(
    reasonText(labels, 'cooldown', { minutes: 7, window: 10 }, fill),
    'own call within 10 min, again in 7 min'
  );
});

test("an HTTP status in a port's code is the http reason with its status", () => {
  assert.deepEqual(normalCode(httpCode(403)), { code: 'http', values: { status: '403' } });
  assert.deepEqual(normalCode('timeout', { what: 'page' }), { code: 'timeout', values: { what: 'page' } });
  const labels = { tools: { result: { reasons: { http: 'the server answered {status}' } } } };
  assert.equal(reasonText(labels, httpCode(404), null, fill), 'the server answered 404');
});

// ---- the mark and the block read the same ----------------------------------------------------

const T0 = Date.UTC(2026, 8, 20, 10, 0, 0);
const markText = (labels: unknown, mark: unknown) => {
  const lines = [
    {
      id: 'p1',
      ts: T0 + 60_000,
      authorId: 'me',
      authorName: 'Nept',
      self: true,
      content: 'ok',
      placeId: 'c1',
      channelName: 'general',
    },
  ];
  const call = {
    placeId: 'c1',
    at: T0 + 70_000,
    skill: 'web.read',
    target: { messageId: null, placeId: null },
    postedId: null,
    posted: ['p1'],
    ...asRecord(mark),
  };
  // A mark is its own line among the lines by time, made by orderedHistory, not withCalls.
  return formatTranscript(orderedHistory(lines, callMarksFor([call]), T0 + 3_600_000), {
    mediaNameOf: noMediaNames,
    timezone: 'UTC',
    gapMinutes: 20,
    maxChars: 100,
    selfName: 'Nept',
    labels,
  })[0].text;
};

test('the call mark and the <result> block word a parameterised code alike, also after the mark came back from the journal', () => {
  const cases = [
    { code: 'provider', status: 'failed', values: { status: '503' } },
    { code: 'http', status: 'failed', values: { status: '404' } },
    { code: 'timeout', status: 'unknown', values: { what: WHAT.search } },
    { code: 'cap', status: 'failed', values: { what: WHAT.search } },
    { code: 'not-configured', status: 'not_configured', values: { feature: FEATURE.web } },
    { code: 'not-found', status: 'invalid' },
  ];
  for (const { code, status, values } of cases) {
    const said = reasonText(shipped, code, values ?? {}, fill);
    assert.ok(said, code);
    const block = toolResultText({ skill: 'web.read', status, code, ...(values ? { values } : {}) }, shipped);
    assert.ok(block.includes(said), `${code}: ${block}`);
    const live = markText(shipped, {
      status,
      detail: { kind: code, code, arg: null, ...(values ? { fields: values } : {}) },
    });
    assert.ok(live.includes(said), `${code}: ${live}`);
    // The journal keeps the values with the code, so a mark rebuilt after a restart says the same.
    const records = [
      {
        kind: 'action',
        name: 'skill',
        opId: 'o1',
        turnId: 't1',
        phase: 'failed',
        occurredAt: new Date(T0 + 70_000).toISOString(),
        scope: { channel: 'c1' },
        input: { skill: 'web.read' },
        result: { status, code, ...(values ? { values } : {}) },
      },
    ];
    const [mark] = callMarksOf(records).calls;
    assert.deepEqual(asRecord(mark).values, values);
  }
});

// Every shipped prompt is filled by its builder. Each request the bot can send is built here
// from the TRACKED layer -- prompts/*.md and prompts/labels.json read the way src/hot.ts reads
// them for a deployment without prompts.local/, and config.json without config.local.json --
// through the builder or the factory that sends it, with fakes only at the edges (no network,
// no data/, no real Discord, no model). Every request must leave no `{{placeholder}}` and no
// label `{key}` unfilled, must carry each prompt file it loads whole, and must render the blocks
// its labels head; together the requests load every tracked prompt file. A placeholder added to
// a prompt without a filler, a filler dropped from a builder, a prompt file no builder sends or
// a label key missing from labels.json fails here instead of reaching the model as literal text.
// The switches a request needs (the web lookup, video vision) are
// turned on per test; every number comes from the shipped config.json.

// ---- the shipped layer --------------------------------------------------------

const PROMPTS_SHIPPED_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const PROMPTS_DIR = path.join(PROMPTS_SHIPPED_ROOT, 'prompts');

/** The tracked prompt files at any depth, by key: the path relative to prompts/ without `.md`, `/` between the parts. */
const PROMPT_FILES = fs
  .readdirSync(PROMPTS_DIR, { recursive: true, encoding: 'utf8' })
  .filter((file) => file.endsWith('.md'))
  .map((file) => file.slice(0, -'.md'.length).split(path.sep).join('/'))
  .sort();

const BOM = String.fromCharCode(0xfeff);

/** `prompts/<name>.md` as src/hot.ts reads it: the BOM and carriage returns dropped, trimmed. */
function readPrompt(name: string) {
  const text = fs.readFileSync(path.join(PROMPTS_DIR, `${name}.md`), 'utf8');
  return (text.startsWith(BOM) ? text.slice(1) : text).replace(/\r\n/g, '\n').trim();
}

/** The tracked layer alone: config/ with the labels read joined, and prompts/, never a local override. */
const SHIPPED = {
  config: JSON.parse(fs.readFileSync(path.join(PROMPTS_SHIPPED_ROOT, 'config', 'config.json'), 'utf8')),
  prompts: {
    ...Object.fromEntries(PROMPT_FILES.map((name) => [name, readPrompt(name)])),
    labels: joinLabels(JSON.parse(fs.readFileSync(path.join(PROMPTS_SHIPPED_ROOT, 'config', 'labels.json'), 'utf8'))),
  },
};
// The shipped labels carry the keys of the contract (the fixture covers every one).
const LABELS = SHIPPED.prompts.labels as typeof contractLabels;
describe('shipped prompts', () => {
  before(() => {
    useIface('fake');
    useSelf('900000000000000001');
  });
  after(() => {
    useIface('discord');
    useSelf('self-id');
  });

  test('labels: every code of the catalogue has its words in the tracked labels.json and no words lack their code', () => {
    assert.deepEqual(catalogueProblems({ catalogue: CATALOGUE, labels: LABELS }), []);
  });
});

// `skill.run` runs only the bytes that were validated (src/tools/operations/skill.ts, src/skills/package.ts). The activated
// version of a skill names the content hash of its package; the snapshot under `.versions/<hash>/` must still hash to
// it when the script is about to run. A snapshot whose bytes changed after the activation is refused before anything
// executes with `skill-tampered`, and a snapshot with its folder or the called script gone with `skill-missing`. Both
// codes are worded in the shipped labels like every skill failure code, and the log line names the skill and the
// version and carries no file content. A real port over a memory database and real temporary folders; the scripts
// leave a marker file when they run.

const SKILLS_RUN_HASH_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

test('both refusal codes are catalogued as skill failures and worded in the shipped labels', () => {
  // Bug: a code outside the catalogue throws at its first use, and one without a label reaches the persona as `other`.
  const labels = joinLabels(
    JSON.parse(fs.readFileSync(path.join(SKILLS_RUN_HASH_ROOT, 'config', 'labels.json'), 'utf8')) as LabelsFile
  );
  const reasons = (labels as unknown as { tools: { result: { reasons: Record<string, unknown> } } }).tools.result
    .reasons;
  for (const code of ['skill-tampered', 'skill-missing']) {
    assert.equal(isCode(code), true, `${code} is in the catalogue`);
    const entry = (CATALOGUE as Record<string, { status: string; group: string }>)[code];
    assert.equal(entry?.group, 'skill');
    assert.equal(entry?.status, 'failed');
    // The lead: a label is a string; the lint refuses stringifying an unknown value and a bare type check.
    assert.match(reasons[code] as string, /\S/, `${code} has a label`);
  }
});
