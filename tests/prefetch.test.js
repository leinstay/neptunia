// Tests for src/behavior/prefetch.js: the pure core of the automatic memory prefetch -- when it
// runs, which triggers are trivial, the query lanes, the lexical plan of a lane, what counts as
// relevant, the fusion and deduplication across lanes, and the caps. No I/O.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fitExcerpts, isTrivialTrigger, lanePlan, lexicalRelevance, prefetchLanes, prefetchOn, quotedPhrases, rankPrefetch } from '../src/behavior/prefetch.js';
import { recallSettings } from '../src/behavior/recall.js';

const SETTINGS = { ...recallSettings({}).prefetch, trivial: ['hi', 'ok', 'thanks', 'good night'], deictic: ['that', 'this'], shortWords: 4, contextLines: 3, contextTokens: 500 };

function msg(id, content, { authorName = 'Ana', authorId = 'u1', self = false, bot = false, ts = 1000, replyToId = null } = {}) {
  return { id, channelId: 'c1', authorId, authorName, self, bot, content, ts, replyToId };
}

test('prefetchOn: only with features.coreTools exactly true; features.memoryPrefetch false or recall off closes it', () => {
  assert.equal(prefetchOn({ features: {} }), false, 'the tool loop off: every turn as before');
  assert.equal(prefetchOn({ features: { coreTools: 'yes' } }), false);
  assert.equal(prefetchOn({ features: { coreTools: true } }), true, 'a missing memoryPrefetch counts as on');
  assert.equal(prefetchOn({ features: { coreTools: true, memoryPrefetch: false } }), false);
  assert.equal(prefetchOn({ features: { coreTools: true, recall: false } }), false);
});

test('isTrivialTrigger: empty, a command, only her name or emoji, a bare greeting; a short catchphrase is not', () => {
  const opts = { trivial: SETTINGS.trivial, selfNames: ['Zoë'] };
  for (const text of ['', '   ', '<@123456789012345678>', '/nep status', '!ping', '?!', 'zoe', 'Zoë, hi!', 'OK', 'thanks!!', 'Good   Night']) {
    assert.equal(isTrivialTrigger(text, opts), true, text);
  }
  for (const text of ['plus ultra', 'ok but why', 'hi there, remember the dog?', 'κουνέλι']) {
    assert.equal(isTrivialTrigger(text, opts), false, text);
  }
});

test('quotedPhrases: phrases between quote pairs, lowercased, each once, at most three', () => {
  assert.deepEqual(quotedPhrases('he said "Plus Ultra" and «το δάσος», then "plus ultra" again'), ['plus ultra', 'το δάσος']);
  assert.deepEqual(quotedPhrases("it's 'the forest and the dog' picture"), ['the forest and the dog']);
  assert.deepEqual(quotedPhrases('no quotes here'), []);
});

test('prefetchLanes: the trigger verbatim; with its replied-to line speaker by speaker; a short or deictic one with the lines before it', () => {
  const history = [
    msg('a', 'το δάσος και ο σκύλος', { authorName: 'Éloïse', authorId: 'u2' }),
    msg('b', 'Birthdays!', { bot: true, authorName: 'Bot' }),
    msg('c', 'ναι το θυμάμαι', { self: true }),
    msg('d', 'what did he mean?', { authorName: 'Nikos', authorId: 'u3', replyToId: 'a' }),
  ];
  const { lanes, skip } = prefetchLanes({ trigger: history[3], history, settings: SETTINGS, selfName: 'Zoë' });
  assert.equal(skip, null);
  assert.deepEqual(lanes.map((lane) => lane.kind), ['message', 'reply', 'recent']);
  assert.equal(lanes[0].text, 'what did he mean?');
  assert.equal(lanes[1].text, 'Éloïse: το δάσος και ο σκύλος\nNikos: what did he mean?');
  assert.equal(lanes[1].words, 'το δάσος και ο σκύλος\nwhat did he mean?', 'no speaker names in the lexical words');
  assert.equal(lanes[2].text, 'Zoë: ναι το θυμάμαι\nNikos: what did he mean?', 'not the replied line again, not another bot');
  // A long trigger: no recent lane.
  const long = msg('e', 'tell me again about that long story we had with the forest and the dog');
  const longLanes = prefetchLanes({ trigger: long, history: [...history, long], settings: { ...SETTINGS, deictic: [] }, selfName: 'Zoë' }).lanes;
  assert.deepEqual(longLanes.map((lane) => lane.kind), ['message']);
  // A deictic word opens it whatever the length.
  assert.ok(prefetchLanes({ trigger: long, history: [...history, long], settings: SETTINGS, selfName: 'Zoë' }).lanes.some((lane) => lane.kind === 'recent'));
  // contextLines 0: none.
  assert.ok(!prefetchLanes({ trigger: history[3], history, settings: { ...SETTINGS, contextLines: 0 }, selfName: 'Zoë' }).lanes.some((lane) => lane.kind === 'recent'));
  // contextTokens bound the lines taken.
  const tight = prefetchLanes({ trigger: history[3], history, settings: { ...SETTINGS, contextTokens: 1 }, selfName: 'Zoë' }).lanes;
  assert.ok(!tight.some((lane) => lane.kind === 'recent'));
});

test('prefetchLanes: never for her own line, an errand result, a failed drawing, a diary post or a trivial trigger', () => {
  const t = msg('t', 'θυμάσαι το δάσος;');
  assert.equal(prefetchLanes({ trigger: null, settings: SETTINGS }).skip, 'no-trigger');
  assert.equal(prefetchLanes({ trigger: { ...t, self: true }, settings: SETTINGS }).skip, 'no-trigger');
  assert.equal(prefetchLanes({ trigger: t, selfId: 'u1', settings: SETTINGS }).skip, 'no-trigger');
  assert.equal(prefetchLanes({ trigger: t, triggerKind: 'task', settings: SETTINGS }).skip, 'not-external');
  assert.equal(prefetchLanes({ trigger: t, triggerKind: 'drawFailed', settings: SETTINGS }).skip, 'not-external');
  assert.equal(prefetchLanes({ trigger: t, mode: 'diary', settings: SETTINGS }).skip, 'not-external');
  assert.equal(prefetchLanes({ trigger: msg('t', 'ok'), settings: SETTINGS }).skip, 'trivial');
  // A split message's part: the part's text is the trigger.
  const part = prefetchLanes({ trigger: t, candidate: { ...t, content: 'και ο σκύλος;' }, history: [t], settings: SETTINGS });
  assert.equal(part.lanes[0].text, 'και ο σκύλος;');
});

test('lanePlan and lexicalRelevance: long words and stored names as forms, a short trigger as a phrase; a name alone is not relevant', () => {
  const profiles = [{ id: 'u2', names: ['Éloïse'], aliases: [] }];
  const plan = lanePlan({ kind: 'message', words: 'Éloïse, η ζωγραφιά με το δάσος και τον σκύλο' }, { profiles, trigger: 'Éloïse, η ζωγραφιά με το δάσος και τον σκύλο' });
  assert.deepEqual(plan.who, ['éloïse']);
  assert.deepEqual(plan.forms, ['ζωγραφιά', 'δάσος', 'σκύλο']);
  assert.equal(plan.need, 2);
  assert.deepEqual(lexicalRelevance({ content: 'η ζωγραφιά με τον σκύλο της' }, plan), { relevant: true, matched: 2, phrase: false }, 'word endings allowed');
  assert.equal(lexicalRelevance({ content: 'ο σκύλος έφαγε' }, plan).relevant, false, 'one form of three');
  assert.equal(lexicalRelevance({ content: 'Éloïse said hi' }, plan).relevant, false, 'a name alone only locates');
  const short = lanePlan({ kind: 'message', words: 'plus ultra' }, { trigger: 'plus ultra' });
  assert.deepEqual([short.phrases, short.forms, short.need], [['plus ultra'], ['ultra'], 1]);
  assert.deepEqual(lexicalRelevance({ content: 'PLUS ULTRA!' }, short), { relevant: true, matched: 1, phrase: true });
  assert.equal(lanePlan({ kind: 'reply', words: 'a b' }, { trigger: 'a b' }), null, 'nothing to search');
});

test('rankPrefetch: lanes fused by rank, windows sharing a line merged into one excerpt, marked with relevant hits only; stored items deduplicated', () => {
  const order = ['a1', 'a2', 'a3', 'a4', 'b1', 'b2', 'z1'];
  const w = (ids, hitIds, channelId = 'c2') => ({ channelId, channelName: 'garden', messages: ids.map((id) => ({ id, ts: order.indexOf(id) })), hitIds: new Set(hitIds) });
  const lanes = [
    { windows: [w(['a1', 'a2', 'a3'], ['a2', 'a3']), w(['b1', 'b2'], ['b2'])], lexical: ['a2', 'b2'] },
    { windows: [w(['a3', 'a4'], ['a3'])], meaning: ['a3'] },
    { memory: [{ kind: 'episode', itemId: 'ep1', text: 'x' }] },
    { memory: [{ kind: 'episode', itemId: 'ep1', text: 'x' }, { kind: 'lore', itemId: null, text: 'y' }] },
    { windows: [w(['z1'], ['z1'])], lexical: [] },
  ];
  const units = rankPrefetch(lanes);
  const history = units.filter((unit) => unit.kind === 'history');
  assert.equal(history.length, 2, 'the two windows sharing a3 are one; a window with no relevant hit is dropped');
  assert.deepEqual(history[0].window.messages.map((m) => m.id), ['a1', 'a2', 'a3', 'a4']);
  assert.deepEqual([...history[0].window.hitIds].sort(), ['a2', 'a3']);
  assert.equal(history[0].hitIds[0], 'a2', 'its best hit first');
  assert.deepEqual(units.filter((unit) => unit.kind === 'memory').map((unit) => unit.item.itemId), ['ep1', null], 'one copy per item');
  assert.ok(units.every((unit, i) => i === 0 || units[i - 1].rank <= unit.rank), 'best first');
});

test('fitExcerpts: at most maxExcerpts, within maxTokens; one that does not fit is skipped and the next tried', () => {
  const big = { text: 'x'.repeat(4000) };
  const small = (n) => ({ text: `line ${n}` });
  assert.deepEqual(fitExcerpts([small(1), big, small(2), small(3)], { maxExcerpts: 2, maxTokens: 100 }), [small(1), small(2)]);
  assert.deepEqual(fitExcerpts([big], { maxExcerpts: 5, maxTokens: 100 }), [], 'zero excerpts allowed');
});
