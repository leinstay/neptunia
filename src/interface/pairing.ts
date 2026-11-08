// The one-time codes that prove an account belongs to someone, by the rules of Hermes's gateway/pairing.py: eight
// characters from an alphabet with no look-alikes, alive one hour, kept only as a hash. `createPairing` holds the
// codes of the owner's pairing of a new interface: a code is given only while the owner opened pairing there
// (`open`, one hour), at most three wait per interface, an account asks once per ten minutes, and five wrong approvals
// lock the approvals for an hour. An approval closes pairing on its interface and voids its other codes. The state
// lives in the process: a restart drops every waiting code. Pure over the injected clock and randomness; called by
// src/interface/owner-pairing.ts, and `newCode`, `hashCode` and `CODE_PATTERN` by her link tool.

import { createHash, randomInt } from 'node:crypto';

/** Hermes's alphabet: capital letters and digits without 0, O, 1 and I. */
export const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const CODE_LENGTH = 8;
/** One code in a text, for a line that carries one. */
export const CODE_PATTERN = `[${CODE_ALPHABET}]{${CODE_LENGTH}}`;

// Hermes's limits (gateway/pairing.py): a code lives an hour, three wait per platform, an account asks once per ten
// minutes, five failures lock for an hour. The pairing window is the owner's hour to write from the new account.
const HOUR_MS = 60 * 60_000;
export const CODE_TTL_MS = HOUR_MS;
export const MAX_PENDING = 3;
export const REQUEST_EVERY_MS = 10 * 60_000;
export const MAX_FAILURES = 5;
export const LOCK_MS = HOUR_MS;
const OPEN_MS = HOUR_MS;

/** A number in [0, 1) from the system's secure source, as Hermes draws its codes from `secrets`. */
export const secureRandom = (): number => randomInt(0, 2 ** 32) / 2 ** 32;

/** A fresh code of `CODE_LENGTH` characters of `CODE_ALPHABET`, `rng` giving numbers in [0, 1). */
export function newCode(rng: () => number): string {
  let code = '';
  for (let at = 0; at < CODE_LENGTH; at += 1)
    code += CODE_ALPHABET[Math.floor(rng() * CODE_ALPHABET.length) % CODE_ALPHABET.length];
  return code;
}

/** A code as typed, without the spaces around it and in capitals. */
export const normalizeCode = (text: string): string => text.trim().toUpperCase();

/** The hash a code is kept under, of its normalized form. */
export const hashCode = (code: string): string => createHash('sha256').update(normalizeCode(code)).digest('hex');

/** An account on an interface, by its platform id. */
export type PairingAccount = { iface: string; native: string };
/** What an account's message gets: a code, or none because pairing is closed, it asked lately, or three wait. */
export type CodeRequest = { kind: 'code'; code: string } | { kind: 'closed' | 'pending' | 'full' };
/** What the owner's approval of a code comes to. */
export type CodeApproval = { kind: 'approved'; account: PairingAccount } | { kind: 'wrong' | 'locked' };

export type Pairing = {
  /** Opens pairing on `iface` for an hour. */
  open(iface: string): void;
  isOpen(iface: string): boolean;
  request(account: PairingAccount): CodeRequest;
  approve(code: string): CodeApproval;
};

type Waiting = { hash: string; account: PairingAccount; at: number };

export function createPairing({ now, rng = secureRandom }: { now: () => number; rng?: () => number }): Pairing {
  const openUntil = new Map<string, number>();
  let waiting: Array<Waiting> = [];
  const askedAt = new Map<string, number>();
  let failures = 0;
  let lockedUntil = 0;
  const keyOf = (account: PairingAccount): string => JSON.stringify([account.iface, account.native]);

  function prune(): void {
    const at = now();
    waiting = waiting.filter((one) => at - one.at <= CODE_TTL_MS);
  }

  function isOpen(iface: string): boolean {
    return (openUntil.get(iface) ?? 0) >= now();
  }

  return {
    open(iface) {
      openUntil.set(iface, now() + OPEN_MS);
    },
    isOpen,
    request(account) {
      if (!isOpen(account.iface)) return { kind: 'closed' };
      prune();
      const key = keyOf(account);
      const last = askedAt.get(key);
      if (last !== undefined && now() - last <= REQUEST_EVERY_MS) return { kind: 'pending' };
      if (waiting.filter((one) => one.account.iface === account.iface).length >= MAX_PENDING) return { kind: 'full' };
      const code = newCode(rng);
      waiting = [...waiting.filter((one) => keyOf(one.account) !== key), { hash: hashCode(code), account, at: now() }];
      askedAt.set(key, now());
      return { kind: 'code', code };
    },
    approve(code) {
      if (lockedUntil > now()) return { kind: 'locked' };
      prune();
      const hash = hashCode(code);
      const found = waiting.find((one) => one.hash === hash);
      if (found === undefined) {
        failures += 1;
        if (failures >= MAX_FAILURES) {
          lockedUntil = now() + LOCK_MS;
          failures = 0;
        }
        return { kind: 'wrong' };
      }
      failures = 0;
      waiting = waiting.filter((one) => one.account.iface !== found.account.iface);
      openUntil.delete(found.account.iface);
      return { kind: 'approved', account: found.account };
    },
  };
}
