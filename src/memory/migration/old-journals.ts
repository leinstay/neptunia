// The journal folders a shipped data directory kept, read once at an open for the request dumps left in them.

import fs from 'node:fs';
import path from 'node:path';

function filesIn(dir: string): Array<string> {
  try {
    return fs.readdirSync(dir).sort();
  } catch {
    return [];
  }
}

export function oldJournalDirs(dataDir: string): Array<string> {
  const guilds = path.join(dataDir, 'guilds');
  return filesIn(guilds).flatMap((guild) => {
    const root = path.join(guilds, guild);
    const own = path.join(root, 'journal');
    const privates = filesIn(path.join(root, 'private')).map((person) => path.join(root, 'private', person, 'journal'));
    return [own, ...privates];
  });
}
