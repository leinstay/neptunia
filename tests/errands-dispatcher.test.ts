// Tests for src/errands/dispatcher.ts: the one request that picks an errand's agent. Over a FAKE model client: the
// request carries the goal and one roster line per agent and goes out on the `dispatcher` role with no reasoning; the
// answer is one `<agent>` tag read strictly against the roster; a failed request is no answer at all.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createDispatcher, parseDispatcherAnswer } from '../src/errands/dispatcher.ts';
import { chainsOf } from './fixtures/chains.ts';

const ROSTER = [
  { name: 'scout', description: 'Deep search for information.' },
  { name: 'fetch', description: 'Finds media files <and> brings them back.' },
];

const LABELS = { errands: { roster: '{name}: {description}' } };

/** A fake model client: records each request and answers with `text`, or throws `error`. */
function fakeLlm({ text = '', error = null }: { text?: string; error?: Error | null } = {}) {
  const calls: Array<{ messages: Array<{ role: string; content: string }>; options: Record<string, unknown> }> = [];
  return {
    calls,
    complete(messages: unknown, options: unknown) {
      calls.push({
        messages: messages as Array<{ role: string; content: string }>,
        options: options as Record<string, unknown>,
      });
      return error ? Promise.reject(error) : Promise.resolve({ text });
    },
  };
}

const quietLog = { info: () => {}, warn: () => {} };

function dispatcherOver(llm: ReturnType<typeof fakeLlm>) {
  const hot = {
    config: { models: { routes: chainsOf({ dispatcher: 'x/dispatcher' }) } },
    prompts: { dispatcher: 'Pick one agent.', labels: LABELS },
  };
  return createDispatcher({ llm, hot, log: quietLog });
}

test('parseDispatcherAnswer: the name in the one agent tag when the roster holds it', () => {
  assert.equal(parseDispatcherAnswer('<agent>scout</agent>', ROSTER), 'scout');
  assert.equal(parseDispatcherAnswer('The goal is a search.\n<agent> fetch </agent>\n', ROSTER), 'fetch');
});

test('parseDispatcherAnswer: no agent for an empty tag, a name off the roster, two tags or no tag', () => {
  // Bug caught: an answer naming an agent that is off, or reading the first of two tags, runs an errand nobody chose.
  assert.equal(parseDispatcherAnswer('<agent></agent>', ROSTER), null);
  assert.equal(parseDispatcherAnswer('<agent>server</agent>', ROSTER), null);
  assert.equal(parseDispatcherAnswer('<agent>scout</agent><agent>fetch</agent>', ROSTER), null);
  assert.equal(parseDispatcherAnswer('scout', ROSTER), null);
  assert.equal(parseDispatcherAnswer('<agent>Scout</agent>', ROSTER), null);
  assert.equal(parseDispatcherAnswer(undefined, ROSTER), null);
});

test('dispatcher: one request on the dispatcher role with the goal and a line per agent, answered with the agent', async () => {
  const llm = fakeLlm({ text: '<agent>fetch</agent>' });
  const answer = await dispatcherOver(llm)({ goal: 'find a cat <video>', roster: ROSTER });
  assert.deepEqual(answer, { ok: true, agent: 'fetch' });
  assert.equal(llm.calls.length, 1);
  const [{ messages, options }] = llm.calls;
  assert.equal(messages[0]?.content, 'Pick one agent.');
  const user = String(messages[1]?.content);
  assert.match(user, /<goal>\nfind a cat &lt;video>\n<\/goal>/);
  assert.match(
    user,
    /<agents>\nscout: Deep search for information\.\nfetch: Finds media files &lt;and> brings them back\.\n<\/agents>/
  );
  assert.equal(options.role, 'dispatcher');
  assert.equal(options.model, 'x/dispatcher');
  assert.equal(Object.hasOwn(options, 'reasoning'), false, 'no provider reasoning');
});

test('dispatcher: an answer with no agent answers ok with none; a failed request answers not ok', async () => {
  assert.deepEqual(await dispatcherOver(fakeLlm({ text: '<agent></agent>' }))({ goal: 'g', roster: ROSTER }), {
    ok: true,
    agent: null,
  });
  // Bug caught: a provider error read as "no agent fits", so she is told no agent can do what any could.
  assert.deepEqual(
    await dispatcherOver(fakeLlm({ error: new Error('provider down') }))({ goal: 'g', roster: ROSTER }),
    { ok: false }
  );
});

test('dispatcher: a blank prompt sends nothing and answers not ok', async () => {
  const llm = fakeLlm({ text: '<agent>scout</agent>' });
  const hot = { config: {}, prompts: { dispatcher: '  ', labels: LABELS } };
  assert.deepEqual(await createDispatcher({ llm, hot, log: quietLog })({ goal: 'g', roster: ROSTER }), { ok: false });
  assert.equal(llm.calls.length, 0);
});
