// The standard of her output at the turn (master plan U.2, U.5, the owner's word of 2026-11-05). A reply with text and no
// `<think>` is stored and handed on with an empty one and is counted. A leaked answer, one that closes a think it never
// opened or opens one and never closes it, is never sent: the same request runs once more, and a second such answer ends
// the turn with no message, a fact for her and a count. Nothing edits her words: a broken answer is dropped whole, its
// calls included. Over the turn harness: a real admin, the fake interface, a scripted model. Synthetic Greek text only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { archivedLlm, withRequestMeta } from '../src/llm/archive.ts';
import { labels } from './fixtures/labels.ts';
import { asRecord } from './fixtures/records.ts';
import { call, textAnswer, toolAnswer } from './fixtures/tool-answers.ts';
import {
  appended,
  contentText,
  coreTurn,
  journalOverMemory,
  requestText,
  sequenceLlm,
} from './fixtures/turn-harness.ts';

const UNOPENED = 'σχέδιο της απάντησης</think><msg>χαμένο</msg>';
const UNCLOSED = '<think>σχέδιο της απάντησης <msg>χαμένο</msg>';
const SHAPES: ReadonlyArray<readonly [string, string]> = [
  ['closes a think it never opened', UNOPENED],
  ['opens a think and never closes it', UNCLOSED],
];
const GOOD = '<think>τώρα σωστά</think><msg>ναι</msg>';
const TAG = /<\s*\/?\s*think\b/i;

type Run = Awaited<ReturnType<typeof coreTurn>>;
type TurnRecord = { think: string; format: Record<string, number> };

const texts = (run: Run): Array<string> => run.sends.map((send) => String(send.text));
const called = (run: Run): Array<string> =>
  run.logs.filter((entry) => entry.msg === 'skills: called').map((entry) => String(entry.skill));

/** The `turn` record the journal holds for the run. */
function turnRecord(lines: ReadonlyArray<{ record: unknown }>): TurnRecord {
  return lines.map(({ record }) => record).find((record) => asRecord(record).kind === 'turn') as TurnRecord;
}

/** A wake an inner turn answers. */
const NOW = Date.parse('2026-10-17T12:00:00Z');
const INNER = {
  inner: {
    kind: 'intention_due',
    items: [{ kind: 'intention_due', reason: 'due', intentionIds: ['i1'], errandId: null }],
    intentions: [{ id: 'i1', purpose: 'απάντησε', dueAt: NOW - 60_000 }],
    now: NOW,
    timezone: 'UTC',
    channels: [],
  },
  config: { wakes: { mode: 'live', chatMessages: 2 } },
  prompts: { inner: 'Do what the wake says.' },
  allowed: ['message.create'],
};

// ---------- a reply with no think ----------

for (const [transport, answer] of [
  ['native', toolAnswer],
  ['text', textAnswer],
] as const) {
  // Bug: the next request hands her an answer of another shape, and the stored replies stop being uniform.
  test(`on the ${transport} transport a reply with no think is handed on with an empty one, its words untouched`, async () => {
    const run = await coreTurn({
      answers: [answer('<msg>χωρίς σκέψη</msg>', [call('lore.list')]), GOOD],
      withHot: (hot) => {
        hot.config.tools.transport = transport;
      },
    });
    const handedOn = appended(run.llm, 1).find((message) => message.role === 'assistant');
    assert.ok(contentText(handedOn?.content).startsWith('<think></think><msg>χωρίς σκέψη</msg>'));
  });
}

// Bug: the fix inserts the empty think into the text that goes out.
test('a reply with no think posts her words as she wrote them, in one request, and is counted', async () => {
  const { journal, lines } = journalOverMemory();
  const run = await coreTurn({ answers: ['<msg>χωρίς σκέψη</msg>'], journal });
  assert.deepEqual(texts(run), ['χωρίς σκέψη']);
  assert.equal(run.llm.calls.length, 1);
  assert.equal(turnRecord(lines).format.thinkMissing, 1);
  assert.equal(turnRecord(lines).format.thinkLeaked, 0);
});

// Bug: the request archive, the record the standard is measured on, loses the raw answer or shows another shape, or every
// helper's plain answer gets a think it never wrote. Stage U, the lead's ruling: `response_text` stays the raw answer because
// the archive is never rewritten, so this test pins the shape in the reply's `think`. The history she reads back holds it too,
// which the two transport tests above pin.
test('the request archive keeps a reply as it came with an empty think, and a helper answer with none', async () => {
  const writes: Array<Record<string, unknown>> = [];
  const llm = archivedLlm(sequenceLlm(['<msg>χωρίς σκέψη</msg>']), {
    write: (update) => {
      writes.push(update);
      return Promise.resolve();
    },
    log: { warn() {} },
  });
  await coreTurn({ answers: [], runner: { llm } });
  const stored = writes.filter((update) => typeof update.response_text === 'string').at(-1);
  assert.equal(stored?.response_text, '<msg>χωρίς σκέψη</msg>');
  assert.equal(stored?.think, '');

  const helperWrites: Array<Record<string, unknown>> = [];
  const helper = archivedLlm(
    { complete: () => Promise.resolve({ text: 'none', usage: {}, estimated: 1 }) },
    {
      write: (update) => {
        helperWrites.push(update);
        return Promise.resolve();
      },
      log: { warn() {} },
    }
  );
  await withRequestMeta(() => helper.complete());
  const helperStored = helperWrites.filter((update) => typeof update.response_text === 'string').at(-1);
  assert.equal(helperStored?.response_text, 'none');
  assert.equal(helperStored?.think, null);
});

// ---------- a leaked answer, once ----------

for (const [name, leaked] of SHAPES) {
  // Bug: the leaked answer goes out, or the turn goes silent where a second request would have answered.
  test(`an answer that ${name} is not sent and the same request runs once more`, async () => {
    const { journal, lines } = journalOverMemory();
    const run = await coreTurn({ answers: [leaked, GOOD], journal });
    assert.equal(run.llm.calls.length, 2);
    assert.deepEqual(run.llm.calls[1], run.llm.calls[0], 'the same request, with nothing of the broken answer in it');
    assert.deepEqual(texts(run), ['ναι']);
    assert.equal(asRecord(run.result).outcome, 'spoke');
    assert.equal(turnRecord(lines).format.thinkLeaked, 1);
    assert.equal(turnRecord(lines).format.leakEnded, 0);
    // The think the turn keeps is the answer's that stood, never the dropped one.
    assert.equal(turnRecord(lines).think, 'τώρα σωστά');
  });

  // Bug: a broken answer's call has run before the speech is dropped, so it was not dropped whole.
  test(`the calls of an answer that ${name} do not run`, async () => {
    const run = await coreTurn({ answers: [toolAnswer(leaked, [call('lore.list')]), GOOD] });
    assert.deepEqual(called(run), []);
    assert.deepEqual(texts(run), ['ναι']);
  });

  // Bug: only the reply's first answer is checked, and a step after her calls leaks.
  test(`an answer that ${name} after a call is asked again with the same request`, async () => {
    const run = await coreTurn({ answers: [toolAnswer('<think>α</think>', [call('lore.list')]), leaked, GOOD] });
    assert.equal(run.llm.calls.length, 3);
    assert.deepEqual(run.llm.calls[2], run.llm.calls[1]);
    assert.deepEqual(texts(run), ['ναι']);
  });

  // Bug: a turn opened by a finished errand reads her answer on its own path.
  test(`an errand's result turn drops an answer that ${name} too`, async () => {
    const run = await coreTurn({ answers: [leaked, GOOD], triggerKind: 'errand' });
    assert.equal(run.llm.calls.length, 2);
    assert.deepEqual(texts(run), ['ναι']);
  });

  // Bug: an inner turn lowers the message of the broken answer into a post.
  test(`an inner turn drops an answer that ${name} and asks once more`, async () => {
    const run = await coreTurn({
      ...INNER,
      answers: [leaked, '<think>τώρα σωστά</think><msg>καλημέρα</msg>', '<skip/>'],
    });
    assert.deepEqual(texts(run), ['καλημέρα']);
    assert.deepEqual(run.llm.calls[1], run.llm.calls[0]);
  });
}

// ---------- a leaked answer, twice ----------

const TWICE: ReadonlyArray<readonly [string, string, string]> = [
  ['closes a think it never opened, twice', UNOPENED, UNOPENED],
  ['opens a think and never closes it, twice', UNCLOSED, UNCLOSED],
  ['leaks one way and then the other', UNOPENED, UNCLOSED],
  ['leaks the other way and then the one', UNCLOSED, UNOPENED],
];

for (const [name, first, second] of TWICE) {
  // Bug: the turn keeps asking, or a second leak goes out because the first was the only one checked.
  test(`an answer that ${name} ends the turn with no message and two requests`, async () => {
    const { journal, lines } = journalOverMemory();
    const run = await coreTurn({ answers: [first, second, GOOD], journal });
    assert.equal(run.llm.calls.length, 2);
    assert.deepEqual(texts(run), []);
    const result = asRecord(run.result);
    assert.equal(result.outcome, 'skip');
    assert.equal(result.reason, 'think-leaked');
    assert.equal(turnRecord(lines).format.thinkLeaked, 2);
    assert.equal(turnRecord(lines).format.leakEnded, 1);
  });
}

// Bug: the turn ends in silence and she never learns her answer was lost (no silent failure).
test('a turn ended by a leak leaves her a fact for her next request', async () => {
  const run = await coreTurn({ answers: [UNOPENED, UNOPENED, GOOD] });
  const header = labels.wake.feedbackInTurn;
  assert.equal(requestText(run.llm, 0).includes(header), false);
  await run.again();
  assert.equal(requestText(run.llm, 2).includes(header), true);
});

// Bug: a leak on a later step sends nothing more but never ends the loop, or takes back what already went out.
test('two leaks after a post end the turn with the post standing and no third answer', async () => {
  const { journal, lines } = journalOverMemory();
  const run = await coreTurn({
    answers: [toolAnswer('<think>α</think><msg>πρώτο</msg>', [call('lore.list')]), UNOPENED, UNCLOSED, GOOD],
    journal,
    // A read holds the speech of its answer back; the post is a call of its own.
    allowed: ['lore.list', 'message.create'],
  });
  assert.equal(run.llm.calls.length, 3);
  assert.equal(texts(run).includes('ναι'), false);
  for (const text of texts(run)) assert.equal(TAG.test(text), false);
  assert.equal(turnRecord(lines).format.leakEnded, 1);
});

// Bug: the count is not kept apart per turn, so an inner turn's lost answer never reaches the watcher.
test('two leaks in an inner turn send nothing and post no lowered call', async () => {
  const run = await coreTurn({ ...INNER, answers: [UNOPENED, UNCLOSED, GOOD] });
  assert.equal(run.llm.calls.length, 2);
  assert.deepEqual(texts(run), []);
  assert.deepEqual(called(run), []);
});

// ---------- a tag in outgoing text ----------

for (const text of ['γεια <think>σκέψη</think>', 'γεια </think>', '<THINK>γεια']) {
  // Bug: the posting tool is a second way out, and its text never passed the parser.
  test(`message.create refuses the text ${text} rather than sending or editing it`, async () => {
    const { journal, lines } = journalOverMemory();
    const run = await coreTurn({
      answers: [toolAnswer('<think>α</think>', [call('message.create', { text })]), GOOD],
      allowed: ['message.create'],
      journal,
    });
    assert.deepEqual(texts(run), ['ναι'], 'the call sent nothing, and her next answer did');
    assert.equal(turnRecord(lines).format.tagInOutgoing, 1);
    const result = appended(run.llm, 1).find((message) => message.role === 'tool');
    assert.ok(result, 'she reads what happened to the call');
  });
}

// Bug: an inner turn's post has its own path past the speech checks.
test('an inner turn refuses a post whose text holds a think tag', async () => {
  const run = await coreTurn({
    ...INNER,
    answers: [
      toolAnswer('<think>α</think>', [call('message.create', { text: 'γεια <think>σκέψη</think>' })]),
      '<skip/>',
    ],
  });
  for (const text of texts(run)) assert.equal(TAG.test(text), false, text);
  assert.deepEqual(texts(run), []);
});

// ---------- the language of a think ----------

// Bug: a think in another script goes unnoticed, and the pronouns that follow from it reach her replies.
test('a think mostly in another script is counted at write and the answer still goes out', async () => {
  const { journal, lines } = journalOverMemory();
  const run = await coreTurn({ answers: ['<think>Θα απαντήσω σύντομα στην ερώτηση</think><msg>ναι</msg>'], journal });
  assert.deepEqual(texts(run), ['ναι']);
  assert.equal(turnRecord(lines).format.thinkOffScript, 1);
});

// Bug: the quoted chat every think holds counts against it.
test('a think in English that quotes the chat is not counted', async () => {
  const { journal, lines } = journalOverMemory();
  await coreTurn({
    answers: ['<think>She wrote "γεια σου τι κάνεις", so I greet her back.</think><msg>γεια</msg>'],
    journal,
  });
  assert.equal(turnRecord(lines).format.thinkOffScript, 0);
});
