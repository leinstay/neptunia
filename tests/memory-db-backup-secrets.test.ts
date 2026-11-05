// A backup holds no secret (owner's word, 2026-11-05): keys, logins, client tokens, env files and the backups folder
// stay out, a restore leaves the live secret files where they are, and the backup's folders and files are 700 and 600.
// Synthetic data folders only; every key is made up and built from pieces.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { openMemoryDb } from '../src/memory/db/open.ts';
import { backupDatabase, restoreDatabase } from '../src/memory/db/backup.ts';
import { main } from '../scripts/memory-db.ts';

const OPENROUTER = ['sk', 'or', 'v1', 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90'].join('-');
const ANTHROPIC = [
  'sk',
  'ant',
  'api03',
  'Zx9Qw8Er7Ty6Ui5Op4As3Df2Gh1Jk0LzXcVbNm_-AbCdEfGhIjKlMnOpQrStUvWxYz0123456',
].join('-');
const GOOGLE = `${'AI'}${'za'}SyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q`;

/** Secret files by path. */
const SECRET_FILES: Record<string, string> = {
  'keys.json': '{"openrouter":"live-key-one"}',
  'interfaces/discord/credentials.json': '{"token":"discord-token-one"}',
  'subharness/claude/home/.credentials.json': '{"oauth":"claude-login-one"}',
  'subharness/codex/home/auth.json': '{"login":"codex-login-one"}',
  'clients.json': '{"a":"client-one"}',
  'clients/a.token': 'client-token-one',
  'clients/a.env': 'CLIENT_KEY=client-env-one',
  '.env': 'SECRET=env-one',
  'interfaces/discord/bot.env': 'BOT=env-two',
  'backups/old/keys.json': '{"copy":"old-copy-one"}',
  'backups/old/notes.txt': 'harmless text in the backups folder',
  'notes/pasted-openrouter.txt': `my key is ${OPENROUTER}`,
  'notes/pasted-anthropic.txt': `key: ${ANTHROPIC}`,
  'notes/pasted-google.txt': `AIza in a config: ${GOOGLE}`,
};
/** Ordinary files that must survive. */
const KEPT_FILES: Record<string, string> = {
  'prompts/system.md': 'You are a persona.',
  'prompts/keys.md': 'How to talk about keys.',
  'config/config.json': '{"a":1}',
  'media/selfreflection/d-1-1.png': 'not really a png',
  'notes/diary.txt': 'a plain diary line',
};
const VALUES = [
  'live-key-one',
  'discord-token-one',
  'claude-login-one',
  'codex-login-one',
  'client-one',
  'client-token-one',
  'client-env-one',
  'env-one',
  'env-two',
  'old-copy-one',
  OPENROUTER,
  ANTHROPIC,
  GOOGLE,
];

type Made = {
  files: Array<{ path: string; size?: number; sha256?: string; mode?: number }>;
  leftOut?: Record<string, number>;
};

const put = (root: string, files: Record<string, string>): void => {
  for (const [rel, text] of Object.entries(files)) {
    const file = path.join(root, ...rel.split('/'));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
    fs.chmodSync(file, 0o644);
  }
};

function persona(files: Array<Record<string, string>> = [SECRET_FILES, KEPT_FILES]) {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'backup-secrets-'));
  const data = path.join(root, 'data');
  fs.mkdirSync(data);
  for (const set of files) put(data, set);
  const db = path.join(data, 'memory.db');
  openMemoryDb(db).close();
  const to = path.join(root, 'backup');
  const manifest = backupDatabase({ db, to, data }) as unknown as Made;
  return { root, data, db, to, manifest, done: () => fs.rmSync(root, { recursive: true, force: true }) };
}

const filesIn = (dir: string): Array<string> =>
  fs
    .readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((rel) => fs.statSync(path.join(dir, rel)).isFile())
    .map((rel) => rel.split(path.sep).join('/'))
    .sort();

test('a backup holds no secret file and no copy of one, and keeps every other file', () => {
  const env = persona();
  try {
    const onDisk = filesIn(env.to);
    assert.deepEqual(
      env.manifest.files.map((file) => file.path).sort(),
      onDisk.filter((rel) => rel !== 'manifest.json'),
      'the manifest names exactly the files on disk'
    );
    for (const rel of Object.keys(SECRET_FILES)) assert.ok(!onDisk.includes(rel), `${rel} is in the backup`);
    for (const rel of Object.keys(KEPT_FILES)) assert.ok(onDisk.includes(rel), `${rel} is missing`);
    assert.ok(onDisk.includes('memory.db'));
    assert.ok(!onDisk.some((rel) => rel.startsWith('backups/')));
    for (const rel of onDisk.filter((name) => name !== 'memory.db')) {
      const text = fs.readFileSync(path.join(env.to, rel)).toString('latin1');
      for (const value of VALUES) assert.ok(!text.includes(value), `${rel} holds a secret value`);
    }
  } finally {
    env.done();
  }
});

test('the manifest names what was left out by class and count, and carries no value', () => {
  const env = persona();
  try {
    const expected = { keys: 1, credentials: 3, clients: 3, env: 2, backups: 2, 'key-pattern': 3 };
    assert.deepEqual(env.manifest.leftOut, expected);
    const text = fs.readFileSync(path.join(env.to, 'manifest.json'), 'utf8');
    assert.deepEqual((JSON.parse(text) as Made).leftOut, expected);
    for (const value of VALUES) assert.ok(!text.includes(value), 'the manifest holds a secret value');
  } finally {
    env.done();
  }
});

test('a persona with no secret has an empty leftOut and loses no file', () => {
  const env = persona([KEPT_FILES]);
  try {
    assert.deepEqual(env.manifest.leftOut, {});
    assert.equal(env.manifest.files.length, Object.keys(KEPT_FILES).length + 1);
  } finally {
    env.done();
  }
});

test('restore brings back everything else and never touches the live secret files', () => {
  const env = persona();
  try {
    const target = path.join(env.root, 'target');
    fs.mkdirSync(target);
    const live: Record<string, string> = {
      'keys.json': '{"openrouter":"LIVE-DIFFERENT"}',
      'clients/a.token': 'LIVE-TOKEN',
      'subharness/codex/home/auth.json': 'LIVE-LOGIN',
    };
    put(target, live);
    fs.chmodSync(path.join(target, 'keys.json'), 0o600);
    const before = Object.keys(live).map((rel) => fs.statSync(path.join(target, rel)));
    restoreDatabase({ from: env.to, db: path.join(target, 'memory.db'), data: target });
    for (const rel of Object.keys(KEPT_FILES))
      assert.equal(fs.readFileSync(path.join(target, rel), 'utf8'), KEPT_FILES[rel], rel);
    Object.keys(live).forEach((rel, index) => {
      assert.equal(fs.readFileSync(path.join(target, rel), 'utf8'), live[rel], `${rel} was changed`);
      const now = fs.statSync(path.join(target, rel));
      assert.equal(now.mode, before[index].mode, `${rel} changed mode`);
      assert.equal(now.mtimeMs, before[index].mtimeMs, `${rel} was rewritten`);
    });
    for (const rel of Object.keys(SECRET_FILES))
      if (!(rel in live)) assert.ok(!fs.existsSync(path.join(target, rel)), `${rel} appeared from nowhere`);
  } finally {
    env.done();
  }
});

test('restoring an older backup that lists a secret file skips it and leaves the live one in place', () => {
  const env = persona();
  try {
    // An older backup: its manifest names keys.json and holds its bytes.
    const bytes = Buffer.from('{"old":"old-backup-key"}');
    fs.writeFileSync(path.join(env.to, 'keys.json'), bytes, { mode: 0o600 });
    const manifestFile = path.join(env.to, 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8')) as Made;
    manifest.files.push({
      path: 'keys.json',
      size: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      mode: 0o600,
    });
    fs.writeFileSync(manifestFile, JSON.stringify(manifest), { mode: 0o600 });
    const target = path.join(env.root, 'target');
    fs.mkdirSync(target);
    put(target, { 'keys.json': 'LIVE-KEYS' });
    restoreDatabase({ from: env.to, db: path.join(target, 'memory.db'), data: target });
    assert.equal(fs.readFileSync(path.join(target, 'keys.json'), 'utf8'), 'LIVE-KEYS');
    assert.equal(fs.readFileSync(path.join(target, 'prompts', 'system.md'), 'utf8'), KEPT_FILES['prompts/system.md']);
  } finally {
    env.done();
  }
});

test('restore-test passes on a backup with secrets left out, and leaves the backup as it was', async () => {
  const env = persona();
  try {
    const before = filesIn(env.to);
    const lines: Array<string> = [];
    const code: unknown = await main(['restore-test', '--from', env.to], {
      out: (line: string) => lines.push(line),
      err: (line: string) => lines.push(line),
    });
    const text = lines.join('\n');
    assert.equal(code, 0, text);
    assert.match(text, new RegExp(`restored: schema \\d+, ${env.manifest.files.length} files checked`));
    assert.match(text, /restore-test ok/);
    assert.deepEqual(filesIn(env.to), before);
  } finally {
    env.done();
  }
});

test('the backup folder and every folder in it are 700, every file in it 600', () => {
  const env = persona();
  try {
    const modeOf = (p: string): number => fs.statSync(p).mode & 0o777;
    assert.equal(modeOf(env.to), 0o700);
    const entries = fs.readdirSync(env.to, { recursive: true, encoding: 'utf8' });
    assert.ok(entries.includes('manifest.json'));
    assert.ok(
      entries.some((rel) => fs.statSync(path.join(env.to, rel)).isDirectory()),
      'a nested folder was checked'
    );
    for (const rel of entries) {
      const abs = path.join(env.to, rel);
      assert.equal(modeOf(abs), fs.statSync(abs).isDirectory() ? 0o700 : 0o600, rel);
    }
  } finally {
    env.done();
  }
});
