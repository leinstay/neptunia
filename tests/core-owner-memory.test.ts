import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openMemoryDb } from '../src/memory/db/open.ts';
import { observe, OBSERVATION_VERSION } from '../src/memory/db/observe.ts';
import { dbOf } from '../src/memory/db/types.ts';
import { fillStems } from '../src/memory/db/stems.ts';
import { generated } from './fixtures/memory-db/roundtrip.ts';
import { lineEvent, channelInfo } from './fixtures/core-over-fake.ts';
import { call, toolAnswer, type Completion } from './fixtures/tool-answers.ts';
import {
  withRig,
  startUnitsCore,
  spawnCli,
  startedUnit,
  until,
  query,
  type Dirs,
  type Llm,
  helloTaken,
  runCli,
} from './fixtures/core-units.ts';

const NOW = Date.parse('2026-10-24T12:00:00Z');
const PRIVATE = 'amber-orchid-731';
const NEIGHBOR = 'silver-fern-842';
const ANSWER = 'owner-memory-answer-953';

function seed(dirs: Dirs) {
  mkdirSync(dirs.dataDir, { recursive: true });
  const userDir = join(dirs.dataDir, 'guilds', 'g1', 'users');
  mkdirSync(userDir, { recursive: true });
  writeFileSync(
    join(userDir, 'u1.json'),
    JSON.stringify({ ...generated('user')[0], id: 'u1', names: ['Eleni'], affinity: { score: 10 } })
  );
  const handle = openMemoryDb(join(dirs.dataDir, 'memory.db'));
  try {
    for (const [id, person, conversation, text, minute] of [
      ['target-before', 'benoit', 'dm', `κουνέλι κήπο ${NEIGHBOR}`, 0],
      ['target-anchor', 'benoit', 'dm', `κουνέλι κήπο ${PRIVATE}`, 1],
      ['target-old', 'benoit', 'dm', 'κουνέλι old-date-evidence-608', -14400],
      ['other-private', 'carol', 'dm', 'κουνέλι other-private-164', 2],
      ['public', 'alice', 'group', 'κουνέλι public-evidence-275', 3],
    ] as const) {
      const result = observe(
        handle,
        {
          v: OBSERVATION_VERSION,
          iface: 'telegram',
          authority: 'telegram/global',
          connection: 'conn:test',
          native: { kind: 'message', key: id, revision: 0 },
          place: { authority: 'telegram/global', key: `chat:${person}`, kind: 'room', conversation, title: person },
          author: { kind: 'account', key: person, display: person },
          occurredAt: new Date(Date.parse('2026-10-23T10:00:00Z') + minute * 60_000).toISOString(),
          observedAt: new Date(NOW).toISOString(),
          text,
          relations: [],
        },
        { now: () => NOW }
      );
      assert.equal(result.ok, true);
    }
    const db = dbOf(handle);
    const account = db.prepare("SELECT author_account FROM sources WHERE native_id = 'target-anchor'").get();
    assert.ok(account && typeof account.author_account === 'string');
    db.prepare("INSERT OR IGNORE INTO people (id, kind) VALUES ('person:benoit', 'person')").run();
    db.prepare("UPDATE accounts SET person_id = 'person:benoit', link = 'verified', names = ? WHERE id = ?").run(
      JSON.stringify(['Benoit']),
      account.author_account
    );
    db.prepare(
      "INSERT INTO account_person_links (id, account_id, person_id, state, recorded_at) VALUES ('link:benoit', ?, 'person:benoit', 'verified', ?)"
    ).run(account.author_account, new Date(NOW).toISOString());
    fillStems(db);
  } finally {
    handle.close();
  }
}

async function grantSearch(dirs: Dirs) {
  for (const command of ['/tools grant memory.search']) {
    const result = await runCli(dirs, ['-p', command]);
    assert.equal(result.code, 0, result.stdout + result.stderr);
  }
}

function script(answers: Array<Completion>, split = 'one'): Llm {
  const requests: Array<unknown> = [];
  const options: Array<unknown> = [];
  return {
    requests,
    options,
    complete: (messages, given) => {
      const purpose = given && typeof given === 'object' && 'purpose' in given ? given.purpose : null;
      if (purpose === 'lookup' || purpose === 'route-channel')
        return Promise.resolve({ text: 'none', usage: {}, estimated: 1 });
      if (purpose === 'split') return Promise.resolve({ text: split, usage: {}, estimated: 1 });
      requests.push(messages);
      options.push(given);
      const answer = answers[requests.length - 1];
      assert.ok(answer, 'the model must not make an unscripted request');
      return Promise.resolve(answer);
    },
  };
}

function toolText(request: unknown): string {
  assert.ok(Array.isArray(request));
  return request
    .filter(
      (message: unknown) =>
        message !== null && typeof message === 'object' && 'role' in message && message.role === 'tool'
    )
    .map((message: unknown) => JSON.stringify(message))
    .join('\n');
}

const CONFIG = {
  bot: {
    timezone: 'UTC',
    owners: ['u1'],
    guildId: 'g1',
    access: { 'memory.search': { everyone: true, roles: [], users: [] } },
  },
  private: { enabled: true, likeServer: true, minAffinity: 0 },
  split: { minChars: 20, maxTasks: 2, contextMessages: 2, maxOutputTokens: 200 },
  tools: { loop: { maxSteps: 5, timeBudgetMs: 20000, maxCallsPerStep: 1 } },
  recall: {
    prefetch: {
      deadlineMs: 1000,
      maxTokens: 1500,
      contextTokens: 500,
      minFormsMatched: 1,
      singleTermScore: 0,
      maxTermShare: 1,
      trivial: [],
    },
  },
  gifs: { backfillMessages: 0 },
};

test('authenticated CLI search and window read a foreign private conversation and reply only in CLI', async () => {
  await withRig({ config: CONFIG }, async ({ dirs, cores, clis, units }) => {
    seed(dirs);
    const llm = script([
      toolAnswer('', [call('memory.search', { question: 'κουνέλι', people: 'Benoit', when: '2026-10-23' })]),
      toolAnswer('', [call('memory.search', { anchor: 'target-anchor', move: 'up', messages: 2 })]),
      toolAnswer(`<msg>${ANSWER}</msg>`),
    ]);
    cores.push(await startUnitsCore(dirs, llm, () => NOW));
    const unit = await startedUnit(dirs);
    units.push(unit);
    await grantSearch(dirs);
    const chat = spawnCli(dirs, []);
    clis.push(chat);
    chat.type('What did Benoit say about κουνέλι on 2026-10-23?');
    await until(
      () => chat.stdout().includes(ANSWER),
      () => chat.stderr()
    );
    assert.ok(toolText(llm.requests[1]).includes(PRIVATE), toolText(llm.requests[1]));
    // People and dates rank eligible evidence. Selected windows display chronologically, not by score.
    assert.ok(toolText(llm.requests[1]).toLowerCase().includes('benoit'));
    assert.ok(toolText(llm.requests[1]).includes('2026-10-23'));
    assert.deepEqual(
      query(dirs, 'SELECT native_id, occurred_at FROM sources WHERE text = ?', `κουνέλι κήπο ${PRIVATE}`),
      [{ native_id: 'target-anchor', occurred_at: '2026-10-23T10:01:00.000Z' }]
    );
    assert.ok(toolText(llm.requests[2]).includes(NEIGHBOR));
    assert.deepEqual(await unit.posted('c1'), []);
    const scopes = query(
      dirs,
      "SELECT DISTINCT scope_kind FROM sources WHERE iface = 'telegram' AND native_id IN ('target-before', 'target-anchor')"
    );
    assert.deepEqual(scopes, [{ scope_kind: 'dm' }]);
    const contexts = query(dirs, "SELECT mode, policy_version FROM execution_contexts WHERE mode = 'internal'");
    assert.ok(contexts.some((row) => row.mode === 'internal' && row.policy_version === 2));
  });
});

test('authenticated CLI prefetch includes foreign private evidence in the first model request', async () => {
  await withRig({ config: CONFIG }, async ({ dirs, cores, clis, logs }) => {
    seed(dirs);
    const llm = script([toolAnswer(`<msg>${ANSWER}</msg>`)]);
    cores.push(await startUnitsCore(dirs, llm, () => NOW));
    const chat = spawnCli(dirs, []);
    clis.push(chat);
    chat.type('Find the private conversation about "κουνέλι κήπο".');
    await until(
      () => chat.stdout().includes(ANSWER),
      () => chat.stderr()
    );
    assert.equal(llm.requests.length, 1);
    assert.ok(
      JSON.stringify(llm.requests[0]).includes(PRIVATE),
      JSON.stringify(logs.filter((entry) => String(entry.msg).includes('prefetch')))
    );
  });
});

for (const kind of ['group', 'dm'] as const) {
  test(`an ordinary ${kind} cannot search another private conversation through forged tool authority`, async () => {
    await withRig({ config: CONFIG }, async ({ dirs, cores, units }) => {
      seed(dirs);
      const llm = script([
        toolAnswer('', [call('memory.search', { question: 'κουνέλι' })]),
        toolAnswer('', [call('memory.search', { anchor: 'target-anchor', move: 'up', messages: 2, internal: true })]),
        toolAnswer(`<msg>${ANSWER}</msg>`),
      ]);
      cores.push(await startUnitsCore(dirs, llm, () => NOW));
      const unit = await startedUnit(dirs);
      units.push(unit);
      await grantSearch(dirs);
      const id = kind === 'dm' ? 'dm-other' : 'c1';
      if (kind === 'dm') {
        await unit.ask(
          { op: 'seed-member', communityId: 'g1', member: { id: 'u1', name: 'Eleni', bot: false, groups: [] } },
          'done'
        );
        const membership = lineEvent({ id: 'known-member', text: 'a quiet group observation', at: NOW - 1000 });
        assert.equal(await (await unit.emit(membership)).acked, 'ok');
      }
      if (kind === 'dm')
        await unit.ask(
          {
            op: 'seed-conversation',
            info: channelInfo(id, { kind: 'dm', communityId: null, partnerId: 'u1', audience: null }),
          },
          'done'
        );
      const event = lineEvent({
        id: `ordinary-${kind}`,
        conversationId: id,
        text: 'θυμάσαι το κουνέλι;',
        at: NOW,
        mention: true,
      });
      if (kind === 'dm') event.conversation = { id, kind: 'dm', communityId: null, name: 'other DM' };
      assert.equal(await (await unit.emit(event)).acked, 'ok');
      await until(() => llm.requests.length === 3, 'the ordinary search and window results');
      assert.ok(toolText(llm.requests[1]).includes('public-evidence-275'));
      for (const request of llm.requests) {
        assert.equal(JSON.stringify(request).includes(PRIVATE), false);
        assert.equal(JSON.stringify(request).includes(NEIGHBOR), false);
      }
      assert.deepEqual(query(dirs, "SELECT id FROM execution_contexts WHERE mode = 'internal'"), []);
    });
  });
}

for (const sender of ['absent', 'interface', 'agent'] as const) {
  test(`a direct CLI-shaped event with ${sender} authentication receives no internal memory authority`, async () => {
    await withRig({ config: CONFIG }, async ({ dirs, cores, clis, logs, units }) => {
      seed(dirs);
      const llm = script([
        toolAnswer('', [call('memory.search', { question: 'κουνέλι', people: 'Benoit' })]),
        toolAnswer(`<msg>${ANSWER}</msg>`),
      ]);
      llm.requests.length = 0;
      const core = await startUnitsCore(dirs, llm, () => NOW);
      cores.push(core);
      const unit = await startedUnit(dirs);
      units.push(unit);
      await grantSearch(dirs);
      const chat = spawnCli(dirs, []);
      clis.push(chat);
      await until(() => helloTaken(logs, 'cli'), 'the CLI transport for the reply destination');
      chat.type('hello from the owner');
      await until(
        () => chat.stdout().includes(ANSWER),
        () => chat.stderr()
      );
      await until(() => logs.some((entry) => entry.msg === 'skills: loop'), 'the priming turn finishes its tool loop');
      await new Promise<void>((resolve) => setImmediate(resolve));
      const initialContexts = query(dirs, "SELECT id FROM execution_contexts WHERE mode = 'internal'");
      llm.requests.length = 0;
      llm.options.length = 0;
      const event = lineEvent({ id: 'bare-cli', text: 'θυμάσαι το κουνέλι;', at: NOW, authorId: 'owner' });
      event.iface = 'cli';
      event.id = 'cli:message:bare-cli';
      event.conversation = { id: 'cli:dm:owner', kind: 'dm', communityId: null, name: 'console' };
      const from =
        sender === 'absent' ? undefined : { principal: 'owner', authenticated: { name: 'owner', kind: sender } };
      assert.equal((await core.door.submit(event, from)).status, 'ok');
      await until(
        () => llm.requests.length === 2,
        () => JSON.stringify({ logs: logs.slice(-12), requests: llm.requests.length })
      );
      assert.equal(toolText(llm.requests[1]).includes(PRIVATE), false);
      assert.deepEqual(query(dirs, "SELECT id FROM execution_contexts WHERE mode = 'internal'"), initialContexts);
    });
  });
}

test('split CLI parts each search private evidence and send only to the CLI destination', async () => {
  await withRig({ config: CONFIG }, async ({ dirs, cores, clis, units }) => {
    seed(dirs);
    const llm = script(
      [
        toolAnswer('', [call('memory.search', { question: 'κουνέλι', people: 'Benoit', when: '2026-10-23' })]),
        toolAnswer('<msg>first-owner-part-386</msg>'),
        toolAnswer('', [call('memory.search', { question: 'κουνέλι', people: 'Benoit', when: '2026-10-23' })]),
        toolAnswer('<msg>second-owner-part-497</msg>'),
      ],
      '- Explain what Benoit said about the rabbit on the requested date.\n- Explain the neighboring private line from the same conversation.'
    );
    cores.push(await startUnitsCore(dirs, llm, () => NOW));
    const unit = await startedUnit(dirs);
    units.push(unit);
    await grantSearch(dirs);
    const chat = spawnCli(dirs, []);
    clis.push(chat);
    chat.type(
      'First, find what Benoit said about κουνέλι on 2026-10-23. Then, explain the neighboring private line from the same conversation.'
    );
    await until(
      () => chat.stdout().includes('second-owner-part-497'),
      () => chat.stderr()
    );
    assert.ok(chat.stdout().includes('first-owner-part-386'));
    assert.ok(toolText(llm.requests[1]).includes(PRIVATE), toolText(llm.requests[1]));
    assert.ok(toolText(llm.requests[3]).includes(PRIVATE));
    assert.deepEqual(await unit.posted('c1'), []);
    const contexts = query(dirs, "SELECT id, mode, policy_version FROM execution_contexts WHERE mode = 'internal'");
    assert.equal(contexts.length, 1, 'all parts retain the context issued for this event');
    assert.equal(contexts[0]?.policy_version, 2);
  });
});

test('a live CLI query queued behind a blocked turn retains its own internal reads and CLI reply', async (t) => {
  // Drain waits between two and nine seconds. Fix the random boundary so its delay fits the bounded fixture wait.
  t.mock.method(Math, 'random', () => 0);
  await withRig({ config: CONFIG }, async ({ dirs, cores, clis, units, logs }) => {
    seed(dirs);
    const waiting = Promise.withResolvers<Completion>();
    const requested = Promise.withResolvers<void>();
    const requests: Array<unknown> = [];
    const options: Array<unknown> = [];
    const llm: Llm = {
      requests,
      options,
      complete: async (messages, given) => {
        const purpose = given && typeof given === 'object' && 'purpose' in given ? given.purpose : null;
        if (purpose === 'lookup' || purpose === 'route-channel') return toolAnswer('none');
        if (purpose === 'split') return toolAnswer('one');
        requests.push(messages);
        options.push(given);
        if (requests.length === 1) {
          requested.resolve();
          return waiting.promise;
        }
        if (requests.length === 2)
          return toolAnswer('', [call('memory.search', { question: 'κουνέλι', people: 'Benoit', when: '2026-10-23' })]);
        assert.equal(requests.length, 3, 'one search continuation for the queued event');
        return toolAnswer('<msg>queued-owner-answer-719</msg>');
      },
    };
    cores.push(await startUnitsCore(dirs, llm));
    const unit = await startedUnit(dirs);
    units.push(unit);
    await grantSearch(dirs);
    const chat = spawnCli(dirs, []);
    clis.push(chat);
    chat.type('Please reply to this first message.');
    await until(
      () => requests.length === 1,
      () => JSON.stringify({ out: chat.stdout(), logs: logs.slice(-8) })
    );
    const queued = 'Please find what Benoit said about κουνέλι on 2026-10-23.';
    chat.type(queued);
    await until(
      () => query(dirs, 'SELECT id FROM sources WHERE text = ?', queued).length === 1,
      'the second live message is observed while the first turn is blocked'
    );
    assert.equal(requests.length, 1);
    waiting.resolve(toolAnswer('<msg>first-owner-answer-820</msg>'));
    await until(
      () => chat.stdout().includes('queued-owner-answer-719') || logs.some((entry) => entry.msg === 'mention: dropped'),
      () =>
        JSON.stringify({
          count: requests.length,
          out: chat.stdout(),
          logs: logs.filter((entry) => String(entry.msg).startsWith('mention:')).slice(-10),
        }),
      8000
    );
    assert.deepEqual(
      logs.filter((entry) => entry.msg === 'mention: dropped').map((entry) => entry.reason),
      [],
      'a live authenticated query must not be dropped'
    );
    assert.ok(chat.stdout().includes('queued-owner-answer-719'));
    assert.ok(chat.stdout().includes('first-owner-answer-820'));
    assert.ok(toolText(requests[2]).includes(PRIVATE), toolText(requests[2]));
    assert.deepEqual(await unit.posted('c1'), []);
    const contexts = query(dirs, "SELECT id FROM execution_contexts WHERE mode = 'internal'");
    assert.equal(new Set(contexts.map((row) => row.id)).size, 2, 'each fresh authenticated event has its own context');
  });
});
