// What the watcher reads of the standards (master plan U.2, U.3): `standardFacts` over a read connection sums what the
// turns and the describer recorded in the observation window, counts only, and the first evidence page carries it as
// `standards`. The counts come from what the real journal and the real store wrote. Synthetic text only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readConfig } from '../src/config.ts';
import { localConfigPath } from '../src/config/files.ts';
import { placeOfCommunity } from '../src/memory/addresses.ts';
import { openMemoryDb } from '../src/memory/db/open.ts';
import { dbOf } from '../src/memory/db/types.ts';
import { createDescriber } from '../src/memory/describe.ts';
import { createJournal } from '../src/memory/journal.ts';
import { createStore } from '../src/memory/store.ts';
import { serviceFamily } from '../src/service/commands.ts';
import { standardFacts } from '../src/watcher/requests.ts';
import { fakeImageFetcher, fakeLlm, fakeState, fakeVideoFetcher } from './fixtures/describe-fakes.ts';
import { openTestMemory } from './fixtures/memory-db/service.ts';
import { tempDir } from './fixtures/tmp.ts';
import { NOW, coreTurn } from './fixtures/turn-harness.ts';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const ZERO = {
  thinkMissing: 0,
  thinkLeaked: 0,
  leakEnded: 0,
  tagInOutgoing: 0,
  thinkOffScript: 0,
  descriptionsRedescribed: 0,
  descriptionsMarked: 0,
};
const WINDOW = { from: NOW - 60_000, to: NOW + 60_000 };
const LEAK_WORDS = 'ΛΕΞΕΙΣ-ΤΗΣ-ΣΚΕΨΗΣ';
const DESCRIPTION_WORDS = 'Μια γκρίζα γάτα κοιμάται';

/** Runs `work` over a real memory database, then reads what the watcher reads from the closed file. */
async function readAfter(
  work: (memory: Awaited<ReturnType<typeof openTestMemory>>) => Promise<void>,
  window: { from: number; to: number } = WINDOW
) {
  const memory = await openTestMemory({ now: () => NOW });
  await work(memory);
  const file = path.join(memory.dataDir, 'memory.db');
  await memory.close();
  const handle = openMemoryDb(file, { readOnly: true });
  try {
    return standardFacts(dbOf(handle), window);
  } finally {
    handle.close();
  }
}

/** A turn's answers through a real journal over `memory`. */
async function turnsOver(memory: Awaited<ReturnType<typeof openTestMemory>>, answers: ReadonlyArray<string>) {
  let n = 0;
  const journal = createJournal({
    memoryDb: memory.memoryDb,
    dataDir: memory.dataDir,
    config: () => ({ thinkChars: 4000 }),
    now: () => NOW,
    uuid: () => `standard-${(n += 1)}`,
  });
  await coreTurn({ answers, journal });
  await journal.flush?.();
}

// Bug: an empty database or a window with nothing in it fails the evidence page instead of saying zero.
test('with nothing recorded every count is zero', async () => {
  assert.deepEqual(await readAfter(() => Promise.resolve()), ZERO);
});

// Bug: the turn counts stay in the journal's record, where nothing adds them up, so the report cannot show them.
test('the counts of a turn ended by a leak are readable', async () => {
  const facts = await readAfter((memory) =>
    turnsOver(memory, [`${LEAK_WORDS}</think><msg>χαμένο</msg>`, `<think>${LEAK_WORDS} <msg>χαμένο</msg>`])
  );
  assert.equal(facts.thinkLeaked, 2);
  assert.equal(facts.leakEnded, 1);
  assert.equal(JSON.stringify(facts).includes(LEAK_WORDS), false);
});

// Bug: a reply with no think is counted in the record and lost on the way to the watcher.
test('a reply with no think is readable', async () => {
  const facts = await readAfter((memory) => turnsOver(memory, ['<msg>γεια</msg>']));
  assert.equal(facts.thinkMissing, 1);
});

// Bug: a report sums everything ever recorded and each interval repeats yesterday's failures.
test('a turn outside the window is not counted', async () => {
  const facts = await readAfter((memory) => turnsOver(memory, ['<msg>γεια</msg>']), {
    from: NOW + 60_000,
    to: NOW + 120_000,
  });
  assert.equal(facts.thinkMissing, 0);
});

// Bug: the marks live on a cache entry and a restart or a trim erases the count.
test('a description described again and one kept and marked are readable, with no words of them', async () => {
  const facts = await readAfter(async (memory) => {
    const store = createStore({ dataDir: memory.dataDir, memoryDb: memory.memoryDb });
    const llm = fakeLlm(
      [DESCRIPTION_WORDS, 'A grey cat sleeps', DESCRIPTION_WORDS, DESCRIPTION_WORDS].map((text) => ({
        text,
        usage: {},
        estimated: 1,
      }))
    );
    const describer = createDescriber({
      hot: {
        config: {
          models: { base: { vision: 'x/vision' } },
          media: { maxOutputTokens: 120 },
          context: { vision: { fetchTimeoutMs: 10_000 } },
        },
        prompts: { describe: 'Describe this picture.' },
      },
      store,
      llm,
      imageFetcher: fakeImageFetcher(),
      videoFetcher: fakeVideoFetcher(),
      state: fakeState(),
      now: () => NOW,
    });
    const place = placeOfCommunity(store, 'g1');
    await describer.describe(place, { itemId: 'a1', kind: 'image', url: 'https://cdn.discordapp.com/x/1.png' });
    await describer.describe(place, { itemId: 'a2', kind: 'image', url: 'https://cdn.discordapp.com/x/2.png' });
    await store.flushSettled({ final: true });
  });
  assert.equal(facts.descriptionsRedescribed, 2);
  assert.equal(facts.descriptionsMarked, 1);
  assert.equal(JSON.stringify(facts).includes(DESCRIPTION_WORDS), false);
});

// Bug: the counts exist and no report ever sees them, because the evidence page never carries them.
test('the first evidence page carries the counts', async () => {
  const data = tempDir('nep-standard-evidence-');
  fs.mkdirSync(path.dirname(localConfigPath(data)), { recursive: true });
  fs.writeFileSync(localConfigPath(data), '{}');
  fs.mkdirSync(path.join(data, 'agents', 'watcher', 'reports'), { recursive: true });
  openMemoryDb(path.join(data, 'memory.db')).close();
  const answer = await serviceFamily(
    {
      rootDir: REPO,
      privateDir: data,
      dataDir: data,
      config: () => readConfig(REPO, { privateDir: data }),
      now: () => NOW,
      env: { NEPTUNIA_UNIT_SCOPE: 'user', XDG_CONFIG_HOME: data },
      coreUp: false,
      run: () => Promise.resolve({ code: 1, stdout: '', stderr: 'unavailable here' }),
    },
    'service.watcher.evidence',
    {}
  );
  assert.equal(answer.status, 'ok');
  assert.deepEqual((JSON.parse(answer.text) as { standards: unknown }).standards, ZERO);
});
