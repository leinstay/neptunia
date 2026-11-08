// `message.create` with both a destination and a reply (src/tools/executors.ts#resolveCall). A destination she named is
// never replaced: when the replied message lives in another channel the call is refused `unknown-message` with the
// reason `chat`, which she reads as `message-elsewhere`, and nothing is sent. With no destination the reply's
// channel is the destination. The second half drives a real turn with a scripted native call down to the fake adapter's
// send, because the refusal only matters if no message goes out.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../src/tools/impl/index.ts';
import { outcomeDetail, refusalStatus, resolveCall } from '../src/tools/executors.ts';
import { skillRegistry } from '../src/tools/registry.ts';
import { labels } from './fixtures/labels.ts';
import { call, toolAnswer } from './fixtures/tool-answers.ts';
import { NOW, coreTurn, toolResults } from './fixtures/turn-harness.ts';
import { asRecord } from './fixtures/records.ts';

const CHANNEL_A = 'c-a';
const CHANNEL_B = 'c-b';
const MESSAGE_IN_B = '2001';
const LINK_TO_B = `https://discord.com/channels/g1/${CHANNEL_B}/${MESSAGE_IN_B}`;

/** The view of a turn that shows channels A and B, with line #5 from channel B and the link to it read by the interface. */
function viewOfBothChannels() {
  return {
    skills: skillRegistry(),
    chats: [
      { id: CHANNEL_A, name: 'άλφα' },
      { id: CHANNEL_B, name: 'βήτα' },
    ],
    channelHandles: new Map([['ca1', CHANNEL_A]]),
    messageAt: (n: number) => (n === 5 ? { id: MESSAGE_IN_B, chatId: CHANNEL_B, authorId: '7' } : null),
    links: new Map([[LINK_TO_B, { chatId: CHANNEL_B, messageId: MESSAGE_IN_B }]]),
    selfId: 'self-1',
  };
}

function resolveCreate(args: Record<string, string>) {
  return resolveCall({ skill: 'message.create', args: { text: 'απάντηση', ...args } }, viewOfBothChannels());
}

for (const [form, reply] of [
  ['a transcript number', '#5'],
  ['a message link', LINK_TO_B],
  ['a message link in angle brackets', `<${LINK_TO_B}>`],
] as const) {
  test(`refuses a reply given as ${form} when the destination named by handle is another channel`, () => {
    const refusal = resolveCreate({ place: '#ca1', reply });
    assert.equal(refusal.ok, false);
    assert.equal('code' in refusal ? refusal.code : null, 'unknown-message');
    assert.equal('reason' in refusal ? refusal.reason : null, 'chat');
  });

  // Green before the fix. Catches a fix that refuses every reply beside a channel.
  test(`accepts a reply given as ${form} when the destination named is the reply's own channel`, () => {
    const resolved = resolveCreate({ place: '#βήτα', reply });
    assert.equal(resolved.ok, true);
    assert.equal('args' in resolved ? resolved.args.place : null, CHANNEL_B);
    assert.equal('args' in resolved ? resolved.args.reply : null, MESSAGE_IN_B);
    assert.equal('channelFixed' in resolved, false);
  });

  // Green before the fix. Catches a fix that demands a destination beside every reply.
  test(`takes the destination from a reply given as ${form} when the call names no channel`, () => {
    const resolved = resolveCreate({ reply });
    assert.equal(resolved.ok, true);
    assert.equal('args' in resolved ? resolved.args.place : null, CHANNEL_B);
    assert.equal('channelFixed' in resolved, false);
  });
}

test('the refusal of a mismatch is an invalid call she reads as a message in another channel', () => {
  const refusal = resolveCreate({ place: '#ca1', reply: '#5' });
  const code = 'code' in refusal ? refusal.code : '';
  const reason = 'reason' in refusal ? refusal.reason : '';
  assert.equal(refusalStatus(code), 'invalid');
  assert.equal(outcomeDetail({ status: 'invalid', code, reason })?.kind, 'message-elsewhere');
});

/** A turn in which the persona makes one native `message.create` over #general (c1) and #jardin (c2), asked or on a wake. */
async function turnWith(args: Record<string, string>, { innerTurn = true }: { innerTurn?: boolean } = {}) {
  const wake = {
    kind: 'intention_due',
    items: [{ kind: 'intention_due', reason: 'due', intentionIds: ['i1'], errandId: null }],
    intentions: [{ id: 'i1', purpose: 'απάντησε', dueAt: NOW - 60_000 }],
    now: NOW,
    timezone: 'UTC',
    channels: [],
  };
  return coreTurn({
    answers: [toolAnswer('', [call('message.create', { text: 'απάντηση', ...args })]), '<skip/>'],
    allowed: ['message.create'],
    seeds: [{ chatId: 'c2', authorId: 'u7', messageId: 'q2', text: 'ξένο' }],
    ...(innerTurn
      ? {
          inner: wake,
          config: { wakes: { mode: 'live', chatMessages: 2 } },
          prompts: { inner: 'Do what the wake says.' },
        }
      : {}),
  });
}

const LINK_TO_JARDIN = 'https://discord.com/channels/g1/c2/q2';
// In these turns #2 is the line of #general (c1) that the harness writes last.
const LINE_IN_GENERAL = '#2';

/** Each send of the turn as its chat, its text and the message it replies to. */
function sendsOf(run: Awaited<ReturnType<typeof turnWith>>): Array<Array<unknown>> {
  return run.sends.map((send) => {
    const replied: unknown = asRecord(send.replyTo)?.messageId;
    return [send.to, send.text, replied];
  });
}

test('sends nothing when an inner turn names #jardin and replies by number to a line of #general', async () => {
  const run = await turnWith({ place: '#jardin', reply: LINE_IN_GENERAL });
  assert.deepEqual(sendsOf(run), []);
});

test('sends nothing when an inner turn names #general and replies by link to a message of #jardin', async () => {
  const run = await turnWith({ place: '#general', reply: LINK_TO_JARDIN });
  assert.deepEqual(sendsOf(run), []);
});

test('sends nothing when a turn somebody asked names #jardin and replies to a line of #general', async () => {
  const run = await turnWith({ place: '#jardin', reply: LINE_IN_GENERAL }, { innerTurn: false });
  assert.deepEqual(sendsOf(run), []);
});

test('she reads in the same turn that the replied message is in another channel', async () => {
  const run = await turnWith({ place: '#jardin', reply: LINE_IN_GENERAL });
  const told = toolResults(run.llm, 1).join('\n');
  assert.ok(told.includes(labels.transcript.callReasons['message-elsewhere']), told);
});

test('the refused call leaves the code in the log and no line about a channel taken over', async () => {
  const run = await turnWith({ place: '#jardin', reply: LINE_IN_GENERAL });
  assert.ok(
    run.logs.some((entry) => entry.msg === 'skill: refused' && entry.code === 'unknown-message'),
    JSON.stringify(run.logs.map((entry) => String(entry.msg)))
  );
  assert.equal(
    run.logs.some((entry) => entry.msg === 'skills: message channel taken from the message'),
    false
  );
});

// The rest is green before the fix. Each one catches a fix that stops a post that must go out.
test('sends once to #general when the destination and the numbered reply both name it', async () => {
  const run = await turnWith({ place: '#general', reply: LINE_IN_GENERAL });
  assert.deepEqual(sendsOf(run), [['c1', 'απάντηση', 'm1']]);
});

test('sends once to #jardin when the destination and the linked reply both name it', async () => {
  const run = await turnWith({ place: '#jardin', reply: LINK_TO_JARDIN });
  assert.deepEqual(sendsOf(run), [['c2', 'απάντηση', 'q2']]);
});

test('sends once to #general when a numbered reply is the only destination', async () => {
  const run = await turnWith({ reply: LINE_IN_GENERAL });
  assert.deepEqual(sendsOf(run), [['c1', 'απάντηση', 'm1']]);
});

test('sends once to #jardin when a linked reply is the only destination', async () => {
  const run = await turnWith({ reply: LINK_TO_JARDIN });
  assert.deepEqual(sendsOf(run), [['c2', 'απάντηση', 'q2']]);
});

test('sends once to #jardin when a post names it and replies to nothing', async () => {
  const run = await turnWith({ place: '#jardin' });
  assert.deepEqual(sendsOf(run), [['c2', 'απάντηση', undefined]]);
});
