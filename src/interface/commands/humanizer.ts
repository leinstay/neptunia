// `/humanizer`: the switch of the humanizer (docs/humanizer.md), written to the persona's settings file, and its
// status: on or off and the route each of its two roles runs on. The routes are set with `/model set`. Called by
// src/interface/commands/console.ts.

import { readConfig } from '../../config.ts';
import { localConfigPath } from '../../config/files.ts';
import { HUMANIZER_ROLES } from '../../llm/roles.ts';
import { routesOf } from '../../llm/route-chain.ts';
import { isRouteRole, routeText } from '../../llm/route-text.ts';
import { readLocalConfig, setPath, writeLocalConfig } from '../../tools/operations/shared.ts';
import { objOf } from '../../tools/types.ts';

function write(dataDir: string, value: boolean): void {
  const file = localConfigPath(dataDir);
  writeLocalConfig(file, setPath(readLocalConfig(file), ['humanizer', 'enabled'], value));
}

/** The status line of one role: its first route, or the command that gives it one. */
function roleLine(config: unknown, role: string): string {
  const route = isRouteRole(role) ? routesOf(config, role)[0] : undefined;
  return route === undefined ? `${role}: no route; /model set ${role} <route>` : `${role}: ${routeText(route)}`;
}

/** Runs one `/humanizer` command. `rootDir` holds the engine's defaults the status falls back on. */
export function humanizerCommand(dataDir: string, name: string, rootDir: string): { text: string; status: string } {
  switch (name) {
    case 'humanizer.enable':
      write(dataDir, true);
      return { text: 'the humanizer is on; /humanizer status shows its routes', status: 'ok' };
    case 'humanizer.disable':
      write(dataDir, false);
      return { text: 'the humanizer is off', status: 'ok' };
    default: {
      const config = readConfig(rootDir, { privateDir: dataDir });
      const isOn = objOf(objOf(config).humanizer).enabled === true;
      const lines = [
        `the humanizer is ${isOn ? 'on' : 'off'}`,
        ...HUMANIZER_ROLES.map((role) => roleLine(config, role)),
      ];
      return { text: lines.join('\n'), status: 'ok' };
    }
  }
}
