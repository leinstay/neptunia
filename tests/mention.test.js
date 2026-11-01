// Tests for src/behavior/mention.js: whether/how the persona was called, and
// whether it reacts to it at all.
import { test } from 'node:test';
import assert from 'node:assert/strict';
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
} from '../src/behavior/mention.js';
import { ROLE_DEFAULTS, roleModel } from '../src/llm/roles.js';

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

function rngReturning(value) {
  return () => value;
}

test('decideMention: neverIgnore always responds regardless of rng', () => {
  const result = decideMention({ kind: 'mention', recentCalls: 60, neverIgnore: true, rng: rngReturning(0) });
  assert.deepEqual(result, { respond: true, reason: 'never-ignore', ignoreChance: 0 });
});

// PR 7d: `mention.nameTriggerChance` is the constant 1, so a name is always noticed.
test('decideMention: a name trigger is answered', () => {
  const result = decideMention({ kind: 'name', recentCalls: 1, neverIgnore: false, rng: rngReturning(0.99) });
  assert.deepEqual([result.respond, result.reason], [true, 'name']);
});

// PR 7d: the threshold (50 calls) and its ignore chance (0.9) are constants; no other ignore chance is left.
test('decideMention: the spam threshold sets the ignore chance; under it every call is answered', () => {
  const spam = decideMention({ kind: 'reply', recentCalls: 50, neverIgnore: false, rng: rngReturning(0) });
  assert.deepEqual([spam.ignoreChance, spam.reason], [0.9, 'ignored:spam']); // rng 0 < 0.9 -> ignored
  const under = decideMention({ kind: 'reply', recentCalls: 49, neverIgnore: false, rng: rngReturning(0) });
  assert.deepEqual([under.ignoreChance, under.respond], [0, true]);
});

test('isTaggedCall: a typed tag counts, the reply ping alone does not', () => {
  assert.equal(isTaggedCall({ mentionedUserIds: ['s1'], replyPingUserId: null }, 's1'), true);
  assert.equal(isTaggedCall({ mentionedUserIds: ['s1'], replyPingUserId: 's1' }, 's1'), false);
  assert.equal(isTaggedCall({ mentionedUserIds: ['u2'], replyPingUserId: null }, 's1'), false);
  assert.equal(isTaggedCall({}, 's1'), false);
});

// --- The address classifier: isFollowUpOpen / followUpPreFilter / parseFollowUpVerdict --

// PR 7d: the window (15 minutes) and the streak that closes it (5) are constants of src/behavior/mention.js.

test('isFollowUpOpen: false when there is no window at all', () => {
  assert.equal(isFollowUpOpen(null, 1000), false);
  assert.equal(isFollowUpOpen(undefined, 1000), false);
});

test('isFollowUpOpen: false once followUpMinutes has passed since the last answer', () => {
  const state = { openedAt: 1000, lastAnswerAt: 1000, noStreak: 0 };
  assert.equal(isFollowUpOpen(state, 1000 + 15 * 60_000), false);
});

test('isFollowUpOpen: false once noStreak reaches followUpNoStreak, even if still fresh', () => {
  const state = { openedAt: 1000, lastAnswerAt: 1000, noStreak: 5 };
  assert.equal(isFollowUpOpen(state, 1000), false);
});

test('isFollowUpOpen: true just below the noStreak cap', () => {
  const state = { openedAt: 1000, lastAnswerAt: 1000, noStreak: 4 };
  assert.equal(isFollowUpOpen(state, 1000), true);
});

test('followUpPreFilter: a reply to another member reaches the classifier', () => {
  const normalized = { replyToId: 'm100', mentionedUserIds: [], replyPingUserId: null };
  assert.equal(followUpPreFilter(normalized, 'self1'), false);
});

test('followUpPreFilter: a reply whose only mention is the implicit reply ping reaches the classifier', () => {
  const normalized = { replyToId: 'm100', mentionedUserIds: ['u2'], replyPingUserId: 'u2' };
  assert.equal(followUpPreFilter(normalized, 'self1'), false);
});

test('followUpPreFilter: a reply that also mentions a third member explicitly is "no" material', () => {
  const normalized = { replyToId: 'm100', mentionedUserIds: ['u2', 'u3'], replyPingUserId: 'u2' };
  assert.equal(followUpPreFilter(normalized, 'self1'), true);
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
  for (const text of [
    'overheard',
    'Overheard.',
    'OVERHEARD',
    ' overheard ',
    'Overheard, she is talked about',
    'overheard!',
  ]) {
    assert.equal(parseAddressAnswer(text), 'overheard', JSON.stringify(text));
  }
});

test('parseAddressAnswer: everything else, empty included, is no; no markup is stripped', () => {
  for (const text of [
    'no',
    'No.',
    'not sure',
    '',
    '   ',
    null,
    undefined,
    'overhear',
    'overheardx',
    'absolutely',
    'about',
    '"overheard"',
    '**overheard**',
    '"yes"',
    '**yes**',
  ]) {
    assert.equal(parseAddressAnswer(text), 'no', JSON.stringify(text));
  }
});

test('parseFollowUpVerdict: an overheard answer counts as yes', () => {
  for (const text of ['overheard', 'Overheard.', 'OVERHEARD']) {
    assert.equal(parseFollowUpVerdict(text), 'yes', text);
  }
});

test('followUpTriggerKind: no starts nothing, yes a followUp turn, overheard an overheard turn', () => {
  assert.equal(followUpTriggerKind('no'), null);
  assert.equal(followUpTriggerKind('yes'), 'followUp');
  assert.equal(followUpTriggerKind('overheard'), 'overheard');
});

const OLD_KEYS = {
  llm: { classifierModel: 'x/llm-classifier' },
  mention: { followUpModel: 'x/old' },
  media: { model: 'x/old-media', video: { model: 'x/old-video' } },
};

test('roleModel: the deprecated llm.classifierModel, mention.followUpModel, media.model and media.video.model are ignored', () => {
  for (const role of ['analyzer', 'vision', 'video']) {
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
  assert.deepEqual(deprecatedModelKeys({ media: { video: { model: 'x/v' } }, models: { base: { core: 'x/talk' } } }), [
    { key: 'media.video.model', use: 'models.base.video' },
  ]);
});

test('deprecatedModelKeys: none for a current config, a null old key or no config', () => {
  assert.deepEqual(
    deprecatedModelKeys({
      models: { base: { core: 'x', analyzer: 'a', vision: 'b', video: 'c' } },
      media: { maxPerTurn: 6 },
    }),
    []
  );
  assert.deepEqual(deprecatedModelKeys({ llm: { classifierModel: null }, mention: {} }), []);
  assert.deepEqual(deprecatedModelKeys(undefined), []);
});
