// The engine proxy's store (stage Z): one service `proxy` in keys.json, a plain proxy URL with its login and password,
// which `serviceCredential` reads for every consumer. `migrateProxyService` moves the stored video proxy under it, and
// the config cut drops the two video settings the engine proxy replaces. Temp dirs only, no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { cutConfigKeys } from '../src/config/cut.ts';
import { readKeys, serviceCredential } from '../src/keys/file.ts';
import { SERVICES, migrateProxyService, serviceCommand } from '../src/keys/services.ts';
import { scriptedDialog } from './fixtures/keys-rig.ts';
import { tempDir } from './fixtures/tmp.ts';

const PROXY = 'socks5h://login:pass-word@proxy.example:1080';
const OTHER = 'http://second:secret2@other.example:3128';

function storeWith(services: Record<string, string>): string {
  const dir = tempDir('nep-proxy-store-');
  fs.writeFileSync(
    path.join(dir, 'keys.json'),
    JSON.stringify({ core: [{ name: 'main', value: 'sk-core' }], services }),
    { mode: 0o600 }
  );
  return dir;
}

const rawServices = (dir: string): Record<string, unknown> =>
  (JSON.parse(fs.readFileSync(path.join(dir, 'keys.json'), 'utf8')) as { services: Record<string, unknown> }).services;

test('the service list names proxy and no longer names videoProxy', () => {
  // Catches: the old name stays settable, so a value lands where no consumer reads it.
  assert.equal(Object.hasOwn(SERVICES, 'proxy'), true);
  assert.equal(Object.hasOwn(SERVICES, 'videoProxy'), false);
});

test('a proxy set through the service dialog is what serviceCredential reads under proxy', async () => {
  // Catches: the setter and the reader disagree on the name, so the engine never sees the proxy the owner entered.
  const dir = tempDir('nep-proxy-store-');
  const set = await serviceCommand(dir, 'keys.service.set', { name: 'proxy' }, scriptedDialog([PROXY]).dialog);
  assert.equal(set.status, 'ok');
  assert.equal(serviceCredential(dir, 'proxy'), PROXY);
  assert.equal(set.text.includes('pass-word'), false);
});

test('the migration moves a stored videoProxy under proxy and keeps every other section', () => {
  // Catches: the deploy loses the owner's proxy, or the rewrite drops the model keys beside it.
  const dir = storeWith({ videoProxy: PROXY, youtube: 'yt-key' });
  assert.equal(migrateProxyService(dir), 'moved');
  assert.equal(serviceCredential(dir, 'proxy'), PROXY);
  assert.equal(Object.hasOwn(rawServices(dir), 'videoProxy'), false);
  assert.equal(serviceCredential(dir, 'youtube'), 'yt-key');
  assert.equal(readKeys(dir).core[0]?.value, 'sk-core');
  assert.equal(fs.statSync(path.join(dir, 'keys.json')).mode & 0o777, 0o600);
});

test('the migration keeps a proxy already set and drops the old videoProxy', () => {
  // Catches: a second run, or a store where the owner already set the new service, overwrites it with the old value.
  const dir = storeWith({ proxy: OTHER, videoProxy: PROXY });
  assert.equal(migrateProxyService(dir), 'dropped');
  assert.equal(serviceCredential(dir, 'proxy'), OTHER);
  assert.equal(Object.hasOwn(rawServices(dir), 'videoProxy'), false);
});

test('the migration of a store with no videoProxy changes nothing, a missing store included', () => {
  // Catches: the migration rewrites a store it has nothing to do with, or creates a keys.json on a fresh install.
  const dir = storeWith({ youtube: 'yt-key' });
  const before = fs.readFileSync(path.join(dir, 'keys.json'), 'utf8');
  assert.equal(migrateProxyService(dir), 'none');
  assert.equal(fs.readFileSync(path.join(dir, 'keys.json'), 'utf8'), before);
  const empty = tempDir('nep-proxy-store-');
  assert.equal(migrateProxyService(empty), 'none');
  assert.equal(fs.existsSync(path.join(empty, 'keys.json')), false);
});

test('the config cut drops media.video.proxy and media.video.proxySites and keeps the other video settings', () => {
  // Catches: a private layer still sets the retired keys, and something reads them as a second proxy or a site filter.
  const layer = {
    media: {
      video: {
        proxy: '${env:MEDIA_VIDEO_PROXY}',
        proxySites: ['youtube.com', 'youtu.be'],
        ytdlpPath: '/usr/local/bin/yt-dlp',
      },
    },
  };
  const { config, cut } = cutConfigKeys(layer);
  const video = (config.media as { video: Record<string, unknown> }).video;
  assert.equal(Object.hasOwn(video, 'proxy'), false);
  assert.equal(Object.hasOwn(video, 'proxySites'), false);
  assert.equal(video.ytdlpPath, '/usr/local/bin/yt-dlp');
  assert.deepEqual([...cut].filter((key) => key.startsWith('media.video.proxy')).sort(), [
    'media.video.proxy',
    'media.video.proxySites',
  ]);
});
