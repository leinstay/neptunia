// The owner's pairing commands (plan 2026-11-08-meta-person, slice 8): `/interfaces pair open <name>` opens pairing on
// an interface, `/interfaces pair <phrase>` approves a phrase she answered there, and `/interfaces setup <name>` ends, once
// every required value is stored and the chat can ask, by opening pairing and asking for the phrase
// (`labels.pairing.ask`, `{iface}` the interface). An empty answer leaves pairing open for `/interfaces pair <phrase>`.
// The pairing itself is src/interface/owner-pairing.ts. Called by src/interface/commands/console.ts.

import type { Dialog } from '../../keys/commands.ts';
import { moduleValues, readModuleSettings } from '../../setup/modules.ts';
import type { ModuleRef } from '../../setup/modules.ts';
import type { OwnerPairing, PairAnswer } from '../owner-pairing.ts';
import { fillLabel } from '../owner-pairing.ts';

/** What the commands reach: the core's pairing, absent where the console runs without one. */
export type PairCommands = Pick<OwnerPairing, 'open' | 'approve'>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** `labels.pairing.ask` of the live prompts, '' when missing. */
function askLabel(hot: unknown): string {
  const prompts = isRecord(hot) ? hot.prompts : null;
  const labels = isRecord(prompts) ? prompts.labels : null;
  const pairing = isRecord(labels) ? labels.pairing : null;
  return isRecord(pairing) && typeof pairing.ask === 'string' ? pairing.ask : '';
}

const word = (args: Readonly<Record<string, unknown>>, key: string): string =>
  typeof args[key] === 'string' ? args[key] : '';

/** Whether every required value of a module's setup contract is stored. */
export function isSetupComplete(ref: ModuleRef): boolean {
  const settings = readModuleSettings(ref);
  return settings !== null && moduleValues(ref, settings).every((row) => !row.required || row.value != null);
}

/** `/interfaces pair <phrase>` and `/interfaces pair open <name>`; null for any other command. */
export function pairCommand(
  pairing: PairCommands | null | undefined,
  name: string,
  args: Readonly<Record<string, unknown>>
): Promise<PairAnswer> | null {
  if (name !== 'interfaces.pair' && name !== 'interfaces.pair.open') return null;
  if (pairing == null) return Promise.resolve({ text: 'pairing runs in the core; start it first', status: 'failed' });
  if (name === 'interfaces.pair.open') return Promise.resolve({ text: pairing.open(word(args, 'name')), status: 'ok' });
  return pairing.approve(word(args, 'phrase'));
}

/**
 * The end of a finished `/interfaces setup <name>`: pairing opens on the interface and the chat asks for the phrase.
 * `setupText` is the setup's own answer; a setup that left a value unset (`complete` false) or has no chat to ask in
 * ends with it alone.
 */
export async function pairAfterSetup({
  pairing,
  hot,
  iface,
  complete,
  setupText,
  dialog,
}: {
  pairing: PairCommands | null | undefined;
  hot: unknown;
  iface: string;
  complete: boolean;
  setupText: string;
  dialog: Dialog | null;
}): Promise<PairAnswer> {
  if (!complete || pairing == null || dialog === null) return { text: setupText, status: 'ok' };
  const opened = pairing.open(iface);
  const template = askLabel(hot);
  if (template === '') return { text: `${setupText}\n${opened}`, status: 'ok' };
  const phrase = (await dialog.ask(fillLabel(template, { iface }))).trim();
  if (phrase === '') return { text: `${setupText}\n${opened}`, status: 'ok' };
  const approved = await pairing.approve(phrase);
  return { text: `${setupText}\n${approved.text}`, status: approved.status };
}
