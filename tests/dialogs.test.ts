// Tests for src/interface/commands/dialogs.ts and its use by the command desk (src/interface/neptunia-cli.ts): a command
// that asks answers its request with a question, takes the answer from a second request, and ends with its result. The
// clock is injected; no socket is opened.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDialogBroker, DIALOG_EXPIRY_MS } from '../src/interface/commands/dialogs.ts';
import type { Question } from '../src/interface/commands/dialogs.ts';
import { createCommandDesk } from '../src/interface/neptunia-cli.ts';
import type { CommandDeps, CommandEvent } from '../src/interface/neptunia-cli.ts';
import { validateAction, validateEvent } from '../src/protocol/validate.ts';

const SECRET = 'sk-or-v1-SECRETVALUE-9999';

function broker() {
  const clock = { at: 1_000_000 };
  let n = 0;
  return { clock, dialogs: createDialogBroker({ now: () => clock.at, newId: () => `d${(n += 1)}` }) };
}

const questionOf = (reply: unknown): Question => {
  assert.equal((reply as { status: string }).status, 'ask');
  return reply as Question;
};

test('a command with two questions answers its request with the first, the second request with the next, the third with the result', async () => {
  const { dialogs } = broker();
  const first = questionOf(
    await dialogs.start('keys.core.add', async (dialog) => {
      const value = await dialog.ask('value?', { secret: true });
      const model = await dialog.ask('model?', { fallback: 'x/y' });
      return { text: `saved ${value.length} chars on ${model}`, status: 'ok' };
    })
  );
  assert.equal(first.prompt, 'value?');
  assert.equal(first.secret, true);
  const second = questionOf(await dialogs.answer('keys.core.add', first.dialogId, SECRET));
  assert.equal(second.prompt, 'model?');
  assert.equal(second.secret, false);
  const result = await dialogs.answer('keys.core.add', second.dialogId, 'm/n');
  // Bug caught: the answer text placed in a question or a result by the broker itself.
  assert.deepEqual(result, { text: `saved ${SECRET.length} chars on m/n`, status: 'ok' });
  assert.ok(!JSON.stringify([first, second]).includes('SECRETVALUE'));
});

test('a command that asks nothing answers its first request with its result', async () => {
  const { dialogs } = broker();
  assert.deepEqual(await dialogs.start('keys.core.list', () => Promise.resolve({ text: 'none', status: 'ok' })), {
    text: 'none',
    status: 'ok',
  });
});

test('a command that throws before asking fails its request', async () => {
  const { dialogs } = broker();
  await assert.rejects(
    dialogs.start('keys.core.add', () => Promise.reject(new Error('no store'))),
    /no store/
  );
});

test('an answer past the expiry, for another command or for an unknown dialog is refused, and the command ends', async () => {
  const { dialogs, clock } = broker();
  let ended: unknown = null;
  const question = questionOf(
    await dialogs.start('keys.core.add', async (dialog) => {
      try {
        return { text: await dialog.ask('value?', { secret: true }), status: 'ok' };
      } catch (err) {
        ended = err;
        throw err;
      }
    })
  );
  assert.equal(dialogs.answer('keys.extra.add', question.dialogId, SECRET), null, 'another command');
  assert.equal(dialogs.answer('keys.core.add', 'nope', SECRET), null, 'an unknown dialog');
  clock.at += DIALOG_EXPIRY_MS;
  // Bug caught: a question that waits for ever, so a key typed an hour later is stored by a command long forgotten.
  assert.equal(dialogs.answer('keys.core.add', question.dialogId, SECRET), null, 'expired');
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(ended instanceof Error, 'the waiting command was ended');
});

/** A desk whose console asks for a value and answers with the argument it was given and the length of the value. */
function desk(seen: { args: Array<Record<string, unknown>> }) {
  const deps = {
    console: {
      run: async (
        _name: string,
        args: Record<string, unknown>,
        _requester: { id: string },
        dialog?: { ask(question: string, options?: { secret?: boolean }): Promise<string> } | null
      ) => {
        seen.args.push(args);
        const value = (await dialog?.ask('value?', { secret: true })) ?? '';
        return { text: `${String(args.name)} has ${value.length} chars`, status: 'ok' };
      },
    },
    interfaces: { list: () => [], enable() {}, disable: () => Promise.resolve({ drained: 0, unknown: 0 }) },
    facts: () => {
      throw new Error('not used');
    },
    placeId: () => null,
    tasks: { command: () => Promise.reject(new Error('not used')) },
  } as unknown as CommandDeps;
  return createCommandDesk(deps);
}

const event = (extra: Partial<CommandEvent> = {}): CommandEvent => ({
  name: 'keys.core.add',
  args: { name: 'core-1' },
  conversation: { id: 'cli:dm:owner' },
  requester: { id: 'owner', roles: [] },
  ...extra,
});

test('the desk answers a question with a second request that carries the dialog and the answer, and the answer never enters the arguments', async () => {
  const seen = { args: [] as Array<Record<string, unknown>> };
  const commands = desk(seen);
  const asked = questionOf(await commands.run(event(), { kind: 'cli', name: 'cli' }));
  const done = await commands.run(event({ dialogId: asked.dialogId, answer: SECRET }), { kind: 'cli', name: 'cli' });
  assert.deepEqual(done, { text: `core-1 has ${SECRET.length} chars`, status: 'ok' });
  // Bug caught: a secret answer stored as an argument, which every refusal echoes and every log of a command names.
  assert.ok(!JSON.stringify(seen.args).includes('SECRETVALUE'));
});

test('the desk refuses an answer to a closed question and tells the owner to run the command again', async () => {
  const commands = desk({ args: [] });
  const done = await commands.run(event({ dialogId: 'gone', answer: SECRET }), { kind: 'cli', name: 'cli' });
  assert.equal((done as { status: string }).status, 'invalid');
  assert.ok(!(done as { text: string }).text.includes('SECRETVALUE'));
});

test('a command.requested with an answer needs its dialog, and a command.result of status ask carries its question', () => {
  const base = {
    kind: 'command.requested',
    iface: 'cli',
    at: 1,
    id: 'cli:command:r1',
    conversation: { id: 'cli:dm:owner', kind: 'dm', communityId: null, name: 'owner', partnerId: 'owner' },
    name: 'keys.core.add',
    args: { name: 'core-1' },
    requester: { id: 'owner', name: 'owner', roles: [], owner: true },
    replyRef: 'r1',
  };
  assert.equal(validateEvent({ ...base, dialogId: 'd1', answer: SECRET }).ok, true);
  assert.equal(validateEvent({ ...base, dialogId: 'd1', answer: '' }).ok, true, 'a blank answer takes the default');
  assert.equal(validateEvent({ ...base, answer: SECRET }).ok, false, 'an answer with no dialog');
  assert.equal(validateEvent({ ...base, dialogId: 'd1' }).ok, false, 'a dialog with no answer');
  const ask = {
    action: 'command.result',
    replyRef: 'r1',
    text: 'value?',
    status: 'ask',
    dialogId: 'd1',
    prompt: 'value?',
    secret: true,
  };
  assert.equal(validateAction(ask).ok, true);
  assert.equal(validateAction({ ...ask, secret: 'yes' }).ok, false);
});
