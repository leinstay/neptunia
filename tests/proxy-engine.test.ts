// src/net/engine-proxy.ts: the engine proxy as the core runs it. The start puts the proxy in force only after a probe
// answers, and a request of the process that cannot reach the proxy (Node's `http.client.request.error` and undici's
// `undici:client:connectError` diagnostics channels) probes it at once and goes direct when the probe fails. The
// probe, the stored URL, the clock and Node's global setter are fakes; the channels are published by the test, so no
// socket opens.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import diagnostics from 'node:diagnostics_channel';
import { startEngineProxy } from '../src/net/engine-proxy.ts';

const PROXY = 'http://login:pass-word@proxy.example:3128';
const REFUSED = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });

const settle = async (): Promise<void> => {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

function engine(answers: Array<boolean | Promise<boolean>>) {
  const sets: Array<Record<string, string>> = [];
  let restores = 0;
  const warnings: Array<{ message: string; fields: Record<string, unknown> }> = [];
  let probes = 0;
  let at = 1_000_000;
  const proxy = startEngineProxy({
    dataDir: '/nonexistent',
    config: () => ({
      proxy: { enabled: true, health: { everySeconds: 600, failures: 3, recoveries: 2, timeoutMs: 1000 } },
    }),
    now: () => at,
    log: { info: () => {}, warn: (message, fields) => warnings.push({ message, fields }) },
    url: () => PROXY,
    probe: () => {
      probes += 1;
      return Promise.resolve(answers.shift() ?? true);
    },
    setGlobal: (env) => {
      sets.push(env);
      return () => {
        restores += 1;
      };
    },
  });
  return {
    proxy,
    sets,
    warnings,
    restores: () => restores,
    probes: () => probes,
    tick: (ms: number) => {
      at += ms;
    },
  };
}

test('the start hands Node no proxy until the first probe answers', async () => {
  // Catches: the core sets a refusing proxy for the whole process at start, so the YouTube check and every fetch of
  // the first minutes fail while the direct route works.
  let answer: (value: boolean) => void = () => {};
  const rig = engine([new Promise<boolean>((resolve) => (answer = resolve))]);
  try {
    await settle();
    assert.equal(rig.sets.length, 0);
    assert.equal(rig.proxy.route(), 'direct');
    answer(true);
    await settle();
    assert.equal(rig.sets.length, 1);
    assert.equal(rig.proxy.route(), 'proxy');
  } finally {
    rig.proxy.stop();
  }
});

for (const channel of ['http.client.request.error', 'undici:client:connectError']) {
  test(`a refused connection on ${channel} goes direct before the next health probe`, async () => {
    // Catches: the core keeps a dead proxy in force for `everySeconds` times `failures`, failing every request.
    const rig = engine([true, false]);
    try {
      await settle();
      assert.equal(rig.proxy.route(), 'proxy');
      rig.tick(5_000);
      diagnostics.channel(channel).publish({ request: {}, connectParams: {}, error: REFUSED });
      await settle();
      assert.equal(rig.proxy.route(), 'direct');
      assert.equal(rig.restores(), 1);
      assert.ok(rig.warnings.some((line) => line.message === 'proxy: switch' && line.fields.change === 'proxy-down'));
    } finally {
      rig.proxy.stop();
    }
  });
}

test('after stop a refused connection probes nothing', async () => {
  // Catches: a stopped engine proxy stays subscribed and probes from a core that is shutting down.
  const rig = engine([true]);
  await settle();
  rig.proxy.stop();
  const sent = rig.probes();
  rig.tick(5_000);
  diagnostics.channel('http.client.request.error').publish({ request: {}, error: REFUSED });
  await settle();
  assert.equal(rig.probes(), sent);
});
