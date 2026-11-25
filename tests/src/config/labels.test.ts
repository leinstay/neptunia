// Tests for src/config/labels.ts. `config/labels.json` holds two sections: `model`, the wording the persona's requests
// and the analyzer's requests carry, and `owner`, the strings of the answers to the privileged account. `joinLabels`
// gives the flat object the engine reads as `hot.prompts.labels`, every key at the path it has under its section, so no
// reader changes and the persona's requests stay byte-identical. The tests assert on keys and on the strings they put in, never on the shipped wording.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { joinLabels } from '../../../src/config/labels.ts';
import type { LabelsFile } from '../../../src/config/labels.ts';
import { ROOT } from '../../fixtures/private-layer.ts';
import { ROOT as NEUTRAL_ROOT } from '../../fixtures/source-tree.ts';
import { fileURLToPath } from 'node:url';
import { isPlainObject } from '../../../src/config.ts';
import { hasRequiredLabels } from '../../../src/behavior/prompt.ts';
import { labels as contractLabels } from '../../fixtures/labels.ts';

type Tree = Record<string, unknown>;

const isTree = (value: unknown): value is Tree => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Every leaf path of `tree`, dotted; an array is a leaf. */
function leafPaths(tree: Tree, prefix = ''): Array<string> {
  return Object.entries(tree).flatMap(([key, value]) => {
    const at = prefix === '' ? key : `${prefix}.${key}`;
    return isTree(value) ? leafPaths(value, at) : [at];
  });
}

/** `value` as JSON with every object's keys sorted, so equal content gives equal text. */
function trackedLabels(): LabelsFile {
  const parsed: unknown = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'labels.json'), 'utf8'));
  assert.ok(isTree(parsed) && isTree(parsed.model) && isTree(parsed.owner), 'config/labels.json is { model, owner }');
  return { model: parsed.model, owner: parsed.owner };
}

const SPLIT: LabelsFile = {
  model: { transcript: { gap: 'G {duration}', edited: 'E' }, locale: 'xx-XX' },
  owner: { status: { probe: 'P', costs: { keyLead: 'K' } } },
};

test('joins the two sections into one flat object with every key at its path under its section', () => {
  assert.deepEqual(joinLabels(SPLIT), {
    transcript: { gap: 'G {duration}', edited: 'E' },
    locale: 'xx-XX',
    status: { probe: 'P', costs: { keyLead: 'K' } },
  });
});

test('joins two sections that share a top-level section but no key', () => {
  const file: LabelsFile = { model: { status: { probe: 'P' } }, owner: { status: { costs: { keyLead: 'K' } } } };
  assert.deepEqual(joinLabels(file), { status: { probe: 'P', costs: { keyLead: 'K' } } });
});

test('refuses to join when the same key is in both sections, naming the key', () => {
  const file: LabelsFile = { model: { status: { probe: 'P' } }, owner: { status: { probe: 'Q' } } };
  assert.throws(() => joinLabels(file), /status\.probe/);
});

test('joins an empty file into an empty object', () => {
  assert.deepEqual(joinLabels({ model: {}, owner: {} }), {});
});

test('the tracked labels file holds exactly the two sections, and they share no key', () => {
  const parsed: unknown = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'labels.json'), 'utf8'));
  assert.ok(isTree(parsed));
  assert.deepEqual(Object.keys(parsed).sort(), ['model', 'owner']);
  const tracked = trackedLabels();
  const modelPaths = new Set(leafPaths(tracked.model));
  assert.deepEqual(
    leafPaths(tracked.owner).filter((one) => modelPaths.has(one)),
    []
  );
});

// The contract marks the costs and the inner-life lines of the status card as read by the owner and never sent to a
// model (docs/prompt-contract.md, "Labels"): a split that left them under `model` did not split.
test('the tracked labels keep the status card costs and inner-life lines under owner', () => {
  const tracked = trackedLabels();
  const status = tracked.owner.status;
  assert.ok(isTree(status), 'owner.status exists');
  assert.ok(isTree(status.costs) && Object.keys(status.costs).length > 0, 'owner.status.costs holds the costs lines');
  assert.ok(isTree(status.inner) && Object.keys(status.inner).length > 0, 'owner.status.inner holds the inner lines');
  const model = tracked.model.status;
  assert.equal(isTree(model) && Object.hasOwn(model, 'costs'), false, 'no costs line stays under model');
});

const LABELS: unknown = JSON.parse(fs.readFileSync(path.join(NEUTRAL_ROOT, 'config', 'labels.json'), 'utf8'));

/** Every string of a JSON value with its dotted key, array items by index. */
function stringsOf(value: unknown, key = ''): Array<[string, string]> {
  if (typeof value === 'string') return [[key, value]];
  if (Array.isArray(value)) return value.flatMap((item, index) => stringsOf(item, `${key}.${index}`));
  if (value === null || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([inner, item]) => stringsOf(item, key === '' ? inner : `${key}.${inner}`));
}

const PLATFORM_WORD = /\b(?:channel|server|root|discord)s?\b/i;
const NOT_A_MACHINE = /\b(?:channel|root|discord)s?\b/i;
const PLACEHOLDER = /\{[^{}]*\}/g;

/** The labels where `server` is the machine or an HTTP server, not a root of a platform. */
const MACHINE_SERVER: ReadonlySet<string> = new Set([
  'model.spatial.server',
  'model.wake.feedback.codes.proxy-down',
  'model.tools.result.reasons.http',
  // Changed: the agent that reads the machine is `server`, and its tool `errand.server`.
  'model.myDay.things.errand.server',
  'model.myDay.thingsMany.errand.server',
  'model.tools.result.reasons.diary-draw-only',
]);

/** The labels that carry a placeholder named for a platform noun. The list may shrink; a new entry is a new platform word. */
const NOUN_PLACEHOLDER_KEYS: ReadonlySet<string> = new Set([
  'model.transcript.callReasons.channel-no-permission',
  'model.transcript.callReasons.file-elsewhere',
  'model.transcript.postedFrom',
  'model.transcript.forwardedFrom',
  'model.senses.diary',
  'model.lookup.stretch',
  'model.pull.header',
  'model.elsewhere.called',
  'model.recent.lineIn',
  'model.participation.channel',
  'model.participation.channelNoPurpose',
  'model.intentions.destination',
  'model.tools.tools.memory.window',
  'model.tools.tools.conversation.source',
  'model.peopleNow.voiceYes',
]);

test('no label names a platform outside the placeholders the code fills', () => {
  // Bug: a Telegram turn is told about "this server's channels", or a command line turn about a channel it has none of.
  const found = stringsOf(LABELS)
    .filter(([key, text]) =>
      (MACHINE_SERVER.has(key) ? NOT_A_MACHINE : PLATFORM_WORD).test(text.replace(PLACEHOLDER, ''))
    )
    .map(([key]) => key);
  assert.deepEqual(found, []);
});

test('a placeholder named for a platform noun stands only in the labels of the allowlist', () => {
  // Bug: a new label has the code fill in a platform's noun under its own name, and the neutral check above passes it.
  const found = stringsOf(LABELS)
    .filter(([, text]) => (text.match(PLACEHOLDER) ?? []).some((placeholder) => PLATFORM_WORD.test(placeholder)))
    .map(([key]) => key)
    .filter((key) => !NOUN_PLACEHOLDER_KEYS.has(key));
  assert.deepEqual(found, []);
});

// ---- the shipped layer --------------------------------------------------------

const SHIPPED_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const PROMPTS_DIR = path.join(SHIPPED_ROOT, 'prompts');

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
  config: JSON.parse(fs.readFileSync(path.join(SHIPPED_ROOT, 'config', 'config.json'), 'utf8')),
  prompts: {
    ...Object.fromEntries(PROMPT_FILES.map((name) => [name, readPrompt(name)])),
    labels: joinLabels(JSON.parse(fs.readFileSync(path.join(SHIPPED_ROOT, 'config', 'labels.json'), 'utf8'))),
  },
};
// The shipped labels carry the keys of the contract (the fixture covers every one).
const SHIPPED_LABELS = SHIPPED.prompts.labels as typeof contractLabels;

/**
 * Label keys the code renders that the tracked labels.json does not carry yet, each with the
 * reason. Until the dev agent adds them, the block they head is simply left out of the request.
 */
const PENDING_LABELS = {
  // B7 and B8: retired, and the fixture keeps their words so a test can see that the core renders none.
  'senses.gifs': 'retired',
  'senses.customEmoji': 'retired',
  'gifs.header': 'retired',
  'emoji.header': 'retired',
  'emoji.seenInChat': 'retired',
  'recent.header': 'the <recent> view (spec-recall R3): its wording is a text task for the dev agent',
  'recent.line': 'the <recent> view (spec-recall R3): its wording is a text task for the dev agent',
  'recent.lineIn': 'the <recent> view (spec-recall R3): its wording is a text task for the dev agent',
  'recent.episode': 'the <recent> view (spec-recall R3): its wording is a text task for the dev agent',
  // Slice 7: retired with the old producers (the channel directory, the pulled channel, the elsewhere and
  // participation blocks, the server lookup), and the fixture keeps their words so a test can see that the core
  // renders none.
  'channelDirectory.lead': 'retired',
  'channelDirectory.line': 'retired',
  'senses.lottie': 'retired',
  'senses.channels': 'retired',
  'senses.participation': 'retired',
  'senses.elsewhere': 'retired',
  'lookup.serverHeader': 'retired',
  'lookup.bothNote': 'retired',
  'pull.header': 'retired',
  'pull.olderNotShown': 'retired',
  'pull.picturesNotSeen': 'retired',
  'pull.earlierPings': 'retired',
  'pull.pingAnswered': 'retired',
  'pull.pingUnanswered': 'retired',
  'pull.pingSkipped': 'retired',
  'pull.seenBefore': 'retired',
  'pull.seenSame': 'retired',
  'elsewhere.called': 'retired',
  'participation.header': 'retired',
  'participation.channel': 'retired',
  'participation.channelNoPurpose': 'retired',
  'participation.episode': 'retired',
  'participation.skipped': 'retired',
  'participation.earlierHeader': 'retired',
  'participation.earlierGap': 'retired',
  'participation.earlierOpen': 'retired',
};

/** Every key path of a labels object (`a.b.c`), arrays counted as one value. */
function keyPaths(value: Record<string, unknown>, prefix = ''): Array<string> {
  return Object.entries(value).flatMap(([key, entry]) =>
    isPlainObject(entry) ? keyPaths(entry as Record<string, unknown>, `${prefix}${key}.`) : [`${prefix}${key}`]
  );
}

test('labels: the tracked labels.json passes the startup check and carries every key the code renders', () => {
  assert.equal(hasRequiredLabels(SHIPPED_LABELS), true);
  const shipped = new Set(keyPaths(SHIPPED_LABELS));
  const missing = keyPaths(contractLabels).filter((key) => !shipped.has(key) && !Object.hasOwn(PENDING_LABELS, key));
  assert.deepEqual(missing, [], 'label keys of the contract missing from prompts/labels.json');
});
