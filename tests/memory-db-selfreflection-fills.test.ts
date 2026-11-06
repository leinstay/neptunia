// The listeners of the owner's diary fills (src/memory/db/selfreflection-fills.ts): a subscriber is told once after a
// plan or audience fill that wrote an entry, not after a fill that wrote nothing, a dry run or another kind of write,
// and one that throws neither stops the others nor reaches the caller. Fakes only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selfreflectionFills } from '../src/memory/db/selfreflection-fills.ts';
import type { Row } from '../src/memory/db/types.ts';

/** A write that ignores its update and answers with what `make` gives. */
const answer = (make: () => Promise<unknown>) => (update: Row) => {
  void update;
  return make();
};

function rig() {
  const warnings: Array<{ message: string; fields?: Row }> = [];
  const fills = selfreflectionFills({
    warn(message, fields) {
      warnings.push({ message, fields });
    },
  });
  let told = 0;
  fills.on(() => {
    told += 1;
  });
  return { fills, warnings, told: () => told };
}

test('tells a subscriber once after a plan fill that wrote', async () => {
  const { fills, told } = rig();
  const write = fills.after(
    answer(() => Promise.resolve({ written: 3 })),
    'selfreflection-plan-fill'
  );
  assert.deepEqual(await write({}), { written: 3 });
  assert.equal(told(), 1);
});

test('takes the kind from the update when none is given, for an audience fill', async () => {
  const { fills, told } = rig();
  const write = fills.after(answer(() => Promise.resolve({ written: 1 })));
  await write({ kind: 'selfreflection-audience-fill' });
  assert.equal(told(), 1);
});

test('does not tell after a fill that wrote nothing', async () => {
  const { fills, told } = rig();
  await fills.after(
    answer(() => Promise.resolve({ written: 0 })),
    'selfreflection-plan-fill'
  )({});
  assert.equal(told(), 0);
});

test('does not tell after a dry run that counts entries', async () => {
  const { fills, told } = rig();
  await fills.after(
    answer(() => Promise.resolve({ written: 4, dryRun: true })),
    'selfreflection-plan-fill'
  )({});
  assert.equal(told(), 0);
});

test('does not tell after a write of another kind', async () => {
  const { fills, told } = rig();
  await fills.after(
    answer(() => Promise.resolve({ written: 2 })),
    'session-commit'
  )({});
  assert.equal(told(), 0);
});

test('does not tell when the write fails, and passes the failure on', async () => {
  const { fills, told } = rig();
  const write = fills.after(
    answer(() => Promise.reject(new Error('DB_CLOSED'))),
    'selfreflection-plan-fill'
  );
  await assert.rejects(write({}), /DB_CLOSED/);
  assert.equal(told(), 0);
});

test('a subscriber that throws does not stop the others and is logged by code only', async () => {
  const { fills, warnings, told } = rig();
  fills.on(() => {
    throw Object.assign(new Error('secret message text'), { code: 'BOOM' });
  });
  let last = 0;
  fills.on(() => {
    last += 1;
  });
  const result = await fills.after(
    answer(() => Promise.resolve({ written: 1 })),
    'selfreflection-plan-fill'
  )({});
  assert.deepEqual(result, { written: 1 });
  assert.equal(told(), 1);
  assert.equal(last, 1);
  assert.equal(warnings.length, 1);
  assert.deepEqual(warnings[0].fields, { code: 'BOOM' });
  assert.ok(!JSON.stringify(warnings[0]).includes('secret'));
});

test('an unsubscribed listener is no longer told', async () => {
  const { fills } = rig();
  let calls = 0;
  const off = fills.on(() => {
    calls += 1;
  });
  off();
  await fills.after(
    answer(() => Promise.resolve({ written: 1 })),
    'selfreflection-plan-fill'
  )({});
  assert.equal(calls, 0);
});
