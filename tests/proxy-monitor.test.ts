// src/net/proxy.ts: the engine proxy's health (stage Z). `createProxyMonitor` holds the route of every outbound
// connection: `off` while the owner has it off or no URL is stored, `proxy` while it answers, `direct` after
// `proxy.health.failures` failed checks in a row, and `proxy` again after `proxy.health.recoveries` good ones. It
// probes at most once per `proxy.health.everySeconds`, hands the URL in force to `apply` (the process-wide setting)
// whenever it changes, and tells `onSwitch` of each switch so the persona learns of it as of any failure.
// `proxyEnvOf` is the environment a child gets for that URL. The probe and the clock are fakes; nothing goes out.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProxyMonitor, isProxyConnectionFailure, proxyEnvOf } from '../src/net/proxy.ts';
import type { ProxySwitch } from '../src/net/proxy.ts';

const PROXY = 'socks5h://login:pass-word@proxy.example:1080';
const HTTP_FORM = 'http://login:pass-word@proxy.example:1080';
const SECOND = 'http://second:secret2@other.example:3128';
const EVERY_S = 30;

type RigSetup = { enabled?: boolean; url?: string | null; failures?: number; recoveries?: number };

function rig({ enabled = true, url = PROXY, failures = 3, recoveries = 2 }: RigSetup = {}) {
  const state: { enabled: boolean; url: string | null; at: number; answers: Array<boolean> } = {
    enabled,
    url,
    at: 1_000_000,
    answers: [],
  };
  const probes: Array<{ url: string; timeoutMs: number }> = [];
  const applied: Array<string | null> = [];
  const switches: Array<ProxySwitch> = [];
  const monitor = createProxyMonitor({
    url: () => state.url,
    config: () => ({
      proxy: {
        enabled: state.enabled,
        health: { everySeconds: EVERY_S, failures, recoveries, timeoutMs: 4000 },
      },
    }),
    probe: (probed, timeoutMs) => {
      probes.push({ url: probed, timeoutMs });
      return Promise.resolve(state.answers.shift() ?? true);
    },
    now: () => state.at,
    apply: (inForce) => applied.push(inForce),
    onSwitch: (change) => switches.push(change),
  });
  /** One check per health interval, each probe answering the next of `answers`. */
  async function checks(answers: Array<boolean>): Promise<void> {
    for (const answer of answers) {
      state.answers.push(answer);
      state.at += EVERY_S * 1000;
      await monitor.check();
    }
  }
  return { monitor, state, probes, applied, switches, checks };
}

test('with the proxy on and answering, every connection goes through the stored URL', async () => {
  // Catches: the monitor starts direct and the engine leaves the proxy unused until the first failure and recovery.
  const { monitor, applied } = rig();
  await monitor.check();
  assert.equal(monitor.route(), 'proxy');
  assert.equal(monitor.current(), PROXY);
  assert.deepEqual(applied, [PROXY]);
});

test('the proxy off, or no URL stored, is the direct path with no probe at all', async () => {
  // Catches: a switched-off proxy is still probed and applied, or a missing URL is applied as an empty proxy.
  for (const setup of [{ enabled: false }, { url: null }]) {
    const { monitor, probes, applied } = rig(setup);
    await monitor.check();
    assert.equal(monitor.route(), 'off', JSON.stringify(setup));
    assert.equal(monitor.current(), null);
    assert.equal(probes.length, 0);
    assert.equal(applied.includes(PROXY), false);
  }
});

test('failures below the threshold keep the proxy; the threshold goes direct and says so once', async () => {
  // Catches: one lost probe drops the proxy, or a long outage repeats the switch notice at every check.
  const { monitor, applied, switches, checks } = rig({ failures: 3 });
  await monitor.check();
  await checks([false, false]);
  assert.equal(monitor.route(), 'proxy');
  assert.deepEqual(switches, []);
  await checks([false]);
  assert.equal(monitor.route(), 'direct');
  assert.equal(monitor.current(), null);
  assert.deepEqual(switches, ['proxy-down']);
  assert.equal(applied.at(-1), null);
  await checks([false, false, false]);
  assert.deepEqual(switches, ['proxy-down']);
});

test('a good check between failures starts the count again', async () => {
  // Catches: failures add up over hours of a healthy proxy, so scattered blips switch it off.
  const { monitor, switches, checks } = rig({ failures: 3 });
  await monitor.check();
  await checks([false, false, true, false, false]);
  assert.equal(monitor.route(), 'proxy');
  assert.deepEqual(switches, []);
});

test('after going direct the proxy is taken back once it answers the recovery count in a row', async () => {
  // Catches: the engine stays direct for good after one outage, or flaps back on the first lucky probe.
  const { monitor, applied, switches, checks } = rig({ failures: 1, recoveries: 2 });
  await monitor.check();
  await checks([false]);
  assert.equal(monitor.route(), 'direct');
  await checks([true, false, true]);
  assert.equal(monitor.route(), 'direct');
  await checks([true]);
  assert.equal(monitor.route(), 'proxy');
  assert.equal(monitor.current(), PROXY);
  assert.deepEqual(switches, ['proxy-down', 'proxy-back']);
  assert.equal(applied.at(-1), PROXY);
});

test('the direct path keeps probing the proxy with the timeout from the settings', async () => {
  // Catches: the recovery probe goes out through the global setting, which is direct by then, or with no timeout.
  const { monitor, probes, checks } = rig({ failures: 1 });
  await monitor.check();
  await checks([false, false]);
  assert.equal(monitor.route(), 'direct');
  assert.ok(probes.length >= 2);
  for (const probe of probes) {
    assert.equal(probe.url, PROXY);
    assert.equal(probe.timeoutMs, 4000);
  }
});

test('a check before the interval has passed sends no probe', async () => {
  // Catches: the core's tick probes the proxy every few seconds instead of every `everySeconds`.
  const { monitor, state, probes } = rig();
  await monitor.check();
  const sent = probes.length;
  state.at += EVERY_S * 1000 - 1;
  await monitor.check();
  assert.equal(probes.length, sent);
  state.at += 1;
  await monitor.check();
  assert.equal(probes.length, sent + 1);
});

test('turning the proxy off goes direct at the next check without waiting for the interval, and with no notice', async () => {
  // Catches: `proxy off` waits a whole interval, or is announced to her as a failure.
  const { monitor, state, applied, switches } = rig();
  await monitor.check();
  state.enabled = false;
  assert.equal(monitor.current(), null);
  await monitor.check();
  assert.equal(monitor.route(), 'off');
  assert.equal(applied.at(-1), null);
  assert.deepEqual(switches, []);
});

test('a new URL while direct starts over on the proxy with a clean count', async () => {
  // Catches: the owner fixes the proxy with `proxy set` and the engine stays direct on the old URL's failures.
  const { monitor, state, applied, checks } = rig({ failures: 1 });
  await monitor.check();
  await checks([false]);
  assert.equal(monitor.route(), 'direct');
  state.url = SECOND;
  await monitor.check();
  assert.equal(monitor.route(), 'proxy');
  assert.equal(monitor.current(), SECOND);
  assert.equal(applied.at(-1), SECOND);
});

test('a probe that throws counts as a failure and never rejects the check', async () => {
  // Catches: a DNS error in the probe crashes the core's tick instead of moving the engine to the direct path.
  let at = 0;
  const monitor = createProxyMonitor({
    url: () => PROXY,
    config: () => ({
      proxy: { enabled: true, health: { everySeconds: 1, failures: 1, recoveries: 1, timeoutMs: 10 } },
    }),
    probe: () => Promise.reject(new Error('getaddrinfo ENOTFOUND proxy.example')),
    now: () => (at += 1000),
  });
  await monitor.check();
  await monitor.check();
  assert.equal(monitor.route(), 'direct');
});

/** A monitor whose probes wait until the test answers them, one at a time. */
function heldRig() {
  const held: Array<(answer: boolean) => void> = [];
  const applied: Array<string | null> = [];
  const switches: Array<ProxySwitch> = [];
  const state = { url: PROXY as string | null, at: 1_000_000 };
  const monitor = createProxyMonitor({
    url: () => state.url,
    config: () => ({
      proxy: { enabled: true, health: { everySeconds: EVERY_S, failures: 3, recoveries: 2, timeoutMs: 4000 } },
    }),
    probe: () => new Promise<boolean>((resolve) => held.push(resolve)),
    now: () => state.at,
    apply: (inForce) => applied.push(inForce),
    onSwitch: (change) => switches.push(change),
  });
  return { monitor, held, applied, switches, state };
}

test('at the start nothing goes through the proxy until its first probe answers', async () => {
  // Catches: the start puts a refusing proxy in force at once, so every fetch of the first minutes fails.
  const { monitor, held, applied } = heldRig();
  const first = monitor.check();
  assert.equal(held.length, 1);
  assert.equal(monitor.route(), 'direct');
  assert.equal(monitor.current(), null);
  assert.equal(applied.includes(PROXY), false);
  held[0]?.(true);
  await first;
  assert.equal(monitor.route(), 'proxy');
  assert.equal(monitor.current(), PROXY);
});

test('a failed first probe keeps the direct path, and the failure count still tells her once', async () => {
  // Catches: a proxy that never answered is put in force anyway, or its outage at the start goes unsaid.
  const { monitor, applied, switches, checks } = rig({ failures: 2 });
  await checks([false]);
  assert.equal(monitor.route(), 'direct');
  assert.deepEqual(switches, []);
  await checks([false, false]);
  assert.equal(monitor.route(), 'direct');
  assert.deepEqual(switches, ['proxy-down']);
  assert.equal(applied.includes(PROXY), false);
});

test('a first probe that answers puts the proxy in force with no notice', async () => {
  // Catches: the first good probe is announced to her as a recovery after every start.
  const { switches, checks } = rig();
  await checks([true]);
  assert.deepEqual(switches, []);
});

test('a new URL goes direct until its own probe answers', async () => {
  // Catches: a new URL the owner just stored is used before anyone knows it works.
  const { monitor, held, applied, state } = heldRig();
  const first = monitor.check();
  held[0]?.(true);
  await first;
  state.url = SECOND;
  const second = monitor.check();
  assert.equal(monitor.current(), null);
  assert.equal(applied.at(-1), null);
  held[1]?.(true);
  await second;
  assert.equal(monitor.current(), SECOND);
});

test('a connection failure on the proxy probes at once and goes direct when the probe fails', async () => {
  // Catches: a proxy that starts refusing keeps failing every request until the next health interval and the
  // failure count run out.
  const { monitor, state, applied, switches, checks } = rig({ failures: 3 });
  await checks([true]);
  state.at += 5_000;
  state.answers.push(false);
  await monitor.suspect();
  assert.equal(monitor.route(), 'direct');
  assert.equal(applied.at(-1), null);
  assert.deepEqual(switches, ['proxy-down']);
});

test('a connection failure the proxy answers keeps the proxy in force', async () => {
  // Catches: a target host that refuses one request drops a healthy proxy.
  const { monitor, state, switches, checks } = rig();
  await checks([true]);
  state.at += 5_000;
  state.answers.push(true);
  await monitor.suspect();
  assert.equal(monitor.route(), 'proxy');
  assert.deepEqual(switches, []);
});

test('a burst of connection failures sends one probe, and none within the probe timeout of the last', async () => {
  // Catches: a hundred failing requests send a hundred probes to the proxy at once.
  const { monitor, state, probes, checks } = rig();
  await checks([true]);
  const sent = probes.length;
  state.at += 1_000;
  await monitor.suspect();
  assert.equal(probes.length, sent, 'within the timeout of the last probe');
  state.at += 4_000;
  await Promise.all([monitor.suspect(), monitor.suspect(), monitor.suspect()]);
  assert.equal(probes.length, sent + 1);
});

test('a connection failure while direct or off sends no probe', async () => {
  // Catches: requests on the direct path that fail for their own reasons probe the proxy on every failure.
  const direct = rig({ failures: 1 });
  await direct.checks([false]);
  const sent = direct.probes.length;
  direct.state.at += 10_000;
  await direct.monitor.suspect();
  assert.equal(direct.probes.length, sent);
  const off = rig({ enabled: false });
  await off.monitor.check();
  await off.monitor.suspect();
  assert.equal(off.probes.length, 0);
});

test('refused, reset and failed tunnel connections count as proxy failures, other errors do not', () => {
  // Catches: the core's request errors never reach the monitor, or a 404 or a parse error drops the proxy.
  for (const code of ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ERR_PROXY_TUNNEL', 'UND_ERR_SOCKET'])
    assert.equal(isProxyConnectionFailure(Object.assign(new Error('x'), { code })), true, code);
  assert.equal(
    isProxyConnectionFailure(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } })),
    true
  );
  for (const error of [
    new Error('x'),
    Object.assign(new Error('x'), { code: 'ERR_INVALID_URL' }),
    null,
    'ECONNREFUSED',
  ])
    assert.equal(isProxyConnectionFailure(error), false, String(error));
});

test('a child gets the proxy in the http form under both spellings curl and the CLIs read, and loopback stays direct', () => {
  // Catches: curl ignores the upper-case HTTP_PROXY, a socks5h URL reaches a CLI that cannot speak it, or the
  // child's calls to a local service go to the proxy.
  const env = proxyEnvOf(PROXY);
  for (const name of ['HTTPS_PROXY', 'HTTP_PROXY', 'https_proxy', 'http_proxy'])
    assert.equal(env[name], HTTP_FORM, name);
  for (const name of ['NO_PROXY', 'no_proxy']) {
    assert.match(env[name] ?? '', /(^|,)localhost(,|$)/, name);
    assert.match(env[name] ?? '', /(^|,)127\.0\.0\.1(,|$)/, name);
  }
});

test('no proxy in force, or one with no http form, gives the child no proxy variable', () => {
  // Catches: a direct-path child gets an empty HTTPS_PROXY, which some CLIs read as a proxy at an empty address.
  assert.deepEqual(proxyEnvOf(null), {});
  assert.deepEqual(proxyEnvOf('ftp://login:pw@proxy.example:21'), {});
});
