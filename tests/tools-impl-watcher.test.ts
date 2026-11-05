// Her tool `watcher.read { day? }` (src/tools/impl/watcher.ts): the latest report, or the report of a day, as text.
// It is a read of a file the watcher wrote and is granted by the owner like `skill.read`: the tracked config does not
// grant it, and an ungranted call is refused by the same access check as any tool. The operations' environment gets
// the reader from the core (`createOpsEnv({ watcher })`); a core with none answers failed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runOpPrechecked } from '../src/tools/impl/index.ts';
import { createOpsEnv } from '../src/tools/impl/env.ts';
import { SKILL_DEFINITIONS } from '../src/tools/definitions.ts';
import { grantedToPersona, skillAccess } from '../src/tools/access.ts';
import { createDiscordInterface } from '../interfaces/discord/index.ts';
import { createReportReader } from '../src/watcher/read.ts';
import type { ReportReader } from '../src/watcher/read.ts';
import { withCapturedLogs } from './fixtures/capture-logs.ts';
import { putReport, reportText, watcherDirs } from './fixtures/watcher-rig.ts';
import { tempDir } from './fixtures/tmp.ts';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const SELF_ID = '900';

type Result = { status: string; code?: string | null; summary?: string; data?: unknown };

function envOf(watcher: ReportReader | null) {
  const hot = {
    config: { bot: { owners: ['42'], access: {} }, features: {} },
    prompts: { labels: {} },
    rootDir: tempDir('nep-tools-watcher-root-'),
    reloadConfig: () => true,
  };
  return createOpsEnv({
    discord: createDiscordInterface().capabilities,
    hot,
    store: { state: { data: {}, markDirty() {} } },
    client: { channels: { cache: new Map() } },
    spontaneous: {},
    calibrator: { ratio: 1 },
    isServedCommunity: (id: unknown) => id === 'g1',
    board: null,
    watcher,
  });
}

async function callOf(watcher: ReportReader | null, args: Record<string, unknown>): Promise<Result> {
  const env = envOf(watcher);
  const { result } = await withCapturedLogs(() =>
    runOpPrechecked('watcher.read', args, {
      env,
      placeId: 'g1',
      conversationId: 'c1',
      userId: null,
      roleIds: [],
      actor: 'persona',
    })
  );
  return result;
}

test('watcher.read with no day answers the latest report as text, with its day', async () => {
  const dirs = watcherDirs();
  putReport(dirs, '2026-11-01', reportText({ Memory: 'MARK-OLD' }));
  putReport(dirs, '2026-11-02', reportText({ Memory: 'MARK-NEW' }));
  const result = await callOf(createReportReader(dirs.reportsDir), {});
  assert.equal(result.status, 'ok');
  assert.ok(String(result.summary).includes('MARK-NEW'));
  assert.equal(String(result.summary).includes('MARK-OLD'), false);
  assert.deepEqual(result.data, { day: '2026-11-02', text: reportText({ Memory: 'MARK-NEW' }) });
});

test("watcher.read with a day answers that day's report", async () => {
  const dirs = watcherDirs();
  putReport(dirs, '2026-11-01', reportText({ Memory: 'MARK-OLD' }));
  putReport(dirs, '2026-11-02', reportText({ Memory: 'MARK-NEW' }));
  const result = await callOf(createReportReader(dirs.reportsDir), { day: '2026-11-01' });
  assert.equal(result.status, 'ok');
  assert.ok(String(result.summary).includes('MARK-OLD'));
});

test('watcher.read with no report, and with a day that has none, fails as not-found', async () => {
  const dirs = watcherDirs();
  const reader = createReportReader(dirs.reportsDir);
  const none = await callOf(reader, {});
  assert.equal(none.status, 'failed');
  assert.equal(none.code, 'not-found');
  putReport(dirs, '2026-11-02', reportText());
  const other = await callOf(reader, { day: '2026-10-01' });
  assert.equal(other.status, 'failed');
  assert.equal(other.code, 'not-found');
});

test('watcher.read of a day that is no date is invalid and reads nothing, so she cannot open another file through it', async () => {
  const dirs = watcherDirs();
  fs.writeFileSync(path.join(dirs.watcherDir, 'prompt.md'), 'PROMPT-SECRET-SENTINEL');
  const result = await callOf(createReportReader(dirs.reportsDir), { day: '../prompt' });
  assert.equal(result.status, 'invalid');
  assert.equal(JSON.stringify(result).includes('PROMPT-SECRET-SENTINEL'), false);
});

test('a core with no watcher reader answers failed rather than crashing', async () => {
  const result = await callOf(null, {});
  assert.equal(result.status, 'failed');
});

test('watcher.read is defined with an optional day and a read effect, and the tracked config grants it to nobody', () => {
  const definition = SKILL_DEFINITIONS.find((one) => one.name === 'watcher.read');
  assert.ok(definition, 'watcher.read is defined');
  assert.equal(definition.effects, 'read');
  assert.ok(Object.hasOwn(definition.params.properties ?? {}, 'day'));
  assert.equal((definition.params.required ?? []).includes('day'), false);
  const tracked: unknown = JSON.parse(fs.readFileSync(path.join(REPO, 'config', 'config.json'), 'utf8'));
  assert.equal(grantedToPersona(tracked, SELF_ID, 'watcher.read'), false);
});

test('an ungranted watcher.read is refused like any ungranted tool, and a grant to her opens it', () => {
  const closed = { bot: { access: {} } };
  const open = { bot: { access: { 'watcher.read': { users: [SELF_ID] } } } };
  const refused = skillAccess({ skill: { name: 'watcher.read' }, config: closed, selfId: SELF_ID });
  assert.equal(refused.allowed, false);
  assert.equal(skillAccess({ skill: { name: 'watcher.read' }, config: open, selfId: SELF_ID }).allowed, true);
});
