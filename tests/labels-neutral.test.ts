// The labels speak of a place, never of one platform (plan 2026-11-06-turn-frame, slice 7 (c)): `config/labels.json` is
// the same for every interface and for a service with none, so a label that says channel, server, root or Discord
// gets a placeholder the code fills with the interface's own noun, or goes with its block. A placeholder is a value the
// code inserts and is taken out before the check. Two allowlists, both of keys: the labels whose placeholder is named
// for a platform noun (`#{channel}`, filled with a place's name), which may lose it and may not grow, and the labels
// where `server` means the machine she runs on or the HTTP server that answered.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './fixtures/source-tree.ts';

const LABELS: unknown = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'labels.json'), 'utf8'));

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
]);

/** The labels that carry a placeholder named for a platform noun. The list may shrink; a new entry is a new platform word. */
const NOUN_PLACEHOLDER_KEYS: ReadonlySet<string> = new Set([
  'model.transcript.callReasons.channel-no-permission',
  'model.transcript.callReasons.file-elsewhere',
  'model.transcript.postedFrom',
  'model.transcript.forwardedFrom',
  'model.senses.selfreflection',
  'model.lookup.stretch',
  'model.prefetch.excerpt',
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
