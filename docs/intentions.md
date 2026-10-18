# Intentions

The persona's intentions: things she means to do later, kept across restarts in `data/guilds/<id>/intentions.json`.
Behind `features.intentions` (off by default). This is step 1: the data, her skills, the candidates and the
`<intentions>` block. Nothing wakes her for an intention yet; she sees them on her next ordinary turn.

## Where they come from

- **Her own call.** `intent.set` with the purpose as the body creates an intention of hers, `pending`. Options:
  `due`, `expires`, `channel` (where it is meant to land), `chain`, `condition` (when it counts as done), and `task`
  plus `deadline` to wait for an errand.
- **The analyzer.** With the switch on, a guild batch of the memory analyzer also returns candidates from her own
  lines (a promise, a thing to come back to, a question for someone later), in the same request. Code keeps one only
  when its quoted words are in one of her lines of the batch and in nobody else's, so a request someone made of her and
  she repeated is never hers. A candidate is `proposed`: it does nothing until she accepts it (`intent.update` with
  `state:pending`) or rejects it (`intent.cancel`); untouched, it expires after `intentions.candidateExpiresHours`.
- **The owner.** `/nep task intent` runs the same operations ([owner commands](owner-commands.md)).

## States

`proposed` -> `pending` | `cancelled` | `expired`; `pending` -> `waiting` | `done` | `cancelled` | `expired`;
`waiting` -> `pending` | `done` | `cancelled` | `expired`. `done`, `cancelled` and `expired` are final. Every intention
has an expiry (`intentions.expiresDays` by default; an accepted candidate from its acceptance). At most
`intentions.maxOpen` of hers are open at once, and `intentions.maxCandidates` candidates.

## Waiting for an errand

`waiting` always names a real errand and a deadline. A wait is linked only to an errand the task store holds: named
by its id, or handed off with `task.run` in the same turn (either call first). A launch that fails links nothing, so
nothing waits on it. When the errand ends, the intention is `pending` again with the outcome noted, before her result
turn runs; the same end delivered twice changes nothing. At start (and later on the scheduler's tick) a
reconciliation moves every wait whose errand already ended, is gone, or passed its deadline back to `pending` with a
note, and expires what is past its expiry.

## What she sees

`<intentions>` in the tail of every turn but a diary post: her open intentions (pending, then waiting, with due
times, the awaited errand, an outcome or how a wait ended), then the candidates with the words of her line they came
from, cut to `context.caps.intentions` tokens. See the [prompt contract](prompt-contract.md) and
[configuration](configuration.md#intentions).

## Turning it on

Set `features.intentions` to `true`, and grant her the skills by name (`/nep access grant` with her as the user:
`intent.set`, `intent.update`, `intent.cancel`, `intent.list`). Her own calls run on her grant alone, under the rules
on who asked: a turn nobody asked for (a spontaneous one) cannot write them yet.
