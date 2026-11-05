// The config half of the offline conversion: the input folder copied, the retired fallback key gone and the served
// server added to `interfaces/discord/config.json` (the file the interface reads), whose other keys stay. Nothing here reads the database.

import fs from 'node:fs';
import path from 'node:path';
import { DROPPED_KEYS } from '../../config-moves.ts';

type Settings = Record<string, unknown>;

const isRecord = (value: unknown): value is Settings =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

export type ConfigReport = { removed: Array<string>; moved: Array<{ from: string; to: string }> };

function readJson(file: string): Settings {
  const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
  return isRecord(parsed) ? parsed : {};
}

const writeJson = (file: string, value: unknown): void => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
};

/** Writes the converted config folder; a missing input folder gives an empty output folder. */
export function convertConfig(configIn: string, configOut: string): ConfigReport {
  const report: ConfigReport = { removed: [], moved: [] };
  fs.mkdirSync(configOut, { recursive: true });
  if (fs.existsSync(configIn)) fs.cpSync(configIn, configOut, { recursive: true });
  const file = path.join(configOut, 'config.json');
  if (!fs.existsSync(file)) return report;
  const config = readJson(file);
  // The one retired setting of a conversion: its name lives in the list of retired keys.
  const retired = DROPPED_KEYS.find((one) => one[0] === 'memory') ?? [];
  const memory = config.memory;
  const name = retired[1] ?? '';
  if (isRecord(memory) && Object.hasOwn(memory, name)) {
    delete memory[name];
    report.removed.push(retired.join('.'));
  }
  const bot = config.bot;
  if (isRecord(bot) && Object.hasOwn(bot, 'guildId')) {
    const server = bot.guildId;
    delete bot.guildId;
    if (typeof server === 'string' && server) {
      const target = path.join(configOut, 'interfaces', 'discord', 'config.json');
      const settings = fs.existsSync(target) ? readJson(target) : {};
      const servers = Array.isArray(settings.servers) ? (settings.servers as Array<unknown>) : [];
      settings.servers = servers.includes(server) ? servers : [...servers, server];
      writeJson(target, settings);
      report.moved.push({ from: 'bot.guildId', to: 'interfaces/discord/config.json#servers' });
    } else {
      report.removed.push('bot.guildId');
    }
  }
  const reflection = config.selfreflection;
  if (isRecord(reflection) && Object.hasOwn(reflection, 'channelId')) {
    reflection.placeId = reflection.channelId;
    delete reflection.channelId;
    report.moved.push({ from: 'selfreflection.channelId', to: 'selfreflection.placeId' });
  }
  writeJson(file, config);
  return report;
}
