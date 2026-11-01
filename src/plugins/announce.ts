// What the core tells her when a plugin's tools register: the tools not announced before for that plugin, the wake that
// carries them (a `heartbeat` wake with the reason `ability.added`, no place and no intention), and the file that
// remembers what was announced so a reconnect, which registers the same tools again, raises no second wake. A disable
// forgets the plugin, so the next enable announces its tools again. The core (src/core.ts) calls these when
// `tool.register` is taken (src/plugins/link.ts).

import fs from 'node:fs';
import path from 'node:path';
import type { Wake } from '../behavior/inner/types.ts';

/** The reason of the wake that tells her a tool was added. */
export const ABILITY_ADDED = 'ability.added';

export type AnnounceStore = { read(): Record<string, Array<string>>; write(next: Record<string, Array<string>>): void };

const byName = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The tools of `accepted` not yet announced for `plugin`, sorted and recorded as announced; null when there are none. */
export function newAbilities(options: {
  plugin: string;
  accepted: ReadonlyArray<string>;
  store: AnnounceStore;
}): Array<string> | null {
  const { plugin, accepted, store } = options;
  const announced = store.read();
  const known = new Set(announced[plugin] ?? []);
  const fresh = [...new Set(accepted)].filter((tool) => !known.has(tool)).sort(byName);
  if (fresh.length === 0) return null;
  store.write({ ...announced, [plugin]: [...known, ...fresh].sort(byName) });
  return fresh;
}

/** Forgets what was announced for `plugin` (a disable), so the next enable announces again. */
export function forgetAbilities(options: { plugin: string; store: AnnounceStore }): void {
  const { plugin, store } = options;
  const announced = store.read();
  if (!Object.hasOwn(announced, plugin)) return;
  store.write(Object.fromEntries(Object.entries(announced).filter(([name]) => name !== plugin)));
}

/** The wake due at `at`: its own chain, so two plugins announced in one millisecond are two wakes. */
export function abilityWake(options: { at: number; plugin: string; tools: ReadonlyArray<string> }): Wake {
  const { at, plugin, tools } = options;
  return {
    id: `inner.wake:heartbeat:ability:${plugin}:${at}`,
    kind: 'heartbeat',
    reason: ABILITY_ADDED,
    intentionIds: [],
    chainId: `ability:${plugin}:${at}`,
    dueAt: at,
    channelId: null,
    privateChat: false,
    tools: [...tools],
  };
}

const FILE = 'plugins-announced.json';

/** The store in `<dataDir>/plugins-announced.json`; a missing or unreadable file reads as nothing announced. */
export function fileAnnounceStore(dataDir: string): AnnounceStore {
  const file = path.join(dataDir, FILE);
  return {
    read() {
      try {
        const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
        return Object.fromEntries(
          Object.entries(parsed).map(([name, tools]) => [
            name,
            Array.isArray(tools) ? tools.filter((tool): tool is string => typeof tool === 'string') : [],
          ])
        );
      } catch {
        // Nothing was announced yet, or the file cannot be read: the tools are announced once more.
        return {};
      }
    },
    write(next) {
      fs.mkdirSync(dataDir, { recursive: true });
      const temporary = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(temporary, `${JSON.stringify(next)}\n`);
      fs.renameSync(temporary, file);
    },
  };
}
