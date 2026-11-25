import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fill } from '../../../../src/format.ts';
import { estimateTokens } from '../../../../src/llm/tokens.ts';
import { labels } from '../../../fixtures/labels.ts';
import { renderProfile } from '../../../fixtures/profile-render.ts';

test('renderProfile: the avatar line under features.avatars, full and compact; an avatar alone is nothing learned', () => {
  const fox = { hash: 'h1', text: 'an illustrated fox in a scarf', describedAt: null };
  const line = fill(labels.profile.avatar, { text: fox.text });
  const profile = { id: 'u1', names: ['Ελένη'], character: 'curious', avatar: fox };
  assert.ok(!renderProfile(profile, labels, {}).includes(line), 'off unless asked');
  assert.equal(
    renderProfile(profile, labels, { avatars: true }),
    ['## Ελένη', line, fill(labels.profile.character, { text: 'curious' })].join('\n')
  );
  assert.ok(renderProfile(profile, labels, { avatars: true, compact: true }).includes(line));
  assert.ok(
    renderProfile({ ...profile, avatar: { hash: null, default: true } }, labels, { avatars: true }).includes(
      labels.profile.avatarDefault
    )
  );
  assert.equal(
    renderProfile({ ...profile, avatar: { hash: 'h1' } }, labels, { avatars: true }),
    renderProfile(profile, labels, {}),
    'a broken field shows nothing'
  );
  const bare = { id: 'u2', names: ['Ilse'], avatar: fox };
  assert.equal(renderProfile(bare, labels, { avatars: true }), '', 'nothing learned and no attitude: not shown');
  assert.equal(
    renderProfile(bare, labels, { avatars: true, interlocutor: true }),
    ['## Ilse', line, labels.profile.unknown].join('\n')
  );
  const unlabelled = { ...labels, profile: { ...labels.profile, avatar: undefined } };
  assert.ok(!renderProfile(profile, unlabelled, { avatars: true }).includes(fox.text), 'no label, no line');
});

test('renderProfile: a profile whose only content is an attitude is still rendered, by its heading alone', () => {
  const profile = { id: 'p1', names: ['Carl'], affinity: { score: -30, reason: 'annoying', history: [] } };
  assert.equal(renderProfile(profile, labels, { relationships: true, interlocutor: false }), '## Carl');
  assert.equal(renderProfile(profile, labels, { relationships: false }), '', 'without relationships: nothing to show');
});

test('renderProfile: a profile with no affinity at all (pre-relationships data) renders as before', () => {
  const profile = { id: 'p1', names: ['Carl'], character: 'calm' };
  assert.equal(renderProfile(profile, labels, { relationships: true }), '## Carl\ncharacter: calm');
});

// --- renderProfile: episodes --------------------------------------------------

function episodeFixture(overrides: Record<string, unknown> = {}) {
  return {
    date: '2026-01-01',
    what: 'said something memorable',
    quote: 'never forget this',
    feeling: 'touched',
    weight: 3,
    addedAt: 'a',
    ...overrides,
  };
}

test('renderProfile: episodes render only for the interlocutor, right after the heading', () => {
  const profile = {
    id: 'p1',
    names: ['Carl'],
    affinity: { score: 10, reason: 'nice', history: [] },
    episodes: [episodeFixture()],
  };
  const text = renderProfile(profile, labels, { relationships: true, interlocutor: true, episodes: { enabled: true } });
  const lines = text.split('\n');
  assert.equal(lines[0], '## Carl');
  assert.equal(lines[1], labels.profile.episodes);
  assert.equal(lines[2], '2026-01-01: said something memorable — "never forget this" (touched)');
  assert.ok(!text.includes('attitude:'), 'the attitude is in the row');
});

test('renderProfile: opts.handle follows the name on the heading; none without it', () => {
  const profile = { id: 'p1', names: ['Carl', 'OldCarl'], character: 'calm' };
  assert.equal(renderProfile(profile, labels, { handle: 'u1a2b' }).split('\n')[0], '## Carl (@u1a2b)');
  assert.equal(renderProfile(profile, labels, { compact: true, handle: 'u1a2b' }).split('\n')[0], '## Carl (@u1a2b)');
  assert.equal(renderProfile(profile, labels, { handle: null }).split('\n')[0], '## Carl');
});

test('renderProfile: the interlocutor heading is bare: the mark describes the request and lives in <people_now>', () => {
  const profile = {
    id: 'p1',
    names: ['Carl'],
    character: 'calm',
    episodes: [episodeFixture()],
  };
  const options = { relationships: true, interlocutor: true, episodes: { enabled: true } };
  const text = renderProfile(profile, labels, options);
  assert.equal(text.split('\n')[0], '## Carl');
  assert.equal(renderProfile(profile, labels, { ...options, mark: false }), text, 'an old mark option changes nothing');
});

test('renderProfile: episodes are never rendered for a non-interlocutor profile without episodes.max', () => {
  const profile = { id: 'p1', names: ['Carl'], character: 'calm', episodes: [episodeFixture()] };
  const text = renderProfile(profile, labels, {
    relationships: true,
    interlocutor: false,
    episodes: { enabled: true },
  });
  assert.ok(!text.includes(labels.profile.episodes));
});

test('renderProfile: episodes.max renders the top episodes of a non-interlocutor right after the heading', () => {
  const profile = {
    id: 'p1',
    names: ['Carl'],
    character: 'calm',
    affinity: { score: 10, reason: 'nice', history: [] },
    episodes: [
      episodeFixture({ what: 'léger', weight: 1, quote: '' }),
      episodeFixture({ what: 'lourd', weight: 5, quote: '' }),
      episodeFixture({ what: 'moyen', weight: 3, quote: '' }),
    ],
  };
  const lines = renderProfile(profile, labels, { relationships: true, episodes: { enabled: true, max: 2 } }).split(
    '\n'
  );
  assert.deepEqual(lines, [
    '## Carl',
    labels.profile.episodes,
    fill(labels.profile.episodeNoQuote, { date: '2026-01-01', what: 'lourd', feeling: 'touched' }),
    fill(labels.profile.episodeNoQuote, { date: '2026-01-01', what: 'moyen', feeling: 'touched' }),
    'character: calm',
  ]);
  for (const max of [0, -2, 1.5, undefined]) {
    const text = renderProfile(profile, labels, { relationships: true, episodes: { enabled: true, max } });
    assert.ok(!text.includes(labels.profile.episodes), String(max));
  }
  assert.ok(
    !renderProfile(profile, labels, { relationships: true, episodes: { enabled: false, max: 2 } }).includes('lourd')
  );
  assert.ok(
    !renderProfile(profile, labels, {
      compact: true,
      relationships: true,
      episodes: { enabled: true, max: 2 },
    }).includes('lourd')
  );
});

test('renderProfile: a non-interlocutor capped below one episode shows no episodes heading', () => {
  const cost = (text: string) => estimateTokens(text) + 2;
  const profile = {
    id: 'p1',
    names: ['Carl'],
    character: 'calm',
    episodes: [episodeFixture({ what: 'lourd', weight: 5 }), episodeFixture({ what: 'léger', weight: 1 })],
  };
  const bare = renderProfile(profile, labels, {});
  const headingOnly = cost(bare) + cost(labels.profile.episodes);
  assert.equal(renderProfile(profile, labels, { episodes: { enabled: true, max: 2, cap: headingOnly, cost } }), bare);
  const one = renderProfile(profile, labels, { episodes: { enabled: true, max: 2, cap: headingOnly + 1000, cost } });
  assert.ok(one.includes(labels.profile.episodes) && one.includes('lourd'));
  // Nothing else learned and not one episode fits: no profile at all.
  assert.equal(
    renderProfile({ ...profile, character: undefined }, labels, {
      episodes: { enabled: true, max: 2, cap: headingOnly, cost },
    }),
    ''
  );
});

test('renderProfile: episodes.max never caps the interlocutor', () => {
  const profile = {
    id: 'p1',
    names: ['Carl'],
    episodes: [episodeFixture({ what: 'un' }), episodeFixture({ what: 'deux' }), episodeFixture({ what: 'trois' })],
  };
  const text = renderProfile(profile, labels, { interlocutor: true, episodes: { enabled: true, max: 1 } });
  for (const what of ['un', 'deux', 'trois']) assert.ok(text.includes(`: ${what} —`), what);
});

test('renderProfile: episodes are never rendered when episodes.enabled is false/absent', () => {
  const profile = { id: 'p1', names: ['Carl'], episodes: [episodeFixture()] };
  const text = renderProfile(profile, labels, { relationships: true, interlocutor: true });
  assert.ok(!text.includes(labels.profile.episodes));
});

test('renderProfile: an episode with no quote uses profile.episodeNoQuote', () => {
  const profile = { id: 'p1', names: ['Carl'], episodes: [episodeFixture({ quote: '' })] };
  const text = renderProfile(profile, labels, { interlocutor: true, episodes: { enabled: true } });
  assert.ok(text.includes('2026-01-01: said something memorable (touched)'));
  assert.ok(!text.includes('"'));
});

test('renderProfile: episodes render heaviest weight first, then newest', () => {
  const profile = {
    id: 'p1',
    names: ['Carl'],
    episodes: [
      episodeFixture({ what: 'light-old', weight: 1, date: '2026-01-01' }),
      episodeFixture({ what: 'heavy', weight: 5, date: '2026-01-01' }),
      episodeFixture({ what: 'light-new', weight: 1, date: '2026-02-01' }),
    ],
  };
  const text = renderProfile(profile, labels, { interlocutor: true, episodes: { enabled: true } });
  const order = ['heavy', 'light-new', 'light-old'].map((w) => text.indexOf(w));
  assert.ok(order[0] < order[1] && order[1] < order[2]);
});

test('renderProfile: a tight episodes cap drops the lightest episodes first', () => {
  const profile = {
    id: 'p1',
    names: ['Carl'],
    character: 'calm',
    episodes: [
      episodeFixture({ what: 'heaviest', weight: 5, quote: '' }),
      episodeFixture({ what: 'lightest', weight: 1, quote: '' }),
    ],
  };
  const cost = (text: string) => text.length; // a simple, deterministic stand-in for the real token cost
  const restText = renderProfile({ ...profile, episodes: [] }, labels, {
    interlocutor: true,
    episodes: { enabled: true },
  });
  const heading = labels.profile.episodes;
  const heavyLine = fill(labels.profile.episodeNoQuote, { date: '2026-01-01', what: 'heaviest', feeling: 'touched' });
  // Room for the rest of the profile plus exactly the heading and one episode line.
  const cap = cost(restText) + cost(heading) + cost(heavyLine);

  const text = renderProfile(profile, labels, { interlocutor: true, episodes: { enabled: true, cap, cost } });
  assert.ok(text.includes('heaviest'));
  assert.ok(!text.includes('lightest'));
});

test('renderProfile: an episodes cap too small even for the heading renders no episodes at all', () => {
  const profile = { id: 'p1', names: ['Carl'], episodes: [episodeFixture()] };
  const cost = (text: string) => text.length;
  const text = renderProfile(profile, labels, { interlocutor: true, episodes: { enabled: true, cap: 1, cost } });
  assert.ok(!text.includes(labels.profile.episodes));
});

// --- renderProfile: interests --------------------------------------------------

function interestFixture(overrides: Record<string, unknown> = {}) {
  return { topic: 'Chess', note: '', weight: 1, firstSeen: 'a', lastSeen: 'a', ...overrides };
}

test('renderProfile: renders interests as "topic (note); topic", heaviest weight first', () => {
  const profile = {
    id: 'p1',
    names: ['Carl'],
    interests: [
      interestFixture({ topic: 'Anime', note: 'watches shonen', weight: 2 }),
      interestFixture({ topic: 'Chess', note: '', weight: 5 }),
    ],
  };
  const text = renderProfile(profile, labels);
  assert.ok(text.includes('interests: Chess; Anime (watches shonen)'));
});

test('renderProfile: interests render capped at maxInterests, the heaviest kept', () => {
  const profile = {
    id: 'p1',
    names: ['Carl'],
    interests: [
      interestFixture({ topic: 'A', weight: 1 }),
      interestFixture({ topic: 'B', weight: 3 }),
      interestFixture({ topic: 'C', weight: 2 }),
    ],
  };
  const text = renderProfile(profile, labels, { maxInterests: 2 });
  assert.ok(text.includes('interests: B; C'));
  assert.ok(!text.includes('interests: B; C; A'));
});

test('renderProfile: uses labels.profile.interestItem/interestItemNoNote when present', () => {
  const customLabels = {
    ...labels,
    profile: { ...labels.profile, interestItem: '[{topic}: {note}]', interestItemNoNote: '<{topic}>' },
  };
  const profile = {
    id: 'p1',
    names: ['Carl'],
    interests: [
      interestFixture({ topic: 'Chess', note: 'weekly club', weight: 2 }),
      interestFixture({ topic: 'Anime', note: '', weight: 1 }),
    ],
  };
  const text = renderProfile(profile, customLabels);
  assert.ok(text.includes('interests: [Chess: weekly club]; <Anime>'));
});

test('renderProfile: an interest below confirmAfter renders with unsureMark, at/above it does not', () => {
  const profile = {
    id: 'p1',
    names: ['Carl'],
    interests: [interestFixture({ topic: 'Chess', weight: 1 }), interestFixture({ topic: 'Anime', weight: 2 })],
  };
  const text = renderProfile(profile, labels, { confirmAfter: 2 });
  assert.ok(text.includes(`Chess${labels.profile.unsureMark}`));
  assert.ok(!text.includes(`Anime${labels.profile.unsureMark}`));
});

test('renderProfile: with interestHalfLifeDays, a much fresher interest outranks an older heavier one and sorts first; the older one still carries staleMark', () => {
  const now = Date.UTC(2026, 8, 21);
  const stale = interestFixture({
    topic: 'Old',
    weight: 5,
    lastSeen: new Date(now - 200 * 24 * 3_600_000).toISOString(),
  });
  const fresh = interestFixture({
    topic: 'New',
    weight: 1,
    lastSeen: new Date(now - 1 * 24 * 3_600_000).toISOString(),
  });
  const profile = { id: 'p1', names: ['Carl'], interests: [stale, fresh] };
  // A 90-day half-life makes the ~199-day recency gap (about 2.2 half-lives, +2.2
  // rank) outweigh the weight gap (log2(5.5) - log2(1.5) =~ 1.88 rank) between
  // the two -- see docs/prompt-contract.md, "More is stored than shown,
  // and rank decays with age". This REPLACES the old "fresh first, then weight
  // desc" sort with pure rank order.
  const text = renderProfile(profile, labels, { staleDays: 90, interestHalfLifeDays: 90, now });
  const interestsLine = text.split('\n').find((l) => l.startsWith('interests:'));
  assert.ok(
    interestsLine!.includes(`New; Old${labels.profile.staleMark}`),
    `decay ranks the fresher one first, the older one still gets staleMark: ${interestsLine}`
  );
});

test('renderProfile: an interest can be both unsure and stale, unsureMark before staleMark', () => {
  const now = Date.UTC(2026, 8, 21);
  const item = interestFixture({
    topic: 'Chess',
    weight: 1,
    lastSeen: new Date(now - 200 * 24 * 3_600_000).toISOString(),
  });
  const profile = { id: 'p1', names: ['Carl'], interests: [item] };
  const text = renderProfile(profile, labels, { confirmAfter: 2, staleDays: 90, now });
  assert.ok(text.includes(`Chess${labels.profile.unsureMark}${labels.profile.staleMark}`));
});

// --- renderProfile: details ----------------------------------------------------

function detailFixture(overrides: Record<string, unknown> = {}) {
  return { id: 1, text: 'Owns a cat', weight: 2, firstSeen: 'a', lastSeen: 'a', ...overrides };
}

test('renderProfile: renders detail items joined by "; "', () => {
  const profile = {
    id: 'p1',
    names: ['Carl'],
    details: [
      detailFixture({ text: 'Owns a cat', weight: 3 }),
      detailFixture({ id: 2, text: 'Plays guitar', weight: 1 }),
    ],
  };
  const text = renderProfile(profile, labels);
  assert.ok(text.includes('details: Owns a cat; Plays guitar'));
});

test('renderProfile: details render capped at maxDetails, the top-ranked kept', () => {
  const profile = {
    id: 'p1',
    names: ['Carl'],
    details: [
      detailFixture({ id: 1, text: 'A', weight: 1 }),
      detailFixture({ id: 2, text: 'B', weight: 3 }),
      detailFixture({ id: 3, text: 'C', weight: 2 }),
    ],
  };
  const text = renderProfile(profile, labels, { maxDetails: 2 });
  assert.ok(text.includes('details: B; C'));
  assert.ok(!text.includes('details: B; C; A'));
});

test('renderProfile: with detailHalfLifeDays, a fresher detail outranks an older heavier one', () => {
  const now = Date.UTC(2026, 8, 21);
  const heavyOld = detailFixture({
    id: 1,
    text: 'Ancient favorite fact',
    weight: 10,
    lastSeen: new Date(now - 5 * 365 * 24 * 3_600_000).toISOString(),
  });
  const lightFresh = detailFixture({ id: 2, text: 'Fresh detail', weight: 1, lastSeen: new Date(now).toISOString() });
  const profile = { id: 'p1', names: ['Carl'], details: [heavyOld, lightFresh] };
  const text = renderProfile(profile, labels, { maxDetails: 1, detailHalfLifeDays: 180 });
  assert.ok(text.includes('details: Fresh detail'));
  assert.ok(!text.includes('Ancient favorite fact'));
});

test('renderProfile: an unconfirmed detail renders with unsureMark, details never get the stale mark', () => {
  const now = Date.UTC(2026, 8, 21);
  const unsure = detailFixture({
    id: 1,
    text: 'Owns a cat',
    weight: 1,
    lastSeen: new Date(now - 200 * 24 * 3_600_000).toISOString(),
  });
  const confirmed = detailFixture({ id: 2, text: 'Plays guitar', weight: 2 });
  const profile = { id: 'p1', names: ['Carl'], details: [unsure, confirmed] };
  const text = renderProfile(profile, labels, { confirmAfter: 2, staleDays: 90, now });
  assert.ok(text.includes(`Owns a cat${labels.profile.unsureMark}`));
  assert.ok(
    !text.includes(`Owns a cat${labels.profile.unsureMark}${labels.profile.staleMark}`),
    'no stale mark for details'
  );
  assert.ok(text.includes('Plays guitar'));
  assert.ok(!text.includes(`Plays guitar${labels.profile.unsureMark}`));
});

// --- renderProfile: aliases -----------------------------------------------------

function aliasFixture(overrides: Record<string, unknown> = {}) {
  return { name: 'Ari', weight: 2, firstSeen: 'a', lastSeen: 'a', ...overrides };
}

test('renderProfile: renders aliases through labels.profile.aliases, comma-separated, top-ranked first', () => {
  const profile = {
    id: 'p1',
    names: ['Aria'],
    aliases: [aliasFixture({ name: 'Ar', weight: 1 }), aliasFixture({ name: 'Ari', weight: 5 })],
  };
  const text = renderProfile(profile, labels);
  assert.ok(text.includes('Called: Ari, Ar'));
});

test('renderProfile: an unranked-cap maxAliases shows only the top N', () => {
  const profile = {
    id: 'p1',
    names: ['Aria'],
    aliases: [aliasFixture({ name: 'Ar', weight: 1 }), aliasFixture({ name: 'Ari', weight: 5 })],
  };
  const text = renderProfile(profile, labels, { maxAliases: 1 });
  assert.ok(text.includes('Called: Ari'));
  assert.ok(!text.includes('Called: Ari, Ar'));
});

test('renderProfile: no aliases line when the profile has none, or when labels.profile.aliases is missing', () => {
  const profile = { id: 'p1', names: ['Aria'], character: 'calm' };
  assert.ok(!renderProfile(profile, labels).includes('Called:'));

  const withAliases = { id: 'p1', names: ['Aria'], aliases: [aliasFixture()] };
  const brokenLabels = { ...labels, profile: { ...labels.profile, aliases: undefined } };
  assert.ok(!renderProfile(withAliases, brokenLabels).includes('Called:'));
});

// --- renderProfile: <@id> tokens resolved for the chat model -------------------

test('renderProfile: character/style/relationship resolve <@id> tokens via nameOf', () => {
  const profile = {
    id: 'p1',
    names: ['Carl'],
    character: 'gets along with <@223456789012345678>',
    style: 'quotes <@223456789012345678> a lot',
    relationship: 'trusts <@223456789012345678>',
  };
  const text = renderProfile(profile, labels, {
    nameOf: (id: string) => (id === '223456789012345678' ? 'Dana' : null),
  });
  assert.ok(text.includes('character: gets along with Dana'));
  assert.ok(text.includes('style: quotes Dana a lot'));
  assert.ok(text.includes('relationship with you: trusts Dana'));
});

test('renderProfile: an id nameOf cannot resolve renders the bare token', () => {
  const profile = { id: 'p1', names: ['Carl'], character: 'knows <@223456789012345678>' };
  const text = renderProfile(profile, labels, { nameOf: () => null });
  assert.ok(text.includes('character: knows <@223456789012345678>'));
});

test('renderProfile: interest note and detail text resolve <@id> tokens via nameOf', () => {
  const profile = {
    id: 'p1',
    names: ['Carl'],
    interests: [interestFixture({ topic: 'Chess', note: 'plays with <@223456789012345678>' })],
    details: [detailFixture({ text: 'a gift from <@223456789012345678>' })],
  };
  const text = renderProfile(profile, labels, {
    nameOf: (id: string) => (id === '223456789012345678' ? 'Dana' : null),
  });
  assert.ok(text.includes('Chess (plays with Dana)'));
  assert.ok(text.includes('a gift from Dana'));
});

test('renderProfile: episode "what"/"feeling" resolve <@id> tokens via nameOf', () => {
  const profile = {
    id: 'p1',
    names: ['Carl'],
    episodes: [
      episodeFixture({
        what: 'argued with <@223456789012345678>',
        feeling: 'annoyed at <@223456789012345678>',
        quote: '',
      }),
    ],
  };
  const text = renderProfile(profile, labels, {
    interlocutor: true,
    episodes: { enabled: true },
    nameOf: (id: string) => (id === '223456789012345678' ? 'Dana' : null),
  });
  assert.ok(text.includes('argued with Dana'));
  assert.ok(text.includes('annoyed at Dana'));
});

// --- renderProfile: compact -------------------------------------------------------

test('renderProfile: compact renders current name, aliases, character and up to 5 bare-topic interests -- nothing else; the attitude is in the row', () => {
  const profile = {
    id: 'p1',
    names: ['Carl', 'OldCarl'],
    aliases: [aliasFixture({ name: 'Carlito', weight: 5 })],
    character: 'calm',
    style: 'terse',
    relationship: 'friendly rival',
    messageCount: 42,
    affinity: { score: 10, reason: 'helped once', history: [] },
    interests: [
      interestFixture({ topic: 'Chess', note: 'weekly club', weight: 6 }),
      interestFixture({ topic: 'Anime', note: '', weight: 5 }),
      interestFixture({ topic: 'Coffee', note: '', weight: 4 }),
      interestFixture({ topic: 'Hiking', note: '', weight: 3 }),
      interestFixture({ topic: 'Chess variants', note: '', weight: 2 }),
      interestFixture({ topic: 'Bonsai', note: '', weight: 1 }),
    ],
    details: [{ id: 'd1', text: 'lives nearby', weight: 3 }],
    episodes: [episodeFixture()],
  };
  const text = renderProfile(profile, labels, { compact: true, relationships: true });
  assert.equal(
    text,
    ['## Carl', 'Called: Carlito', 'character: calm', 'interests: Chess; Anime; Coffee; Hiking; Chess variants'].join(
      '\n'
    )
  );
});

test('renderProfile: compact omits former names, style, details, relationship, message count and episodes', () => {
  const profile = {
    id: 'p1',
    names: ['Carl', 'OldCarl'],
    character: 'calm',
    style: 'terse',
    relationship: 'friendly rival',
    messageCount: 42,
    interests: [interestFixture({ topic: 'Chess', note: 'weekly club', weight: 6 })],
    details: [{ id: 'd1', text: 'lives nearby', weight: 3 }],
    episodes: [episodeFixture()],
  };
  const text = renderProfile(profile, labels, { compact: true, interlocutor: true, episodes: { enabled: true } });
  assert.ok(!text.includes('formerly known as'));
  assert.ok(!text.includes('style:'));
  assert.ok(!text.includes('details:'));
  assert.ok(!text.includes('relationship with you:'));
  assert.ok(!text.includes('messages you have seen'));
  assert.ok(!text.includes(labels.profile.episodes));
  assert.ok(!text.includes('(weekly club)'), 'compact interests drop the note');
});

test('renderProfile: compact interests cap at 5 regardless of maxInterests', () => {
  const profile = {
    id: 'p1',
    names: ['Carl'],
    interests: [
      interestFixture({ topic: 'A', weight: 6 }),
      interestFixture({ topic: 'B', weight: 5 }),
      interestFixture({ topic: 'C', weight: 4 }),
      interestFixture({ topic: 'D', weight: 3 }),
      interestFixture({ topic: 'E', weight: 2 }),
      interestFixture({ topic: 'F', weight: 1 }),
    ],
  };
  const text = renderProfile(profile, labels, { compact: true, maxInterests: 100 });
  assert.ok(text.includes('interests: A; B; C; D; E'));
  assert.ok(!text.includes('F'));
});

// --- code fallbacks equal config.json --------------------------------------------

// ---- validity: closed claims and conflict sets in <people> ----------------------

test('prompt: a closed claim renders once as before on its successor within supersededShownDays, never alone', () => {
  const now = Date.UTC(2026, 9, 10, 12, 0, 0);
  const day = 24 * 3_600_000;
  const profileAt = (recordedMs: number) => ({
    id: 'p1',
    names: ['Zoé'],
    interests: [
      {
        topic: 'πόκερ',
        note: '',
        weight: 2,
        firstSeen: null,
        lastSeen: null,
        itemId: 'in-b',
        recordedAt: new Date(recordedMs).toISOString(),
      },
      { topic: 'κιθάρα', note: '', weight: 1, firstSeen: null, lastSeen: null, itemId: 'in-c' },
    ],
    closed: [
      {
        kind: 'interest',
        topic: 'σκάκι',
        note: '',
        weight: 3,
        firstSeen: null,
        lastSeen: null,
        itemId: 'in-a',
        validTo: '2026-10-08',
        supersededBy: 'in-b',
      },
      {
        kind: 'interest',
        topic: 'τάβλι',
        note: '',
        weight: 3,
        firstSeen: null,
        lastSeen: null,
        itemId: 'in-z',
        validTo: '2026-10-08',
        supersededBy: 'in-gone',
      },
    ],
  });
  const fresh = renderProfile(profileAt(now - 2 * day), labels, { interlocutor: true, now, supersededShownDays: 7 });
  assert.match(fresh, /πόκερ \(was: σκάκι\)/);
  assert.equal(fresh.split('σκάκι').length - 1, 1, 'once');
  assert.ok(!fresh.includes('τάβλι'), 'a closed claim without a shown successor never renders alone');

  const old = renderProfile(profileAt(now - 8 * day), labels, { interlocutor: true, now, supersededShownDays: 7 });
  assert.ok(!old.includes('σκάκι'), 'past supersededShownDays the old claim is gone');
  assert.match(old, /πόκερ; κιθάρα|κιθάρα; πόκερ/);

  // An item a hand edit left closed inside the ranked list is not shown.
  const handEdited = renderProfile(
    {
      id: 'p1',
      names: ['Zoé'],
      details: [
        { id: 1, text: 'ζει στη Λυών', weight: 2, validTo: '2026-10-01' },
        { id: 2, text: 'ζει στη Νίκαια', weight: 2 },
      ],
    },
    labels,
    { interlocutor: true, now }
  );
  assert.ok(!handEdited.includes('Λυών'));
  assert.ok(handEdited.includes('Νίκαια'));
});

test('prompt: a conflict set renders both claims with dates', () => {
  const profile = {
    id: 'p1',
    names: ['Zoé'],
    details: [
      {
        id: 2,
        text: 'ζει στη Νίκαια',
        weight: 1,
        firstSeen: '2026-09-10T10:00:00.000Z',
        lastSeen: '2026-09-10T10:00:00.000Z',
        itemId: 'dt-b',
        conflictSetId: 'dt-a',
      },
      {
        id: 1,
        text: 'ζει στη Λυών',
        weight: 2,
        firstSeen: '2026-09-01T10:00:00.000Z',
        lastSeen: '2026-09-01T10:00:00.000Z',
        itemId: 'dt-a',
        conflictSetId: 'dt-a',
        validFrom: '2026-08-30',
      },
      { id: 3, text: 'έχει γάτα', weight: 1, firstSeen: null, lastSeen: null },
    ],
  };
  const text = renderProfile(profile, labels, { interlocutor: true, now: Date.UTC(2026, 9, 10) });
  assert.match(text, /ζει στη Λυών \/ ζει στη Νίκαια \((conflicting, 2026-08-30 and 2026-09-10)\)/);
  assert.equal(text.split('Νίκαια').length - 1, 1, 'never collapsed, never twice');
  assert.ok(text.includes('έχει γάτα'));
});

// --- renderProfile: the names people use and the real name -------------------------

test('renderProfile: addressedAs renders most used first (top 5, no numbers), then the aliases not listed yet', () => {
  const NOW = Date.UTC(2026, 9, 1, 12);
  const iso = (ms: number) => new Date(ms).toISOString();
  const profile = {
    id: 'p1',
    names: ['Aria'],
    aliases: [aliasFixture({ name: 'Ari', weight: 5 }), aliasFixture({ name: 'Rì', weight: 1 })],
    addressedAs: {
      // 8 uses 60 days ago are worth 2 now: below the 3 recent ones.
      Aria: { score: 8, last: iso(NOW - 60 * 86_400_000) },
      ari: { score: 3, last: iso(NOW) },
      Ἀρία: { score: 1, last: iso(NOW) },
      Lia: { score: 0.9, last: iso(NOW) },
      Ria: { score: 0.8, last: iso(NOW) },
      Ira: { score: 0.1, last: iso(NOW) },
    },
  };
  const text = renderProfile(profile, labels, { now: NOW, addressHalfLifeDays: 30 });
  assert.ok(text.includes('Called most often: ari, Aria, Ἀρία, Lia, Ria\n'), text);
  assert.ok(!text.includes('Ira'), 'only the top 5');
  assert.ok(text.includes('Called: Rì'), 'the stored alias not already listed');
  assert.ok(!text.includes('Called: Ari'), text);
});

test('renderProfile: without addressedAs the aliases line is as before; a realName gets its own line', () => {
  const profile = {
    id: 'p1',
    names: ['Aria'],
    aliases: [aliasFixture({ name: 'Ari', weight: 5 })],
    realName: { name: 'Théa', from: '2026-01-01', to: null, itemId: 'rn-2' },
  };
  const text = renderProfile(profile, labels);
  assert.ok(text.includes('Called: Ari'));
  assert.ok(!text.includes('Called most often'));
  assert.ok(text.includes('Real name: Théa'));
  const compact = renderProfile(profile, labels, { compact: true });
  assert.ok(compact.includes('Real name: Théa'), 'a compact profile shows it too');
});

test('renderProfile: a freshly replaced real name rides on the new one through labels.profile.before', () => {
  const NOW = Date.UTC(2026, 9, 1, 12);
  const profile = {
    id: 'p1',
    names: ['Aria'],
    realName: {
      name: 'Théa',
      from: '2026-09-30',
      to: null,
      itemId: 'rn-2',
      recordedAt: new Date(NOW - 86_400_000).toISOString(),
    },
    closed: [
      {
        kind: 'realName',
        name: 'Léa',
        validFrom: '2026-01-01',
        validTo: '2026-09-30',
        supersededBy: 'rn-2',
        itemId: 'rn-1',
      },
    ],
  };
  assert.ok(renderProfile(profile, labels, { now: NOW }).includes('Real name: Théa (was: Léa)'));
  const later = renderProfile(profile, labels, { now: NOW + 30 * 86_400_000 });
  assert.ok(
    later.includes('Real name: Théa') && !later.includes('(was: Léa)'),
    'past supersededShownDays the old name is not shown'
  );
});
