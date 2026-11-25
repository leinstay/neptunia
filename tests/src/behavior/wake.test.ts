// Tests for src/behavior/wake.ts: the kind lines of a wake (`awakeLines`), the places page, the facts of `<feedback>`
// and the parser diagnostics, worded by the shipped labels. How `diagnosticText` fills `{count}` for a `msgMalformed`
// diagnostic, which carries three counts and no `count` of its own: the persona must read how many tags were out of
// place, never zero.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  awakeLines,
  diagnosticText,
  feedbackFactText,
  feedbackInTurnText,
  feedbackText,
  placesBlockText,
} from '../../../src/behavior/wake.ts';
import { fill, formatClock, formatDate } from '../../../src/format.ts';
import { labels } from '../../fixtures/labels.ts';
import { wrongly } from '../../fixtures/loose-types.ts';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { joinLabels } from '../../../src/config/labels.ts';
import { HOUR_MS } from '../../../src/time.ts';

const LABELS = { tools: { diagnostics: { msgMalformed: 'out of place: {count}' } } };

test('a msgMalformed diagnostic fills {count} with the sum of its three counts', () => {
  const told = diagnosticText({ kind: 'msgMalformed', nested: 2, unclosed: 1, stray: 3 }, LABELS);
  assert.equal(told, 'out of place: 6');
});

test('a msgMalformed diagnostic kept as a fact of an inner turn fills {count} the same way', () => {
  const told = diagnosticText(
    { kind: 'diagnostic', diagnostic: 'msgMalformed', nested: 1, unclosed: 0, stray: 0 },
    LABELS
  );
  assert.equal(told, 'out of place: 1');
});

// ---- the lines of a wake and its feedback ----

const WAKE_NOW = Date.parse('2026-10-19T12:00:00Z');
const WAKE = {
  kind: 'intention_due',
  items: [{ kind: 'intention_due', reason: 'due', intentionIds: ['i1'], errandId: null }],
  intentions: [{ id: 'i1', purpose: 'πες καλημέρα στο κανάλι', dueAt: WAKE_NOW - 60_000 }],
  now: WAKE_NOW,
  timezone: 'UTC',
  channels: [],
};
/** The labels the lines are worded by. */
const FEEDBACK = labels.wake.feedback;
const KINDS = labels.wake.kinds;
const DIAGNOSTICS = labels.tools.diagnostics;

test('awakeLines: a due intention is one kind line with its purpose, a last occurrence adds its note; none without the kinds', () => {
  const lines = awakeLines(WAKE, labels);
  assert.equal(lines.length, 1, lines.join('|'));
  assert.ok(lines[0].startsWith('due: i1 πες καλημέρα'), lines.join('|'));
  assert.deepEqual(awakeLines(WAKE, { ...labels, wake: undefined }), []);
  // A recurring intention's last occurrence before its expiry: the note joins its line.
  const noted = awakeLines(
    { ...WAKE, notes: { i1: 'last-occurrence' } },
    { ...labels, intentions: { notes: { 'last-occurrence': 'LAST' } } }
  );
  assert.ok(
    noted.some((line) => line.startsWith('due: i1 πες καλημέρα') && line.endsWith(' · LAST')),
    noted.join('|')
  );
  assert.equal(
    awakeLines({ ...WAKE, notes: { i1: 'last-occurrence' } }, labels)[0],
    lines[0],
    'without the note label the line stays as it is'
  );
});

test('awakeLines: an attend wake names the place, the lines and the people; placesBlockText is the places page with its total and the rest', () => {
  const attend = {
    kind: 'attend',
    reason: 'lines',
    intentionIds: ['i1'],
    errandId: null,
    attend: {
      place: 'c2',
      placeName: 'κήπος',
      lines: 3,
      people: ['u1', 'u2'],
      peopleNames: ['Ana', 'u2'],
      since: WAKE_NOW - 3_600_000,
    },
  };
  const places = {
    total: 5,
    more: 2,
    items: [
      { id: 'c2', name: 'κήπος', lines: 3, people: 2, writable: true, attended: true },
      { id: 'c3', name: 'νέα', lines: 1, people: 1, writable: false, attended: false },
      { id: 'c1', name: 'general', lines: 0, people: 0, writable: true, attended: false },
    ],
  };
  const lines = awakeLines(wrongly({ ...WAKE, kind: 'attend', items: [attend] }), labels);
  assert.equal(lines.length, 1, lines.join('|'));
  assert.ok(
    lines[0].startsWith('talk in #κήπος (i1 πες καλημέρα στο κανάλι): 3 lines since ') &&
      lines[0].endsWith(' by Ana, u2'),
    lines.join('|')
  );
  assert.equal(
    placesBlockText(places, labels),
    ['places (5):', '#κήπος 3/2 *', '#νέα 1/1 ro', '#general 0/0', '+2'].join('\n')
  );
  assert.equal(
    placesBlockText({ total: 1, more: 0, items: [{ id: 'c1', name: 'general', lines: 0, people: 0 }] }, labels)
      .split('\n')
      .filter((line) => line.startsWith('+')).length,
    0,
    'no "more" line when nothing follows'
  );
  assert.equal(
    placesBlockText(places, { ...labels, wake: { ...labels.wake, places: undefined } }),
    '',
    'no page without its lead label'
  );
  assert.equal(placesBlockText(null, labels), '');
});

test("feedbackText: a feedback wake is one feedbackItem per fact, each worded by its kind's label, and awakeLines its kind line; a fact without a label is left out", () => {
  const facts = [
    { kind: 'callFailed', skill: 'web.search', status: 'timeout', code: 'timeout' },
    { kind: 'doneWithoutDelivery', intentionId: 'i1', purpose: 'send a cat meme' },
    { kind: 'loopCut', cut: 'steps', droppedCalls: 1, steps: 2 },
    { kind: 'wakeDropped', id: 'w', wake: 'intention_due', code: 'no-channel', intentionId: 'i7', purpose: 'announce' },
    { kind: 'unknownKind' },
  ];
  const wake = {
    ...WAKE,
    kind: 'feedback',
    items: [{ kind: 'feedback', reason: 'feedback', intentionIds: [], errandId: null, facts, turnId: 't-1' }],
    intentions: [],
  };
  const text = feedbackText(wake, labels);
  const lines = text.split('\n');
  assert.deepEqual(awakeLines(wake, labels), [KINDS.feedback]);
  assert.equal(
    lines[0],
    fill(labels.wake.feedbackItem, {
      fact: fill(FEEDBACK.callFailed, {
        skill: 'web.search',
        status: 'timeout',
        code: 'timeout',
        text: '',
      }).trim(),
    })
  );
  assert.equal(
    lines[1],
    fill(labels.wake.feedbackItem, {
      fact: fill(FEEDBACK.doneWithoutDelivery, { id: 'i1', purpose: 'send a cat meme' }),
    })
  );
  assert.equal(
    lines[2],
    fill(labels.wake.feedbackItem, {
      fact: fill(FEEDBACK.loopCut, { cut: 'steps', dropped: '1', steps: '2' }),
    })
  );
  assert.equal(
    lines[3],
    fill(labels.wake.feedbackItem, {
      fact: fill(FEEDBACK.wakeDropped, {
        kind: 'intention_due',
        code: 'no-channel',
        id: 'i7',
        purpose: 'announce',
        why: '',
      }).trim(),
    })
  );
  assert.equal(lines.length, 4, 'the unknown kind left out');
  assert.ok(!text.includes('{'), 'every placeholder filled');
  // Without the item label the facts are left out; the kind line stays.
  const bare = { ...labels, wake: { ...labels.wake, feedbackItem: '' } };
  assert.equal(feedbackText(wake, bare), '');
  assert.deepEqual(awakeLines(wake, bare), [KINDS.feedback]);
});

test('feedbackText: held, failed-turn and send-failed facts, the sub-code behind a drop, a drop of a wake with no intention by its kind; the kept facts of a turn follow under their header', () => {
  const until = WAKE_NOW + 6 * 3_600_000;
  const when = `${formatDate(until, 'UTC', 'en-US')} ${formatClock(until, 'UTC', 'en-US')}`;
  const facts = [
    {
      kind: 'wakeHeld',
      wakeId: 'w1',
      wake: 'intention_due',
      code: 'per-chain',
      intentionId: 'i2',
      purpose: 'say hi',
      until,
    },
    {
      kind: 'wakeDropped',
      wakeId: 'w2',
      wake: 'intention_due',
      code: 'stale',
      why: 'done',
      intentionId: 'i3',
      purpose: 'old one',
    },
    {
      kind: 'wakeDropped',
      wakeId: 'w3',
      wake: 'heartbeat',
      code: 'no-channel',
      why: 'unavailable',
      intentionId: null,
      purpose: '',
    },
    { kind: 'turnFailed', code: 'provider-limit', wake: 'attend' },
    { kind: 'sendFailed', code: 'send-failed', n: 1, total: 3 },
    { kind: 'callFailed', skill: 'web.search', status: 'failed', code: 'error', text: 'the page is gone' },
    { kind: 'unknownKind' },
  ];
  const lines = feedbackText({ ...WAKE, facts }, labels).split('\n');
  const at = lines.indexOf(labels.wake.feedbackInTurn);
  assert.equal(at, 0, lines.join('\n'));
  const item = (fact: string) => fill(labels.wake.feedbackItem, { fact });
  assert.deepEqual(lines.slice(at + 1, at + 7), [
    item(`held intention_due i2 say hi per-chain until ${when}`),
    item('wake intention_due i3 old one stale is done'),
    item('wake heartbeat no-channel unavailable'),
    item('turn attend failed provider-limit'),
    item('send failed send-failed 1/3'),
    item('call web.search failed error the page is gone'),
  ]);
  assert.equal(lines.length, at + 7, 'the unknown kind left out');
  // The same lines stand alone for an addressed turn; nothing without facts, a header or the item label.
  assert.equal(feedbackInTurnText(facts, labels).split('\n')[0], labels.wake.feedbackInTurn);
  assert.equal(feedbackInTurnText(facts, labels).split('\n').length, 7);
  assert.equal(feedbackInTurnText([], labels), '');
  assert.equal(feedbackInTurnText([{ kind: 'unknownKind' }], labels), '');
  assert.equal(feedbackInTurnText(facts, { ...labels, wake: { ...labels.wake, feedbackInTurn: undefined } }), '');
  assert.equal(feedbackInTurnText(facts, { ...labels, wake: { ...labels.wake, feedbackItem: undefined } }), '');
});

test('feedbackFactText: a stateLost fact names the code; without its label, nothing', () => {
  assert.equal(
    feedbackFactText({ kind: 'stateLost', code: 'parse' }, labels.wake),
    fill(FEEDBACK.stateLost, { code: 'parse' })
  );
  assert.equal(feedbackFactText({ kind: 'stateLost', code: 'parse' }, { feedback: {} }), '');
});

test('awakeLines: a retried wake is followed by its delayed line with the minutes and the code; none without the label', () => {
  const wake = {
    items: [
      { kind: 'heartbeat', intentionIds: [], delayed: { minutes: 7, code: 'timeout' } },
      { kind: 'heartbeat', intentionIds: [] },
    ],
    now: WAKE_NOW,
    timezone: 'UTC',
  };
  const lines = awakeLines(wake, labels);
  assert.equal(lines.filter((line) => line === 'delayed 7 timeout').length, 1);
  assert.equal(lines[lines.indexOf('delayed 7 timeout') - 1], KINDS.heartbeat);
  const bare = { wake: { ...labels.wake, delayed: undefined } };
  assert.equal(awakeLines(wake, { ...labels, ...bare }).includes('delayed 7 timeout'), false);
});

test('diagnosticText: one line per parser diagnostic from tools.diagnostics; nothing without the labels', () => {
  const retired = { kind: 'retiredTag', tag: 'draw' };
  assert.equal(
    diagnosticText(retired, labels),
    fill(DIAGNOSTICS.retiredTag, { tag: 'draw' }).replace(/\s+/g, ' ').trim()
  );
  assert.equal(
    diagnosticText({ kind: 'messageCut', chars: 50 }, labels),
    fill(DIAGNOSTICS.messageCut, { chars: '50' })
  );
  assert.equal(
    diagnosticText({ kind: 'messagesMerged', count: 2 }, labels),
    fill(DIAGNOSTICS.messagesMerged, { count: '2' })
  );
  assert.equal(
    diagnosticText({ kind: 'diagnostic', diagnostic: 'thinkUnclosed' }, labels),
    DIAGNOSTICS.thinkUnclosed,
    'a kept fact names its kind'
  );
  assert.equal(diagnosticText({ kind: 'strange' }, labels), '');
  // As a kept fact it is worded in the facts block of the next turn, and only when the labels are at hand.
  const fact = { kind: 'diagnostic', diagnostic: 'messageCut', chars: 7 };
  assert.equal(
    feedbackInTurnText([fact], labels).split('\n')[1],
    fill(labels.wake.feedbackItem, { fact: diagnosticText(fact, labels) })
  );
  assert.equal(feedbackFactText(fact, labels.wake), '');
});

test('feedbackFactText: a proxySwitched fact words its switch by the code label, so the persona learns the proxy went down or came back', () => {
  // Catches: the engine proxy's fallback is added as a fact no label words, and the persona never hears of it.
  for (const change of ['proxy-down', 'proxy-back'] as const)
    assert.equal(
      feedbackFactText({ kind: 'proxySwitched', code: change, why: change }, labels.wake),
      fill(FEEDBACK.proxySwitched, { why: FEEDBACK.codes[change] })
    );
});

test('feedbackFactText: a memoryFailed fact names the code and how many lines wait, an interrupted fact the turn and what it did; without their labels, nothing', () => {
  assert.equal(
    feedbackFactText({ kind: 'memoryFailed', code: 'apply-error', waiting: 20 }, labels.wake),
    fill(FEEDBACK.memoryFailed, { code: 'apply-error', n: '20' })
  );
  assert.equal(
    feedbackFactText({ kind: 'interrupted', wake: 'intention_due', done: 'post "x"' }, labels.wake),
    fill(FEEDBACK.interrupted, { kind: 'intention_due', done: 'post "x"' })
  );
  assert.equal(feedbackFactText({ kind: 'memoryFailed', code: 'apply-error', waiting: 20 }, { feedback: {} }), '');
  assert.equal(feedbackFactText({ kind: 'interrupted', wake: 'review', done: 'x' }, { feedback: {} }), '');
});

// ---- the shipped layer --------------------------------------------------------

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const PROMPTS_DIR = path.join(ROOT, 'prompts');

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
  config: JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'config.json'), 'utf8')),
  prompts: {
    ...Object.fromEntries(PROMPT_FILES.map((name) => [name, readPrompt(name)])),
    labels: joinLabels(JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'labels.json'), 'utf8'))),
  },
};
// The shipped labels carry the keys of the contract (the fixture covers every one).
const SHIPPED_LABELS = SHIPPED.prompts.labels as typeof labels;

// ---- the scene: one server, its members and channels --------------------------------

const NOW = Date.UTC(2026, 9, 5, 12, 0, 0);

test('shipped labels: every kind of fact the persona can be told is worded, with no placeholder left unfilled, and the dropped-calls line takes its count and cause', () => {
  const facts = [
    { kind: 'callFailed', skill: 'web.search', status: 'failed', code: 'error', text: 'the page is gone' },
    { kind: 'doneWithoutDelivery', intentionId: 'i1', purpose: 'say hi' },
    { kind: 'loopCut', cut: 'extra-call', droppedCalls: 2, steps: 1 },
    {
      kind: 'wakeDropped',
      wakeId: 'w1',
      wake: 'intention_due',
      code: 'stale',
      why: 'done',
      intentionId: 'i1',
      purpose: 'say hi',
    },
    {
      kind: 'wakeDropped',
      wakeId: 'w2',
      wake: 'review',
      code: 'no-channel',
      why: 'no-review-channel',
      intentionId: null,
      purpose: '',
    },
    {
      kind: 'wakeHeld',
      wakeId: 'w3',
      wake: 'intention_due',
      code: 'per-chain',
      intentionId: 'i2',
      purpose: 'later',
      until: NOW + HOUR_MS,
    },
    { kind: 'turnFailed', code: 'cut-off', wake: 'attend' },
    { kind: 'sendFailed', code: 'forbidden', n: 1, total: 3 },
  ];
  const text = feedbackInTurnText(facts, SHIPPED_LABELS, { locale: SHIPPED_LABELS.locale });
  assert.equal(text.split('\n').length, facts.length + 1, text);
  assert.equal(text.split('\n')[0], SHIPPED_LABELS.wake.feedbackInTurn);
  assert.ok(!/[{}]/.test(text), text);
  const { codes } = SHIPPED_LABELS.wake.feedback;
  for (const code of ['done', 'cancelled', 'expired', 'forgotten', 'dm-off', 'not-writable', 'unavailable'])
    assert.equal(typeof (codes as Record<string, string>)[code], 'string', code);
  assert.equal(
    fill((SHIPPED_LABELS.task as unknown as { callsDropped: string }).callsDropped, {
      count: '2',
      why: 'extra-call',
    }).includes('{'),
    false
  );
});
