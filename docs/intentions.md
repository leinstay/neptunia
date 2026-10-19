# Intentions

The persona's intentions: things she means to do later, kept across restarts in `data/guilds/<id>/intentions.json`.
Behind `features.intentions` (off by default). This is step 1: the data, her skills, the candidates and the
`<intentions>` block. She sees them on every turn; with the [inner life](inner-life.md) on, one that comes due (or a wait
past its deadline) wakes her for an inner turn.

## Where they come from

- **Her own call.** `intent.set` with the purpose as the body creates an intention of hers, `pending`. Options:
  `due` (a delay, a date, a clock time or a weekday and time in `bot.timezone`), `every` (day, week, a number of hours
  or days; the intention wakes her once per occurrence and expires after `intentions.recurringExpiresDays` days),
  `expires`, `channel` (where it is meant to land), `chain`, `condition` (when it counts as done), and `task`
  plus `deadline` to wait for an errand.
- **The analyzer.** With the switch on, a guild batch of the memory analyzer also returns candidates from her own
  lines (a promise, a thing to come back to, a question for someone later), in the same request. Code keeps one only
  when its quoted words are in one of her lines of the batch and in nobody else's, so a request someone made of her and
  she repeated is never hers. A candidate is `proposed`: it does nothing until she accepts it (`intent.update` with
  `state:pending`) or rejects it (`intent.cancel`); untouched, it expires after `intentions.candidateExpiresHours`.
  Each one carries its origin: `own`, or `external` when its words came from outside material (below), and the
  turn that wrote its line.
- **The owner.** `/nep task intent` runs the same operations ([owner commands](owner-commands.md)).

## Where a candidate's words came from

The quote check stops someone's request that she repeated, but not a goal planted in something she read: a web page,
a memory-search result, an errand's output. That text reaches her own words -- the memory episode of an inner turn
carries what her reads returned as lines of hers ([Inner life](inner-life.md#what-she-found-goes-to-her-memory)), and
she may quote or paraphrase it in a line of an ordinary turn -- and no other author's line holds it. So every line she
posts is noted with what her turn had in front of it when she wrote it (`src/intentions/sources.js`): whether the turn
read outside material first (a read call that returned text, a page read from a link, a web lookup, an errand's
result), the word shingles of her line it shares with the outside text of the turn (someone's message she answered,
the retrieved memory, those reads; hashed, no text kept), the turn, and an inner turn's chain. The memory buffer keeps
the note with her line, so it holds after a restart.

A candidate is `external` (with its reason) when its line is a line of her inner-turn memory episode
(`inner-finding`), when the turn that wrote its line read outside material (`read`: a paraphrase cannot be traced by
its words), when its quoted words or its purpose share a shingle with the outside text of that turn (`overlap`), or
when no note of its line is known (`unknown`). Otherwise it is `own`.

Who may accept a candidate (`intent.update` with `state:pending`):

- never the turn that wrote its line (`candidate-same-turn`): an accept comes in a later turn;
- an external one only her later ordinary turn, never an inner turn (`candidate-external`): it is never activated on
  her own initiative;
- an inner turn never one born in an inner turn of its own chain (`candidate-same-chain`);
- an owner's `/nep task intent` is not limited by origin.

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

## Private chats

An intention she sets in a private chat belongs to that chat: it is stored with the scope `dm` and the chat's
channel, shown in the `<intentions>` block only of a turn in that same chat, and listed, changed or cancelled by her
calls only there (anywhere else its id is not found). Only an owner's own `/nep task intent` sees every one. The
analyzer proposes no candidates from a private chat: the private batch never asks for them, and its answer's
`intentions` field is ignored, so every candidate comes from a server conversation.

## Privacy

Every intention keeps the members of the conversation it came from (`provenance.participants`): who asked, whom her
turn answered or mentioned, or, for a candidate, the other authors of its channel in the analyzer's batch.
`/nep memory forget` removes every intention, open or closed, that concerns the member: one meant for them
(`destination`), one from a conversation with them, and one whose words (the purpose, the quoted span of her line,
the completion condition) carry their id or one of their known names as a whole word. The file is copied into the
forget's vault first. `/nep memory wipe` deletes `intentions.json` with the rest of the server's memory (the vault
holds the copy).

## What she sees

`<intentions>` in the tail of every turn but a diary post: her open intentions (pending, then waiting, with due
times, the awaited errand, an outcome or how a wait ended), then the candidates with the words of her line they came
from (an `external` one marked with `labels.intentions.externalMarker`, so she knows it waits for an ordinary turn of
hers), cut to `context.caps.intentions` tokens. See the [prompt contract](prompt-contract.md) and
[configuration](configuration.md#intentions).

## Turning it on

Set `features.intentions` to `true`, and grant her the skills by name (`/nep access grant` with her as the user:
`intent.set`, `intent.update`, `intent.cancel`, `intent.list`). Her own calls run on her grant alone, under the rules
on who asked: a turn nobody asked for (a spontaneous one) cannot write them; an inner turn, her own initiative, can.
