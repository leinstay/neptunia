// Tests for src/behavior/mention.js: whether/how the persona was called, and
// whether it reacts to it at all.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  detectTrigger,
  strippedLength,
  createTagHistory,
  decideMention,
  isFollowUpOpen,
  followUpPreFilter,
  deprecatedModelKeys,
  parseFollowUpVerdict,
  parseAddressAnswer,
  followUpTriggerKind,
  isTaggedCall,
  roomPreFilter,
} from '../src/behavior/mention.js';
import { ROLE_DEFAULTS, roleModel } from '../src/llm/roles.js';

const shipped = JSON.parse(fs.readFileSync(new URL('../config.json', import.meta.url), 'utf8'));
const NAME_TRIGGERS = ['νεπτούνια'];

// --- detectTrigger ----------------------------------------------------------

test('detectTrigger: a reply takes priority over a mention', () => {
  const kind = detectTrigger({ mentionsSelf: true, repliesToSelf: true, content: '', nameTriggers: NAME_TRIGGERS });
  assert.equal(kind, 'reply');
});

test('detectTrigger: a mention takes priority over a name match', () => {
  const kind = detectTrigger({
    mentionsSelf: true,
    repliesToSelf: false,
    content: 'νεπτούνια γεια',
    nameTriggers: NAME_TRIGGERS,
  });
  assert.equal(kind, 'mention');
});

test('detectTrigger: falls back to a name match when neither reply nor mention', () => {
  const kind = detectTrigger({
    mentionsSelf: false,
    repliesToSelf: false,
    content: 'έι νεπτούνια πώς είσαι',
    nameTriggers: NAME_TRIGGERS,
  });
  assert.equal(kind, 'name');
});

test('detectTrigger: name matching is case-insensitive', () => {
  const kind = detectTrigger({
    mentionsSelf: false,
    repliesToSelf: false,
    content: 'ΕΙ ΝΕΠΤΟΎΝΙΑ ΤΙ ΓΙΝΕΤΑΙ',
    nameTriggers: NAME_TRIGGERS,
  });
  assert.equal(kind, 'name');
});

test('detectTrigger: only matches whole words, not a substring inside a longer word', () => {
  const kind = detectTrigger({
    mentionsSelf: false,
    repliesToSelf: false,
    content: 'νεπτούνιαπου ακατανόητο εντελώς',
    nameTriggers: NAME_TRIGGERS,
  });
  assert.equal(kind, null);
});

test('detectTrigger: whole-word matching works with non-Latin word boundaries (punctuation)', () => {
  const kind = detectTrigger({
    mentionsSelf: false,
    repliesToSelf: false,
    content: 'άκου, νεπτούνια, είσαι εδώ;',
    nameTriggers: NAME_TRIGGERS,
  });
  assert.equal(kind, 'name');
});

test('detectTrigger: an empty name trigger matches nothing, an attachment-only message included', () => {
  for (const content of ['', 'απλή κουβέντα']) {
    const kind = detectTrigger({ mentionsSelf: false, repliesToSelf: false, content, nameTriggers: [''] });
    assert.equal(kind, null, `content "${content}"`);
  }
});

// --- strippedLength -----------------------------------------------------------

test('strippedLength: a bare @name mention leaves nothing', () => {
  assert.equal(strippedLength('@Νεπτούνια', 'Νεπτούνια'), 0);
});

test('strippedLength: a bare Discord <@id> mention leaves nothing', () => {
  assert.equal(strippedLength('<@123456>', 'Νεπτούνια'), 0);
});

test('strippedLength: counts the remaining text after removing the mention', () => {
  assert.equal(strippedLength('@Νεπτούνια πώς είσαι;', 'Νεπτούνια'), 'πώς είσαι;'.length);
});

// --- createTagHistory -----------------------------------------------------------

test('createTagHistory: counts hits within the window, this call included', () => {
  const history = createTagHistory();
  assert.equal(history.hit('u1', 1000, 60_000), 1);
  assert.equal(history.hit('u1', 2000, 60_000), 2);
  assert.equal(history.hit('u1', 3000, 60_000), 3);
});

test('createTagHistory: hits outside the window age out', () => {
  const history = createTagHistory();
  history.hit('u1', 0, 1000);
  assert.equal(history.hit('u1', 5000, 1000), 1); // the first hit is long gone
});

test('createTagHistory: tracks different users independently', () => {
  const history = createTagHistory();
  history.hit('u1', 0, 60_000);
  assert.equal(history.hit('u2', 100, 60_000), 1);
});

// --- decideMention -----------------------------------------------------------

const CFG = {
  ignoreChance: 0.12,
  emptyMentionIgnoreChance: 0.35,
  repeatPenalty: 0.25,
  spamThreshold: 4,
  spamIgnoreChance: 0.9,
  nameTriggerChance: 0.5,
  affinityIgnoreBonus: 0.3,
  affinityLikeBonus: 0.08,
};

function rngReturning(value) {
  return () => value;
}

test('decideMention: neverIgnore always responds regardless of rng', () => {
  const result = decideMention({
    kind: 'mention',
    textLength: 0,
    recentCalls: 10,
    neverIgnore: true,
    cfg: CFG,
    rng: rngReturning(0.999),
  });
  assert.deepEqual(result, { respond: true, reason: 'never-ignore', ignoreChance: 0 });
});

test('decideMention: name trigger responds based on nameTriggerChance', () => {
  const respond = decideMention({ kind: 'name', textLength: 5, recentCalls: 1, neverIgnore: false, cfg: CFG, rng: rngReturning(0.4) });
  assert.equal(respond.respond, true); // 0.4 < 0.5
  assert.equal(respond.reason, 'name');

  const ignore = decideMention({ kind: 'name', textLength: 5, recentCalls: 1, neverIgnore: false, cfg: CFG, rng: rngReturning(0.6) });
  assert.equal(ignore.respond, false); // 0.6 >= 0.5
  assert.equal(ignore.reason, 'name-unnoticed');
  assert.equal(ignore.ignoreChance, 0.5);
});

test('decideMention: a bare ping (mention, empty text) uses emptyMentionIgnoreChance', () => {
  const result = decideMention({ kind: 'mention', textLength: 0, recentCalls: 1, neverIgnore: false, cfg: CFG, rng: rngReturning(0.5) });
  assert.equal(result.ignoreChance, CFG.emptyMentionIgnoreChance);
  assert.equal(result.reason, 'respond'); // rng 0.5 >= 0.35
});

test('decideMention: repeat calls accumulate a penalty on top of the base ignore chance', () => {
  // kind 'reply', textLength > 0 -> base ignoreChance, recentCalls=3 adds repeatPenalty*(3-1)
  const result = decideMention({ kind: 'reply', textLength: 5, recentCalls: 3, neverIgnore: false, cfg: CFG, rng: rngReturning(0) });
  const expected = CFG.ignoreChance + CFG.repeatPenalty * 2;
  assert.equal(result.ignoreChance, expected);
  assert.equal(result.reason, 'ignored:repeat'); // rng 0 < ignoreChance -> ignored
});

test('decideMention: spam threshold overrides the ignore chance entirely (not additive)', () => {
  const result = decideMention({ kind: 'reply', textLength: 5, recentCalls: 4, neverIgnore: false, cfg: CFG, rng: rngReturning(0) });
  assert.equal(result.ignoreChance, CFG.spamIgnoreChance);
  assert.equal(result.reason, 'ignored:spam'); // rng 0 < 0.9 -> ignored
});

test('decideMention: the ignore chance is clamped to 0.97 at most', () => {
  // A high spamThreshold keeps this in the repeat-penalty branch instead of the spam branch.
  const cfg = { ...CFG, ignoreChance: 0.9, repeatPenalty: 0.5, spamThreshold: 1000 };
  const result = decideMention({ kind: 'reply', textLength: 5, recentCalls: 10, neverIgnore: false, cfg, rng: rngReturning(0.98) });
  assert.equal(result.ignoreChance, 0.97);
  assert.equal(result.respond, true); // rng 0.98 >= 0.97
  assert.equal(result.reason, 'respond'); // a repeat call that still gets through
});

test('decideMention: the ignore chance never drops below 0', () => {
  const cfg = { ...CFG, ignoreChance: -5 };
  const result = decideMention({ kind: 'reply', textLength: 5, recentCalls: 1, neverIgnore: false, cfg, rng: rngReturning(0.001) });
  assert.equal(result.ignoreChance, 0);
  assert.equal(result.respond, true);
});

test('decideMention: plain random ignore uses the base ignoreChance for a non-empty mention/reply', () => {
  const result = decideMention({ kind: 'reply', textLength: 5, recentCalls: 1, neverIgnore: false, cfg: CFG, rng: rngReturning(0) });
  assert.equal(result.ignoreChance, CFG.ignoreChance);
  assert.equal(result.reason, 'ignored:random');
  assert.equal(result.respond, false); // rng 0 < 0.12
});

// --- decideMention: follow-ups (mention.followUpIgnoreChance) ----------------

/** One decideMention call with no repeat, spam, affinity or neverIgnore in play. */
function decideOnce(kind, cfg, roll, extra = {}) {
  return decideMention({ kind, textLength: 5, recentCalls: 1, neverIgnore: false, cfg, rng: rngReturning(roll), ...extra });
}

test('decideMention: a followUp starts from followUpIgnoreChance, not ignoreChance', () => {
  const ignored = decideOnce('followUp', { ...CFG, ignoreChance: 0, followUpIgnoreChance: 1 }, 0.5);
  assert.equal(ignored.respond, false);
  assert.equal(ignored.ignoreChance, 0.97, 'clamped like any other chance');
  assert.equal(ignored.reason, 'ignored:follow-up');

  const answered = decideOnce('followUp', { ...CFG, ignoreChance: 1, followUpIgnoreChance: 0 }, 0);
  assert.equal(answered.respond, true);
  assert.equal(answered.ignoreChance, 0);
  assert.equal(answered.reason, 'respond');
});

test('decideMention: an untagged reply starts from followUpIgnoreChance; a tagged or unspecified one from ignoreChance', () => {
  const cfg = { ...CFG, ignoreChance: 0, followUpIgnoreChance: 1 };
  const untagged = decideOnce('reply', cfg, 0.5, { tagged: false });
  assert.deepEqual([untagged.respond, untagged.reason], [false, 'ignored:follow-up']);
  for (const tagged of [true, undefined]) {
    const result = decideOnce('reply', cfg, 0.5, { tagged });
    assert.deepEqual([result.respond, result.ignoreChance], [true, 0], `tagged ${tagged}`);
  }
});

test('decideMention: a mention is unaffected by followUpIgnoreChance, tagged or not', () => {
  for (const tagged of [true, false, undefined]) {
    const result = decideOnce('mention', { ...CFG, ignoreChance: 0, followUpIgnoreChance: 1 }, 0.5, { tagged });
    assert.deepEqual([result.respond, result.ignoreChance, result.reason], [true, 0, 'respond'], `tagged ${tagged}`);
  }
});

test('decideMention: a missing followUpIgnoreChance counts as 0 for a followUp and an untagged reply', () => {
  const cfg = { ...CFG, ignoreChance: 0.5 };
  delete cfg.followUpIgnoreChance;
  for (const [kind, tagged] of [['followUp', undefined], ['reply', false]]) {
    const result = decideOnce(kind, cfg, 0, { tagged });
    assert.deepEqual([result.respond, result.ignoreChance], [true, 0], kind);
  }
});

test('decideMention: the affinity adjustment applies on top of followUpIgnoreChance', () => {
  const cfg = { ...CFG, ignoreChance: 0, followUpIgnoreChance: 0.2, affinityIgnoreBonus: 0.3, affinityLikeBonus: 0.1 };
  const disliked = decideOnce('followUp', cfg, 0.4, { affinityScore: -100 });
  assert.ok(Math.abs(disliked.ignoreChance - 0.5) < 1e-9, String(disliked.ignoreChance));
  assert.equal(disliked.respond, false);
  const liked = decideOnce('followUp', cfg, 0.15, { affinityScore: 100 });
  assert.ok(Math.abs(liked.ignoreChance - 0.1) < 1e-9, String(liked.ignoreChance));
  assert.equal(liked.respond, true);
});

test('isTaggedCall: a typed tag counts, the reply ping alone does not', () => {
  assert.equal(isTaggedCall({ mentionedUserIds: ['s1'], replyPingUserId: null }, 's1'), true);
  assert.equal(isTaggedCall({ mentionedUserIds: ['s1'], replyPingUserId: 's1' }, 's1'), false);
  assert.equal(isTaggedCall({ mentionedUserIds: ['u2'], replyPingUserId: null }, 's1'), false);
  assert.equal(isTaggedCall({}, 's1'), false);
});

// --- decideMention: affinityScore -------------------------------------------

test('decideMention: a disliked caller (negative affinity) raises the ignore chance', () => {
  const neutral = decideMention({ kind: 'reply', textLength: 5, recentCalls: 1, neverIgnore: false, cfg: CFG, rng: rngReturning(0) });
  const disliked = decideMention({
    kind: 'reply',
    textLength: 5,
    recentCalls: 1,
    neverIgnore: false,
    affinityScore: -100,
    cfg: CFG,
    rng: rngReturning(0),
  });
  assert.equal(disliked.ignoreChance, neutral.ignoreChance + CFG.affinityIgnoreBonus);
});

test('decideMention: a liked caller (positive affinity) lowers the ignore chance', () => {
  const neutral = decideMention({ kind: 'reply', textLength: 5, recentCalls: 1, neverIgnore: false, cfg: CFG, rng: rngReturning(0) });
  const liked = decideMention({
    kind: 'reply',
    textLength: 5,
    recentCalls: 1,
    neverIgnore: false,
    affinityScore: 100,
    cfg: CFG,
    rng: rngReturning(0),
  });
  assert.equal(liked.ignoreChance, neutral.ignoreChance - CFG.affinityLikeBonus);
});

test('decideMention: affinityScore is ignored for neverIgnore', () => {
  const result = decideMention({
    kind: 'reply',
    textLength: 5,
    recentCalls: 1,
    neverIgnore: true,
    affinityScore: -100,
    cfg: CFG,
    rng: rngReturning(0.999),
  });
  assert.deepEqual(result, { respond: true, reason: 'never-ignore', ignoreChance: 0 });
});

test('decideMention: affinityScore is ignored for the "name" kind', () => {
  const withAffinity = decideMention({
    kind: 'name',
    textLength: 5,
    recentCalls: 1,
    neverIgnore: false,
    affinityScore: -100,
    cfg: CFG,
    rng: rngReturning(0.4),
  });
  const withoutAffinity = decideMention({ kind: 'name', textLength: 5, recentCalls: 1, neverIgnore: false, cfg: CFG, rng: rngReturning(0.4) });
  assert.deepEqual(withAffinity, withoutAffinity);
});

// --- The address classifier: isFollowUpOpen / followUpPreFilter / parseFollowUpVerdict --

const FOLLOW_UP_CFG = { followUpMinutes: 2, followUpNoStreak: 3 };

test('isFollowUpOpen: false when there is no window at all', () => {
  assert.equal(isFollowUpOpen(null, 1000, FOLLOW_UP_CFG), false);
  assert.equal(isFollowUpOpen(undefined, 1000, FOLLOW_UP_CFG), false);
});

test('isFollowUpOpen: false once followUpMinutes has passed since the last answer', () => {
  const state = { openedAt: 1000, lastAnswerAt: 1000, noStreak: 0 };
  assert.equal(isFollowUpOpen(state, 1000 + 2 * 60_000, FOLLOW_UP_CFG), false);
});

test('isFollowUpOpen: false once noStreak reaches followUpNoStreak, even if still fresh', () => {
  const state = { openedAt: 1000, lastAnswerAt: 1000, noStreak: 3 };
  assert.equal(isFollowUpOpen(state, 1000, FOLLOW_UP_CFG), false);
});

test('isFollowUpOpen: true just below the noStreak cap', () => {
  const state = { openedAt: 1000, lastAnswerAt: 1000, noStreak: 2 };
  assert.equal(isFollowUpOpen(state, 1000, FOLLOW_UP_CFG), true);
});

test('isFollowUpOpen: the code fallbacks equal the config.json window and streak', () => {
  const windowMs = shipped.mention.followUpMinutes * 60_000;
  const fresh = { openedAt: 0, lastAnswerAt: 0, noStreak: 0 };
  assert.equal(isFollowUpOpen(fresh, windowMs - 1, {}), true);
  assert.equal(isFollowUpOpen(fresh, windowMs, {}), false);
  const streak = shipped.mention.followUpNoStreak;
  assert.equal(isFollowUpOpen({ ...fresh, noStreak: streak - 1 }, 0, {}), true);
  assert.equal(isFollowUpOpen({ ...fresh, noStreak: streak }, 0, {}), false);
});

test('followUpPreFilter: a reply to another member reaches the classifier', () => {
  const normalized = { replyToId: 'm100', mentionedUserIds: [], replyPingUserId: null };
  assert.equal(followUpPreFilter(normalized, 'self1'), false);
  assert.equal(followUpPreFilter(normalized, 'self1', { followUpClassifyReplies: true }), false);
});

test('followUpPreFilter: a reply whose only mention is the implicit reply ping reaches the classifier', () => {
  const normalized = { replyToId: 'm100', mentionedUserIds: ['u2'], replyPingUserId: 'u2' };
  assert.equal(followUpPreFilter(normalized, 'self1'), false);
});

test('followUpPreFilter: a reply that also mentions a third member explicitly is "no" material', () => {
  const normalized = { replyToId: 'm100', mentionedUserIds: ['u2', 'u3'], replyPingUserId: 'u2' };
  assert.equal(followUpPreFilter(normalized, 'self1'), true);
});

test('followUpPreFilter: followUpClassifyReplies=false pre-filters any reply, as before', () => {
  const cfg = { followUpClassifyReplies: false };
  assert.equal(followUpPreFilter({ replyToId: 'm100', mentionedUserIds: [], replyPingUserId: null }, 'self1', cfg), true);
  assert.equal(followUpPreFilter({ replyToId: 'm100', mentionedUserIds: ['u2'], replyPingUserId: 'u2' }, 'self1', cfg), true);
});

test('followUpPreFilter: the reply-ping exemption only applies to a reply', () => {
  const normalized = { replyToId: null, mentionedUserIds: ['u2'], replyPingUserId: 'u2' };
  assert.equal(followUpPreFilter(normalized, 'self1'), true);
});

test('followUpPreFilter: a mention of the persona itself does not pre-filter', () => {
  const normalized = { replyToId: null, mentionedUserIds: ['self1'] };
  assert.equal(followUpPreFilter(normalized, 'self1'), false);
});

test('followUpPreFilter: mentionedUserIds omitted is treated as empty', () => {
  const rows = [
    ['plain text with no reply and no mention reaches the model', { replyToId: null, mentionedUserIds: [] }],
    ['mentionedUserIds omitted is treated as empty', { replyToId: null }],
  ];
  for (const [label, normalized] of rows) {
    assert.equal(followUpPreFilter(normalized, 'self1'), false, label);
  }
});

test('parseFollowUpVerdict: case-insensitive and tolerates surrounding text/whitespace', () => {
  assert.equal(parseFollowUpVerdict('  Yes, obviously.'), 'yes');
  assert.equal(parseFollowUpVerdict('YES'), 'yes');
});

test('parseFollowUpVerdict: "no" and anything else is a no', () => {
  assert.equal(parseFollowUpVerdict('no'), 'no');
  assert.equal(parseFollowUpVerdict('No.'), 'no');
  assert.equal(parseFollowUpVerdict('not sure'), 'no');
  assert.equal(parseFollowUpVerdict(''), 'no');
  assert.equal(parseFollowUpVerdict(null), 'no');
  assert.equal(parseFollowUpVerdict(undefined), 'no');
});

test('parseAddressAnswer: a first word starting with "y" is yes, any case, surrounding text tolerated', () => {
  for (const text of ['yes', '  Yes, obviously.', 'YES', 'yeah', 'y']) {
    assert.equal(parseAddressAnswer(text), 'yes', JSON.stringify(text));
  }
});

test('parseAddressAnswer: the first word "overheard", any case, trailing punctuation allowed, is overheard', () => {
  for (const text of ['overheard', 'Overheard.', 'OVERHEARD', ' overheard ', 'Overheard, she is talked about', 'overheard!']) {
    assert.equal(parseAddressAnswer(text), 'overheard', JSON.stringify(text));
  }
});

test('parseAddressAnswer: everything else, empty included, is no; no markup is stripped', () => {
  for (const text of ['no', 'No.', 'not sure', '', '   ', null, undefined, 'overhear', 'overheardx', 'absolutely', 'about', '"overheard"', '**overheard**', '"yes"', '**yes**']) {
    assert.equal(parseAddressAnswer(text), 'no', JSON.stringify(text));
  }
});

test('parseFollowUpVerdict: an overheard answer counts as yes', () => {
  for (const text of ['overheard', 'Overheard.', 'OVERHEARD']) {
    assert.equal(parseFollowUpVerdict(text), 'yes', text);
  }
});

test('followUpTriggerKind: no starts nothing, yes a followUp turn, overheard an overheard turn', () => {
  const cfg = { followUpOverheard: true };
  assert.equal(followUpTriggerKind('no', cfg), null);
  assert.equal(followUpTriggerKind('yes', cfg), 'followUp');
  assert.equal(followUpTriggerKind('overheard', cfg), 'overheard');
});

test('followUpTriggerKind: with mention.followUpOverheard false an overheard answer starts a plain followUp turn', () => {
  assert.equal(followUpTriggerKind('overheard', { followUpOverheard: false }), 'followUp');
  assert.equal(followUpTriggerKind('yes', { followUpOverheard: false }), 'followUp');
  assert.equal(followUpTriggerKind('no', { followUpOverheard: false }), null);
});

test('followUpTriggerKind: a missing config or key counts as on', () => {
  assert.equal(followUpTriggerKind('overheard'), 'overheard');
  assert.equal(followUpTriggerKind('overheard', undefined), 'overheard');
  assert.equal(followUpTriggerKind('overheard', {}), 'overheard');
  assert.equal(followUpTriggerKind('overheard', { followUpOverheard: undefined }), 'overheard');
});

test('decideMention: affinityScore is ignored inside the spam branch', () => {
  const withAffinity = decideMention({
    kind: 'reply',
    textLength: 5,
    recentCalls: 4,
    neverIgnore: false,
    affinityScore: -100,
    cfg: CFG,
    rng: rngReturning(0),
  });
  const withoutAffinity = decideMention({ kind: 'reply', textLength: 5, recentCalls: 4, neverIgnore: false, cfg: CFG, rng: rngReturning(0) });
  assert.equal(withAffinity.ignoreChance, withoutAffinity.ignoreChance);
  assert.equal(withAffinity.ignoreChance, CFG.spamIgnoreChance);
});

const OLD_KEYS = {
  llm: { classifierModel: 'x/llm-classifier' },
  mention: { followUpModel: 'x/old' },
  media: { model: 'x/old-media', video: { model: 'x/old-video' } },
};

test('roleModel: the deprecated llm.classifierModel, mention.followUpModel, media.model and media.video.model are ignored', () => {
  for (const role of ['analyzer', 'reasoner', 'vision', 'video']) {
    assert.equal(roleModel(OLD_KEYS, role), ROLE_DEFAULTS[role], role);
    assert.equal(roleModel({ ...OLD_KEYS, models: { base: { [role]: 'x/new' } } }, role), 'x/new', role);
  }
});

test('deprecatedModelKeys: each old model key that is set, with its replacement, in a fixed order', () => {
  assert.deepEqual(deprecatedModelKeys(OLD_KEYS), [
    { key: 'llm.classifierModel', use: 'models.base.analyzer' },
    { key: 'mention.followUpModel', use: 'models.base.analyzer' },
    { key: 'media.model', use: 'models.base.vision' },
    { key: 'media.video.model', use: 'models.base.video' },
  ]);
  assert.deepEqual(deprecatedModelKeys({ media: { video: { model: 'x/v' } }, models: { base: { voice: 'x/talk' } } }), [
    { key: 'media.video.model', use: 'models.base.video' },
  ]);
});

test('deprecatedModelKeys: none for a current config, a null old key or no config', () => {
  assert.deepEqual(deprecatedModelKeys({ models: { base: { analyzer: 'a', vision: 'b', video: 'c', voice: 'x' } }, media: { maxPerTurn: 6 } }), []);
  assert.deepEqual(deprecatedModelKeys({ llm: { classifierModel: null }, mention: {} }), []);
  assert.deepEqual(deprecatedModelKeys(undefined), []);
});

// --- Room questions: roomPreFilter ------------------------------------------

test('roomPreFilter: text with no reply and no member mention passes', () => {
  assert.equal(roomPreFilter({ content: 'ποιος έρχεται απόψε;', replyToId: null, mentionedUserIds: [] }), true);
  assert.equal(roomPreFilter({ content: '  quelqu\'un a vu le film ?  ', replyToId: null, mentionedUserIds: [] }), true);
  // A shape without a mention list is no mention.
  assert.equal(roomPreFilter({ content: 'καλημέρα σε όλους', replyToId: null }), true);
});

test('roomPreFilter: a reply or a member mention never passes', () => {
  assert.equal(roomPreFilter({ content: 'ναι, σωστά', replyToId: 'm100', mentionedUserIds: [] }), false);
  assert.equal(roomPreFilter({ content: 'έλα κι εσύ', replyToId: null, mentionedUserIds: ['u2'] }), false);
  assert.equal(roomPreFilter({ content: 'ναι', replyToId: 'm100', mentionedUserIds: ['u2'] }), false);
});

test('roomPreFilter: a message with no text never passes', () => {
  assert.equal(roomPreFilter({ content: '', replyToId: null, mentionedUserIds: [] }), false);
  assert.equal(roomPreFilter({ content: '   \n ', replyToId: null, mentionedUserIds: [] }), false);
  assert.equal(roomPreFilter({ replyToId: null, mentionedUserIds: [] }), false);
});
