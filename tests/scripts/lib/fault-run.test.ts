// The fault run (scripts/lib/fault-run.ts): every side effect counted by its effect key, and the run
// passes when no key repeats and each expected effect happened once. The ledger and the reading of a request are
// checked on small inputs. The short run is the real one over the real core: repeated events (at once, one after
// another, after a reconnect, while the link is down), an edit and a delete racing a turn, a reaction cut off by the call
// timeout, a core stopped mid-turn, and simulated weeks over a fake clock, one of them with an errand that runs an hour.
// The edge scenarios of the long run are checked on their own: a send and an edit of exactly the adapter's `maxChars`,
// a send of exactly `maxFiles` attachments, queued events replayed in order after a restart, a duplicate event at
// exactly the door's capacity, the request rails biting in a turn, a turn's writes through the memory writer, edits and
// a deletion of quiet lines with what memory keeps of them, an errand and a turn cut off by a restart, errands
// answered by a fake agent behind the real runner server, a diary entry refused halfway at one of two mirrors, and the
// status card and the memory browser through the command line, the Discord interface over a client with no gateway,
// the owner's chat drawn in a fake terminal, a video link watched through stand-ins of its tools over a local file, and
// web searches and page reads answered by the provider's answer and a local page, then from the cache. A scripted
// model and the fake interface stand in for the provider and the platform. The long run is the same code with a bigger
// plan.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeAdapter } from '../../../scripts/lib/fake.ts';
import { createLedger, directiveOf, faultRun, observe } from '../../../scripts/lib/fault-run.ts';
import type { Plan } from '../../../scripts/lib/fault-run.ts';
import { withCapturedLogs } from '../../fixtures/capture-logs.ts';

test('the ledger names a key that happened twice and a key that never happened', () => {
  const ledger = createLedger();
  ledger.record('send', 'c1:a');
  ledger.record('send', 'c1:a');
  ledger.record('send', 'c1:b');
  assert.deepEqual(ledger.repeats(), [['send:c1:a', 2]]);
  assert.deepEqual(ledger.missing(['send:c1:a', 'send:c1:b', 'send:c1:c']), ['send:c1:a', 'send:c1:c']);
});

test('observe counts a send by chat and text and a reaction by message, and the adapter still acts', async () => {
  const adapter = createFakeAdapter({ selfId: 'self-id' });
  adapter.seedChat({
    id: 'c1',
    kind: 'channel',
    rootId: 'g1',
    name: 'room',
    topic: null,
    iface: 'fake',
    permissions: { read: true, send: true, attach: true, react: true },
    owner: null,
    lastMessageAt: null,
    voice: false,
    public: true,
    audience: null,
  });
  const ledger = createLedger();
  observe(adapter, ledger);
  const ref = { iface: 'fake', chatId: 'c1' };
  const sent = await adapter.send(ref, { text: 'hello' });
  await adapter.send(ref, { text: 'hello' });
  const first = adapter.messagesIn('c1')[0];
  assert.ok(first, 'the adapter stored what was sent');
  await adapter.react({ ...ref, messageId: first.ref.messageId }, '👍');
  assert.equal(sent.status, 'ok');
  assert.deepEqual(
    [...ledger.counts()],
    [
      ['send:c1:hello', 2],
      [`react:c1/${first.ref.messageId}/👍`, 1],
    ]
  );
});

test('observe counts a refused send and a refused edit as failed, and an edit by its chat and text', async () => {
  const adapter = createFakeAdapter({ selfId: 'self-id', capabilities: { maxChars: 5, maxFiles: 1 } });
  adapter.seedChat({
    id: 'c1',
    kind: 'channel',
    rootId: 'g1',
    name: 'room',
    topic: null,
    iface: 'fake',
    permissions: { read: true, send: true, attach: true, react: true },
    owner: null,
    lastMessageAt: null,
    voice: false,
    public: true,
    audience: null,
  });
  const ledger = createLedger();
  observe(adapter, ledger);
  const ref = { iface: 'fake', chatId: 'c1' };
  const file = { name: 'a.png', data: new Uint8Array([1]) };
  await adapter.send(ref, { text: 'one', attachments: [file] });
  await adapter.send(ref, { text: 'two', attachments: [file, file] });
  const first = adapter.messagesIn('c1')[0];
  assert.ok(first, 'the adapter stored the first send');
  await adapter.edit({ ...ref, messageId: first.ref.messageId }, { text: 'short' });
  await adapter.edit({ ...ref, messageId: first.ref.messageId }, { text: 'longer' });
  assert.deepEqual(
    [...ledger.counts()],
    [
      ['send:c1:one [files: 1]', 1],
      ['failed:send:c1:two [files: 2]', 1],
      ['edit:c1:short', 1],
      ['failed:edit:c1:longer', 1],
    ]
  );
});

test('the ledger lists its keys in the order they happened, every repeat included', () => {
  const ledger = createLedger();
  ledger.record('ingest', 'q2');
  ledger.record('ingest', 'q1');
  ledger.record('ingest', 'q2');
  assert.deepEqual(ledger.order(), ['ingest:q2', 'ingest:q1', 'ingest:q2']);
});

test('a directive comes from the newest chat line of a message turn and from the due intention of a wake', () => {
  // One handle per person: a line's author is the handle alone (authors.line).
  const chat = '<chat>\\n#1 [10:00] @u1ab: do:say:old\\n#2 [10:01] @u1ab: do:react:new\\n</chat>';
  assert.deepEqual(directiveOf(chat, false), { verb: 'react', word: 'new', line: 2 });
  const wake = '<wake>\\nIntention i1 is due: do:say:later. This is your earlier decision.\\n</wake>' + chat;
  assert.deepEqual(directiveOf(wake, false), { verb: 'say', word: 'later', line: null });
});

test('a request that follows a tool result, or reminds the persona of an open intention, carries no directive', () => {
  const chat = '<chat>\\n#1 [10:00] @u1ab: do:say:old\\n</chat>';
  assert.equal(directiveOf(chat, true), null);
  assert.equal(directiveOf(`${chat} Intentions you woke for that you have not changed yet: i1.`, false), null);
});

/** The short run: one round, five repeats, four weeks, no edge scenarios. */
const SHORT_PLAN: Plan = {
  rounds: 1,
  repeats: 5,
  weeks: ['hour-errand', 'restart', 'recurring', 'stalled-errand'],
  edges: [],
};

test(
  'the short run counts every effect once: no key repeats and every expected effect happened',
  { timeout: 30_000 },
  async () => {
    const report = await withCapturedLogs(() => faultRun(SHORT_PLAN));
    const rows = report.result.rows;
    assert.deepEqual(
      rows.map((row) => row.scenario),
      ['live core, round 1', 'week hour-errand', 'week restart', 'week recurring', 'week stalled-errand']
    );
    for (const row of rows) {
      assert.deepEqual(row.repeats, [], `${row.scenario} repeated an effect`);
      assert.deepEqual(row.missing, [], `${row.scenario} missed an effect`);
      assert.ok(row.effects > 0, `${row.scenario} counted nothing`);
    }
    assert.equal(report.result.ok, true);
  }
);

test(
  'the live round posts the delivered part of a partial send, tries a retryable send once and answers errand results',
  { timeout: 30_000 },
  async () => {
    const report = await withCapturedLogs(() => faultRun({ rounds: 1, repeats: 1, weeks: [], edges: [] }));
    const [row] = report.result.rows;
    assert.ok(row, 'the round ran');
    const keys = new Map(row.keys);
    assert.equal(keys.get('send:c1:first r1-six'), 1);
    assert.equal(keys.get('failed:send:c1:second r1-six'), 1);
    assert.equal(keys.get('send:c1:second r1-six'), undefined);
    assert.equal(keys.get('failed:send:c1:said r1-seven'), 1);
    assert.equal(keys.get('send:c1:said r1-eight'), 1);
    assert.equal(keys.get('send:c2:said r1-nine'), 1);
  }
);

test(
  'the edge scenarios post a text and an edit of exactly maxChars and a send of exactly maxFiles, replay queued events ' +
    'in order after a restart and handle again an event the door forgot past its capacity',
  { timeout: 60_000 },
  async () => {
    const report = await withCapturedLogs(() =>
      faultRun({
        rounds: 0,
        repeats: 1,
        weeks: [],
        edges: ['message limits', 'replay after a restart', 'door capacity'],
      })
    );
    const rows = report.result.rows;
    assert.deepEqual(
      rows.map((row) => row.scenario),
      ['edge, message limits', 'edge, replay after a restart', 'edge, door capacity']
    );
    for (const row of rows) {
      assert.deepEqual(row.repeats, [], `${row.scenario} repeated an effect`);
      assert.deepEqual(row.missing, [], `${row.scenario} missed an effect`);
    }
    const [limits, replay, door] = rows;
    assert.ok(limits && replay && door, 'every edge scenario ran');
    assert.deepEqual(
      limits.keys.filter(([key]) => key.startsWith('failed:')),
      [],
      'a message at the limits was refused'
    );
    assert.equal(limits.keys.filter(([key]) => key.startsWith('edit:')).length, 1);
    assert.equal(limits.keys.filter(([key]) => key.endsWith('[files: 1]')).length, 1);
    assert.deepEqual(replay.order, [
      'ingest:fake:message:edge-q1',
      'ingest:fake:message:edge-q2',
      'ingest:fake:message:edge-q3',
    ]);
    assert.deepEqual(new Map(door.keys).get('ack:past-capacity:ok'), 1);
  }
);

test(
  'a turn past the day cap of requests is refused before anything reaches the provider and posts the notice of the ' +
    'cap, and a token cap below the required prompt refuses the turn with nothing sent and posts the notice of the cap',
  { timeout: 60_000 },
  async () => {
    const report = await withCapturedLogs(() =>
      faultRun({ rounds: 0, repeats: 1, weeks: [], edges: ['request limits'] })
    );
    const [row] = report.result.rows;
    assert.ok(row, 'the scenario ran');
    assert.equal(row.scenario, 'edge, request limits');
    assert.deepEqual(row.repeats, []);
    assert.deepEqual(row.missing, []);
    const keys = row.keys.map(([key]) => key);
    assert.equal(keys.includes('send:c1:said cap-two'), false, 'the turn past the cap answered');
    assert.equal(
      keys.filter((key) => key.startsWith('send:c1:') && key.includes('llm.maxRequestsPerDay')).length,
      1,
      'the notice of the spent cap was not posted once'
    );
    assert.equal(keys.includes('send:c1:said cap-three'), false, 'the turn over the token cap answered');
    // The turn over the token cap ends `refused` with the cap's limit, so its caller posts the notice where an `error`
    // posted nothing.
    assert.equal(
      keys.filter((key) => key.startsWith('send:c1:') && key.includes('llm.maxRequestTokens')).length,
      1,
      'the notice of the token cap was not posted once'
    );
    // The notice names the scenario's configured `llm.maxRequestTokens` (1000) as its cap, and an estimate above it.
    const figures = keys.map((key) => /llm\.maxRequestTokens, (\d+)\/(\d+)/.exec(key)).find((match) => match !== null);
    assert.ok(figures, keys.join('\n'));
    assert.equal(Number(figures[2]), 1000);
    assert.ok(Number(figures[1]) > 1000, figures[0]);
  }
);

test(
  'a turn that sets an intention stores one pending row due after its creation by the asked time, through the writer',
  { timeout: 60_000 },
  async () => {
    const report = await withCapturedLogs(() =>
      faultRun({ rounds: 0, repeats: 1, weeks: [], edges: ['memory writes'] })
    );
    const [row] = report.result.rows;
    assert.ok(row, 'the scenario ran');
    assert.deepEqual(row.repeats, []);
    assert.deepEqual(row.missing, []);
    const keys = new Map(row.keys);
    assert.equal(keys.get('intention:pending:120:group:0:0'), 1);
    assert.equal(keys.get('rows:intentions:1'), 1);
    assert.equal(
      row.keys.some(([key]) => key.startsWith('rows:leases:')),
      false,
      'the lease of the running core was counted'
    );
  }
);

test(
  'memory keeps every revision of an edited line and a deleted line beside its text, and shows the newest revision',
  { timeout: 60_000 },
  async () => {
    const report = await withCapturedLogs(() =>
      faultRun({ rounds: 0, repeats: 1, weeks: [], edges: ['message edits'] })
    );
    const [row] = report.result.rows;
    assert.ok(row, 'the scenario ran');
    assert.deepEqual(row.repeats, []);
    assert.deepEqual(row.missing, []);
    assert.deepEqual(
      row.keys.map(([key]) => key).filter((key) => key.startsWith('line:')),
      [
        'line:ed-m1:seen:1:edit base:0',
        'line:ed-m1:seen:2:edit second:0',
        'line:ed-m1:seen:3:edit third:0',
        'line:ed-m2:deleted:null:null:0',
        'line:ed-m2:seen:1:gone soon:0',
      ]
    );
    const keys = new Map(row.keys);
    assert.equal(keys.get('shown:edit base:no'), 1, 'the request showed a replaced revision');
    assert.equal(keys.get('shown:edit third:yes'), 1, "the persona's request missed the newest revision");
  }
);

test(
  'an errand cut off by a restart fails disconnected, its result turn opens again in the new core, and the late end ' +
    'of its agent changes nothing',
  { timeout: 60_000 },
  async () => {
    const report = await withCapturedLogs(() =>
      faultRun({ rounds: 0, repeats: 1, weeks: [], edges: ['recovery after a restart'] })
    );
    const [row] = report.result.rows;
    assert.ok(row, 'the scenario ran');
    assert.deepEqual(row.repeats, []);
    assert.deepEqual(row.missing, []);
    const keys = row.keys.map(([key]) => key);
    assert.deepEqual(
      keys.filter((key) => key.includes('->')),
      [
        'board:write rc-one:approved->in_progress',
        'board:write rc-one:in_progress->failed',
        'board:write rc-one:null->approved',
      ]
    );
    assert.equal(keys.includes('send:c1:said rc-two'), false, 'the stopped core posted from its cut-off turn');
  }
);

test(
  'errands are filed, moved through their states, answered by the agent and handed back to the persona once each',
  { timeout: 60_000 },
  async () => {
    const report = await withCapturedLogs(() => faultRun({ rounds: 0, repeats: 1, weeks: [], edges: ['errands'] }));
    const [row] = report.result.rows;
    assert.ok(row, 'the scenario ran');
    assert.deepEqual(row.repeats, []);
    assert.deepEqual(row.missing, []);
    const keys = new Map(row.keys);
    assert.equal(keys.get('board:write er-two:failed:agent-failed:read'), 1, 'the failed errand lost why it failed');
    assert.equal(keys.get('board:write er-one:outbox done delivered'), 1);
    assert.equal(keys.get('board:write er-two:outbox failed delivered'), 1);
  }
);

test(
  'a diary entry refused halfway at one of two mirrors keeps its first message and sends only the rest when drained',
  { timeout: 30_000 },
  async () => {
    const report = await withCapturedLogs(() =>
      faultRun({ rounds: 0, repeats: 1, weeks: [], edges: ['partial mirror delivery'] })
    );
    const [row] = report.result.rows;
    assert.ok(row, 'the scenario ran');
    assert.deepEqual(row.repeats, [], 'a message of the entry went out twice');
    assert.deepEqual(row.missing, []);
    assert.deepEqual(
      row.order?.filter((key) => key.includes(':c2:part')),
      ['send:c2:part one', 'failed:send:c2:part two', 'send:c2:part two']
    );
  }
);

test(
  'the short and the full status card count the requests and the pending intention of a conversation, the full card ' +
    'names every model role and counts the record and the errands, and the memory browser shows the lines, through ' +
    'the command line over the core socket',
  { timeout: 60_000 },
  async () => {
    const report = await withCapturedLogs(() =>
      faultRun({ rounds: 0, repeats: 1, weeks: [], edges: ['command line'] })
    );
    const [row] = report.result.rows;
    assert.ok(row, 'the scenario ran');
    assert.deepEqual(row.repeats, []);
    assert.deepEqual(row.missing, []);
    const answer = (prefix: string): string => row.keys.find(([key]) => key.startsWith(prefix))?.[0] ?? '';
    const status = answer('command:status:ok:');
    assert.match(status, /over 5 requests/);
    assert.match(status, /intentions: 1 pending, 0 waiting/);
    const full = answer('command:status full:ok:');
    const roles = ['core', 'memory', 'analyzer', 'vision', 'video', 'embedding', 'speech', 'drawing'];
    assert.match(full, new RegExp(`\\[models\\.base\\]\\n${roles.map((role) => `${role} · .+\\n`).join('')}\\n`));
    assert.match(full, /core: 3 requests/);
    assert.match(full, /analyzer: 2 requests/);
    assert.match(full, /\[inner\]\n\S+ · running\n/);
    assert.match(full, /next wake <minute> UTC \(intention\)/);
    assert.match(full, /intentions · 1 pending · 0 waiting/);
    assert.match(full, /record: 3 messages · <day>\.\.<day> · 100% of days have lines/);
    assert.match(full, /profiles: 1 ·/);
    assert.match(
      full,
      /\[costs\.errands\]\ncode · no runs recorded\nscout · no runs recorded\nserver · no runs recorded\n/
    );
    assert.match(answer('command:memory conversation c1:ok:'), /do:intend:cl-one\nEleni: do:say:cl-two\n/);
  }
);

test(
  "the Discord interface carries a member's asks to the core and the persona's answers and edit to the platform, and " +
    'the request shows a line read from the platform and only the newest revision of an edited line',
  { timeout: 60_000 },
  async () => {
    const report = await withCapturedLogs(() => faultRun({ rounds: 0, repeats: 1, weeks: [], edges: ['discord'] }));
    const [row] = report.result.rows;
    assert.ok(row, 'the scenario ran');
    assert.equal(row.scenario, 'edge, discord');
    assert.deepEqual(row.repeats, []);
    assert.deepEqual(row.missing, []);
    assert.equal(new Map(row.keys).get('shown:typo here:no'), 1, 'the request showed a replaced revision');
  }
);

test(
  "the owner's chat in a terminal sends a typed line, draws the persona's answer under it and shows a command's answer",
  { timeout: 60_000 },
  async () => {
    const report = await withCapturedLogs(() => faultRun({ rounds: 0, repeats: 1, weeks: [], edges: ['terminal'] }));
    const [row] = report.result.rows;
    assert.ok(row, 'the scenario ran');
    assert.deepEqual(row.repeats, []);
    assert.deepEqual(row.missing, []);
    assert.deepEqual(
      row.order?.filter((key) => key.startsWith('screen:[')),
      [
        'screen:[2026-11-01 12:00]',
        'screen:[#1] do:say:tm-one',
        'screen:[#2] said tm-one',
        'screen:[2026-11-01 12:00] [#1] /intentions',
      ]
    );
  }
);

test(
  'a video link is probed and its clip downloaded from a local file, the clip reaches the video request, and the ' +
    "description reaches the turn's request",
  { timeout: 60_000 },
  async () => {
    const report = await withCapturedLogs(() => faultRun({ rounds: 0, repeats: 1, weeks: [], edges: ['video'] }));
    const [row] = report.result.rows;
    assert.ok(row, 'the scenario ran');
    assert.equal(row.scenario, 'edge, video');
    assert.deepEqual(row.repeats, [], 'a tool ran twice or the clip was watched twice');
    assert.deepEqual(row.missing, []);
  }
);

test(
  "web.search and web.read give the provider's results and the page's main text, and a second call of each is " +
    'answered from the cache with nothing sent',
  { timeout: 60_000 },
  async () => {
    const report = await withCapturedLogs(() => faultRun({ rounds: 0, repeats: 1, weeks: [], edges: ['web'] }));
    const [row] = report.result.rows;
    assert.ok(row, 'the scenario ran');
    assert.deepEqual(row.repeats, []);
    assert.deepEqual(row.missing, []);
    const result = (step: string): string => {
      const prefix = `result:${step}:`;
      return row.keys.find(([key]) => key.startsWith(prefix))?.[0].slice(prefix.length) ?? '';
    };
    assert.match(
      result('search wb-one'),
      /1\. Why cats push cups off tables\nhttps:\/\/pets\.test\/why-cats-push-cups/
    );
    assert.match(result('read wb-one'), /people come running/);
    assert.doesNotMatch(result('read wb-one'), /Related reading/, 'an aside of the article was read as its text');
    assert.equal(result('search wb-two'), result('search wb-one'), 'the cached search answered otherwise');
    assert.equal(result('read wb-two'), result('read wb-one'), 'the cached page answered otherwise');
  }
);

test('the live round of the fault run reads every address verdict it scripted', async () => {
  const { logs } = await withCapturedLogs(() => faultRun({ rounds: 1, repeats: 1, weeks: [], edges: [] }));
  const failed = logs.filter((entry) => entry.msg === 'follow-up: classifier failed');
  assert.deepEqual(
    failed.map((entry) => String(entry.reason)),
    []
  );
});
