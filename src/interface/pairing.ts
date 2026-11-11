// One-time phrases with the limits of Hermes's gateway/pairing.py. A phrase is six words of the word list
// (src/interface/phrase-codes.ts), kept only as its seal. `createPairing` gives a phrase only while pairing is open on
// that interface (`open`, one hour); a phrase lives an hour, at most three wait per interface, an account asks once per
// ten minutes, and five wrong approvals lock the approvals for an hour. An approval closes pairing on its interface and
// voids its other phrases. Every change is written to the state file when one is given, so a restart neither drops a
// waiting phrase nor reopens a used one or a lock. No module of the engine calls `createPairing`. `createCodeFile` is
// the state file and the limits are the constants below, both used by her link tool (src/interface/person-link.ts),
// whose file is `link-codes.json`. Pure over the injected clock and phrases apart from the file.

import fs from 'node:fs';
import path from 'node:path';

import { log } from '../log.ts';
import type { PhraseCodes, Seal } from './phrase-codes.ts';

// Hermes's limits (gateway/pairing.py): a code lives an hour, three wait per platform, an account asks once per ten
// minutes, five failures lock for an hour. The pairing window is an hour.
const HOUR_MS = 60 * 60_000;
export const CODE_TTL_MS = HOUR_MS;
export const MAX_PENDING = 3;
export const REQUEST_EVERY_MS = 10 * 60_000;
export const MAX_FAILURES = 5;
export const LOCK_MS = HOUR_MS;
const OPEN_MS = HOUR_MS;

/** The state file `name` in the data directory, which is the private layer `hot.privateDir`; none without one. */
export function codesFileOf(hot: { readonly privateDir?: string }, name: string): string | null {
  return hot.privateDir === undefined ? null : path.join(hot.privateDir, name);
}

/** A state kept in a JSON file: read once at creation, written whole after each change. */
export type CodeFile<TState> = { load(): TState; save(state: TState): void };

/** The JSON file at `file`, private to its user; none kept when `file` is null. A file that will not parse reads as `empty`. */
export function createCodeFile<TState>(file: string | null, empty: () => TState): CodeFile<TState> {
  return {
    load() {
      if (file === null || !fs.existsSync(file)) return empty();
      try {
        return { ...empty(), ...(JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<TState>) };
      } catch {
        log.warn('codes: state file unreadable, starting empty', { file: path.basename(file) });
        return empty();
      }
    },
    save(state) {
      if (file === null) return;
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const temporary = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(temporary, JSON.stringify(state), { mode: 0o600 });
      fs.renameSync(temporary, file);
    },
  };
}

/** An account on an interface, by its platform id. */
export type PairingAccount = { iface: string; native: string };
/** What an account's message gets: a phrase, or none because pairing is closed, it asked lately, three wait or no list. */
export type CodeRequest = { kind: 'code'; phrase: string } | { kind: 'closed' | 'pending' | 'full' | 'no-words' };
/** What the owner's approval of a phrase comes to. */
export type CodeApproval = { kind: 'approved'; account: PairingAccount } | { kind: 'wrong' | 'locked' };

export type Pairing = {
  /** Opens pairing on `iface` for an hour. */
  open(iface: string): void;
  isOpen(iface: string): boolean;
  request(account: PairingAccount): CodeRequest;
  /** Approves the waiting phrase whose six words `text` holds. */
  approve(text: string): CodeApproval;
};

type Waiting = { seal: Seal; account: PairingAccount; at: number };
type PairingState = {
  openUntil: Record<string, number>;
  waiting: Array<Waiting>;
  askedAt: Record<string, number>;
  failures: number;
  lockedUntil: number;
};

const emptyState = (): PairingState => ({ openUntil: {}, waiting: [], askedAt: {}, failures: 0, lockedUntil: 0 });

export function createPairing({
  now,
  phrases,
  file = null,
}: {
  now: () => number;
  phrases: PhraseCodes;
  /** Where the state survives a restart; kept in the process alone when null. */
  file?: string | null;
}): Pairing {
  const store = createCodeFile(file, emptyState);
  const state = store.load();
  const keyOf = (account: PairingAccount): string => JSON.stringify([account.iface, account.native]);
  const save = (): void => store.save(state);

  function prune(): void {
    const at = now();
    state.waiting = state.waiting.filter((one) => at - one.at <= CODE_TTL_MS);
  }

  function isOpen(iface: string): boolean {
    return (state.openUntil[iface] ?? 0) >= now();
  }

  return {
    open(iface) {
      state.openUntil[iface] = now() + OPEN_MS;
      save();
    },
    isOpen,
    request(account) {
      if (!isOpen(account.iface)) return { kind: 'closed' };
      prune();
      const key = keyOf(account);
      const last = state.askedAt[key];
      if (last !== undefined && now() - last <= REQUEST_EVERY_MS) return { kind: 'pending' };
      if (state.waiting.filter((one) => one.account.iface === account.iface).length >= MAX_PENDING)
        return { kind: 'full' };
      const issued = phrases.issue();
      if (issued === null) return { kind: 'no-words' };
      state.waiting = [
        ...state.waiting.filter((one) => keyOf(one.account) !== key),
        { seal: issued.seal, account, at: now() },
      ];
      state.askedAt[key] = now();
      save();
      return { kind: 'code', phrase: issued.phrase };
    },
    approve(text) {
      if (state.lockedUntil > now()) return { kind: 'locked' };
      prune();
      const found = state.waiting.find((one) => phrases.holds(one.seal, text));
      if (found === undefined) {
        state.failures += 1;
        if (state.failures >= MAX_FAILURES) {
          state.lockedUntil = now() + LOCK_MS;
          state.failures = 0;
        }
        save();
        return { kind: 'wrong' };
      }
      state.failures = 0;
      state.waiting = state.waiting.filter((one) => one.account.iface !== found.account.iface);
      delete state.openUntil[found.account.iface];
      save();
      return { kind: 'approved', account: found.account };
    },
  };
}
