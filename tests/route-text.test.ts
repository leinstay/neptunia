// Tests for src/llm/route-text.ts: the text form of a route (`<key>/<model>[:<effort>]`,
// `harness:<claude|codex>/<model>[:<effort>]`) and the record form `models.routes.<role>` holds, both read into one
// route, and a route written back as text. Which role takes a harness or an effort is checked here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRouteText, readRoute, routeText } from '../src/llm/route-text.ts';

test('a key route keeps the slashes of the model id and reads a trailing effort', () => {
  // Catches: the model id cut at its first slash, so the request names `anthropic` as the model.
  assert.deepEqual(parseRouteText('analyzer', 'helpers/anthropic/claude-sonnet-6.1:medium'), {
    via: 'api',
    key: 'helpers',
    model: 'anthropic/claude-sonnet-6.1',
    effort: 'medium',
  });
});

test('a colon suffix that is no effort level stays on the model id', () => {
  // Catches: a provider variant such as `:free` dropped from the model.
  assert.deepEqual(parseRouteText('vision', 'helpers/meta-llama/llama-5:free'), {
    via: 'api',
    key: 'helpers',
    model: 'meta-llama/llama-5:free',
    effort: null,
  });
});

test('a harness route on the core reads its backend, model and a level only a CLI lists', () => {
  // Catches: `harness:` read as a key name, so the core goes out on the API under a key called harness.
  assert.deepEqual(parseRouteText('core', 'harness:claude/claude-opus-4-6:xhigh'), {
    via: 'harness',
    backend: 'claude',
    model: 'claude-opus-4-6',
    effort: 'xhigh',
  });
});

test('a harness route on a role that runs no CLI chat step is refused as unsupported', () => {
  // Catches: an analyzer on claude accepted, then sent to the API with a harness model id.
  assert.equal(readCode(parseRouteText('analyzer', 'harness:claude/claude-opus-4-6')), 'route-unsupported');
});

test('opencode is refused as a harness', () => {
  // Catches: an opencode core accepted although `opencode run` takes no system prompt of its own.
  assert.equal(readCode(parseRouteText('core', 'harness:opencode/anthropic/claude-opus-4.6')), 'route-unsupported');
});

test('an effort on an API route of the core is refused, the core never gets provider reasoning', () => {
  // Catches: `helpers/anthropic/claude-opus-4.6:high` on the core sending `reasoning`, against the owner's rule.
  assert.equal(readCode(parseRouteText('core', 'helpers/anthropic/claude-opus-4.6:high')), 'route-unsupported');
  assert.equal(readCode(parseRouteText('embedding', 'helpers/openai/text-embedding-3-large:low')), 'route-unsupported');
});

test('a route with no model or a bad key name is malformed', () => {
  // Catches: `helpers` alone taken as a key with an empty model, refused by the provider only after the run started.
  assert.equal(readCode(parseRouteText('core', 'helpers')), 'route-malformed');
  assert.equal(readCode(parseRouteText('core', 'harness:claude')), 'route-malformed');
  assert.equal(readCode(parseRouteText('analyzer', 'Bad Key/openai/gpt-6.1-sol')), 'route-malformed');
});

test('a stored record reads into the same route as its text', () => {
  // Catches: the config record and the command text disagreeing on a field name, so a saved chain reads as nothing.
  const text = parseRouteText('memory', 'harness:codex/gpt-6.1-sol:high');
  assert.deepEqual(
    readRoute('memory', { via: 'harness', backend: 'codex', model: 'gpt-6.1-sol', effort: 'high' }),
    text
  );
  assert.deepEqual(readRoute('analyzer', { via: 'api', key: 'helpers', model: 'openai/gpt-6.1-sol' }), {
    via: 'api',
    key: 'helpers',
    model: 'openai/gpt-6.1-sol',
    effort: null,
  });
  assert.equal(readCode(readRoute('vision', { via: 'harness', backend: 'claude', model: 'x' })), 'route-unsupported');
  assert.equal(readCode(readRoute('vision', 'helpers/google/gemini-4-argon')), 'route-malformed');
});

test('a route written as text parses back to itself', () => {
  // Catches: `/model show` printing a chain that `/model set` cannot read back.
  for (const [role, text] of [
    ['analyzer', 'helpers/anthropic/claude-sonnet-6.1:low'],
    ['core', 'harness:claude/claude-opus-4-6'],
    ['speech', 'helpers/elevenlabs/eleven-v4'],
  ] as const) {
    const route = parseRouteText(role, text);
    assert.ok(!('code' in route), text);
    assert.equal(routeText(route), text);
  }
});

function readCode(result: object): unknown {
  return 'code' in result ? result.code : null;
}
