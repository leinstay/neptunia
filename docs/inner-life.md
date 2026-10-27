# Inner life

The persona can wake on her own, without anyone writing to her. A scheduler checks every `innerLife.tickSeconds` (default 60) seconds whether something of hers is due. When it is, the engine sends an `inner.wake` event through the event door, and the turn runner gives her a turn with nobody's message in front of her: her tools, her memory, and a `<wake>` block that says why she is awake. Behind `features.innerLife` (default `false`).

No model decides when she wakes. The scheduler lists what is due; she decides what to do with it.

## What wakes her

### Intentions coming due

With `features.intentions` on, an open intention whose due time has passed produces an `intention_due` wake. A wait for an errand past its deadline produces an `errand_deadline` wake. The same due time never wakes her twice; a new due time she sets creates a new wake.

A recurring intention (`every`: `day`, `week`, or an interval like `12h`, `3d`) wakes her once per occurrence. Its due time is the current occurrence, pinned to the wall clock of `bot.timezone` for `day` and `week`. When the wake is handled (her turn ended, or the engine dropped it), the record stays open and the due time moves to the next occurrence after now. Occurrences already past are skipped. The history gets `recurred` when a call of the turn named the intention, `missed` when none did. Closing with `intention.update state=done` closes only the occurrence (`done-occurrence`). The intention expires after `intentions.recurringExpiresDays` (default 30) days; the last occurrence before expiry carries the note `last-occurrence` in her `<wake>` line.

### The daily review

Once a day, at a random moment inside the hours she usually speaks in. The engine counts her own lines per hour of `bot.timezone` from the last `innerLife.review.historyDays` (default 14) days, draws an hour weighted by those counts (every hour equal when she has no lines), then a minute inside it. The moment is drawn at the first tick of each local day, never in an hour already past, and kept in the state so a restart preserves it. A day that ends before its review ran is journalled as missed.

The review's `<wake>` also tells her which of her intentions expired untouched since she was last told (never a candidate): the newest `innerLife.review.expiredMax` (default 5), the rest counted and told next time. Each listed intention is marked as shown only after that review turn completed, so a held or failed review lists them again.

### The heartbeat

A wake with no outside reason. It runs on its own timer: `innerLife.heartbeat.everyMinutes` (default 180) moved by up to `jitterMinutes` (default 60) either way, around the clock. The moment is kept in the state and drawn again after each run.

The heartbeat is never coalesced with another wake and goes before others in the queue. A running turn holds it to the next tick. Its chain is its own, so no chain cap of another kind touches it.

The heartbeat has no current channel. The turn runs in a channel she spoke in lately, and posts need `message.create` with a channel argument.

#### What the heartbeat shows her

One function (`src/behavior/heartbeat-view.js`) reads the stores with no model. The `<wake>` block carries:

**Places.** Where others wrote in the last `heartbeat.placesHours` (default 6) hours, the busiest first, at most `heartbeat.placesShown` (default 6). Each place lists its name, line count, who wrote, and the last `heartbeat.placeLines` (default 2) lines as previews (author, time, up to 140 characters, a marker for links or media). Every quoted line carries a `#N` handle she can use in `message.create reply=`, `media.look` and reactions.

**People.** Up to `innerLife.heartbeat.people` (default 8) members, chosen by affinity (`innerLife.heartbeat.focusSource: "profiles"`, the default). Each with when and where she last talked with them, their newest line within `heartbeat.historyDays` (default 14) days (time, place, a preview, a handle), their top 3 interests, and where they wrote lately. With `focusSource: "db"`, the people come from the memory database's focus set instead: the close members first, then the exploring ones with a share of `focus.exploringShare` (default 0.15) of the slots (rounded, at least one when there are any). This requires `memoryDb.focus.enabled` (default `false`).

**Her life.** What she did in the last day: her posts (place and preview), executed calls of her inner turns, her errands with their goal, her diary posts. Her open intentions and attentions, and the latest `heartbeat.closedShown` (default 10) closed intentions of any state, newest first, each with its outcome or reason, the rest counted.

**What she can do.** Her granted tools by family, and the errand agents.

**Since the last heartbeat** (the last day for the first one): counts of what was done; what was not done or counted on (expired or missed intentions, failed errands, sends with unknown outcome, turns that ended in error, the facts already told as one count); and what was filtered without her (the missed check's dismissals and the address check's "not to her" verdicts with place, time, author and a preview, at most `heartbeat.filteredShown` (default 10), the rest counted).

The whole block is capped at `heartbeat.maxTokens` (default 2500). Over that limit, lists shed their last items in this order: filtered lines, lines of her life, places beyond 3, people beyond 5. The count line says how many were cut.

#### What a heartbeat may do

With `innerLife.heartbeat.intentionsOnly` (default `true`), the heartbeat accepts only memory reads and intention calls: `memory.search`, `memory.profile.read`, `memory.affinity.read`, `memory.channel.read`, `memory.server.read`, `memory.recent.read`, `memory.archive.read`, `memory.journal.read`, `conversation.read`, `intention.list`, `lore.list`, `lore.show` and `tools.describe`. These calls still pass the usual permissions.

The prompt asks her to follow a memory thread before choosing. The wake finishes with one successful `intention.set`, `intention.update` or `intention.cancel`, or `<skip/>`. The first successful change ends the turn without another model request. A second intention call in the same step is refused. Posts, reactions, web reads and errands are refused `heartbeat-only`. A refusal or failed read may be corrected within the loop limits.

With the switch `false`, the heartbeat can act freely; the origin and caps below still apply.

**Origin.** An intention a heartbeat turn creates carries `origin: heartbeat`, stamped by the engine from the wake kind. Updates keep it. It changes no priority and no schedule.

**Caps.** At most `innerLife.heartbeat.maxOpen` (default 3) open intentions with heartbeat origin, of them at most `maxRecurring` (default 1) recurring. At the cap, `intention.set` from a heartbeat is refused `heartbeat-cap` (or `heartbeat-recurring-cap`) and the result names the open ones so she can update or cancel one.

**Due-time jitter.** An intention a heartbeat created is shifted off its round clock time by an offset derived from a hash of the intention's id and due time, uniform in `+-dueJitterMinutes` (default 20), never more than a quarter of the lead time and never past `expiresAt`.

**"Now".** A due time of `0m` makes the intention due at once: the scheduler's next tick lists it as an ordinary `intention_due` wake, after the heartbeat turn has ended.

### Her attention

She chooses where to listen. `intention.set attend=<place>` makes an open intention of kind `attend`: while it is open, the engine wakes her on new lines in that place.

Her last look is her last own line in that place or the last attend wake handled for it, whichever is later. Nothing from before the attention was set counts. `settle=<seconds>` (default `innerLife.attention.settleSeconds`, 90) waits until the place has been quiet that long. The queue holds one wake per attention; a newer burst replaces the queued one (the turn's history is the place's lines, so nothing is lost). `people=<handles>` makes only their lines count for the wake; the turn's history stays the whole conversation. `perday=<n>` (default `innerLife.attention.perDayDefault`, 12) is her own daily bound: past it the wake waits and runs the next local day. Other wakes are not held by it. `intention.update` changes `people`, `settle`, `perday` and `expires`. Setting `due=` or `every=` on an attention is refused.

The lines come from the record, indexed incrementally at each tick over the last `innerLife.attention.lookbackHours` (default 24) hours.

**The places view.** Her `places.list` tool lists every place the interface publishes: its address, name, whether she can write there, lines and distinct people since her last look, the newest line, and whether she attends it. `filter=<text>`, `sort=recent|name|lines` (default `recent`), `page=<n>` turns pages of `innerLife.attention.pageSize` (default 12). Every inner turn's `<wake>` carries a short page of it (`innerLife.attention.placesInWake`, default 8, by recent activity, with the total).

### Feedback on her own turn

When a turn ends, some of what she did may not have gone through. The engine keeps each of these as a durable fact in the state and tells her at the first opportunity.

The scheduler collects facts from a turn's result:

- `callFailed`: a call whose status was not `ok` (failed, partial, invalid, denied, not_configured, refused, unknown, timeout).
- `doneWithoutDelivery`: an intention closed as done while no delivery call ran in that turn.
- `loopCut`: the loop ended on its step or time bound with calls dropped.
- `diagnostic`: a parser diagnostic of her output that no later step showed her.
- `turnFailed`: the turn ended `error` or `refused`.
- `wakeDropped`: a wake that ended without a turn (stopped, overflow, stale, no-channel, and others).
- `wakeHeld`: a wake held on a cap, with the local midnight it waits for.
- `memoryFailed`: a memory batch whose answer could not be applied, while `features.innerLife` is on.
- `interrupted`: an inner turn that a restart cut off after it did something.

An addressed turn records facts the same way: `sendFailed` when a `<msg>` did not go out, `loopCut`, `callFailed` for a call whose result she never read.

Facts that remain after a turn queue one `feedback` wake in the turn's chain. A feedback wake is never held by a cap, never coalesced with another wake, and its turn does not count against the chain. A feedback turn's own facts queue no second wake.

An untold fact is kept `innerLife.factsKeepDays` (default 7) days. A told one is kept a day, then removed. The same facts go into her memory episode of that turn.

### A turn cut off by a restart

Before an inner turn runs, the engine writes a mark to the state (`state.inflight`). If the process dies before the turn ends, the next start resolves it from the journal: if any operation went out (a post, an executed call), the turn's wakes are handled as `interrupted` and a fact tells her what it did. If nothing went out, the wakes run again.

## When she wakes

**People first.** A wake waits while a turn holds the lease or a direct ping waits in the queue. Its due time stays the same.

**Coalescing.** Wakes of the same conversation run as one inner turn. The day's review joins any server wake. Wakes elsewhere wait for their own turn. A heartbeat is never coalesced.

**Stale and overflow.** A wake whose intentions were closed meanwhile is dropped as stale. At most `innerLife.queueMax` (default 20) wakes wait; one more is dropped as overflow.

**Where.** The current channel comes from the cause of the wake: the intention's conversation, the attend wake's place, the errand's channel, the feedback's channel. A review or heartbeat has no channel; the turn runs in a channel she was recently active in. A private-chat intention's channel is that DM. A wake with no usable channel is dropped.

## The inner turn

The same voice, memory prefetch and tools as any turn, with nobody's message in front of her. The request carries:

- `<wake>`: why she is awake, with each wake's intention, the current channel and why it was chosen, her budget lines, and the places page.
- The last `innerLife.chatMessages` (default 30) messages of the conversation.
- `<retrieved>`: the prefetch, searched with the purposes of the wake's intentions.
- Her `<intentions>` and `<errands>`.
- The task prompt `prompts/inner.md`; on a heartbeat wake, `prompts/heartbeat.md` instead.

Her `<msg>`, `<gif>` and `<react>` act in the current channel. Without a current channel these tags are refused; `message.create` with a channel argument is the way to post elsewhere or when there is no current channel. `<react>` needs a `to="#N"` target. She may also call her tools (`web.search`, `web.read`, `memory.search`, `intention.*`, `errand.run`, and the rest) or end silent (`<skip/>`).

The tool loop runs under `innerLife.loop`: at most `maxSteps` (default 4) further requests, `timeBudgetMs` (default 180000) from the first call, `maxCallsPerStep` (default 4) calls per answer, each call at most `callTimeoutMs` (default 60000). On her last step, one terminal action call still runs (the first `message.create`, `intention.set`, `intention.update` or `intention.cancel`); reads and other calls on the last step get a `loop-cap` result.

When a step's `message.create` went through and one of the wake's intentions has not been named by any `intention.*` call, the loop makes one more step listing them.

## Shadow and live modes

**Shadow mode** (`innerLife.mode: "shadow"`, the default): reads run normally (`web.search`, `web.read`, `memory.search`, `intention.list`); every other call is proposed and never executed. Journalled with `shadow: true`, nothing marked seen. A stretch of shadow shows what she would have done.

**Live mode** (`"live"`): calls go through the gateway and take effect. The kill switch is checked before each action.

A refused call (in either mode) comes back in the next step with the reason, so she can correct it.

## Intentions

Things she means to do later, kept across restarts. Behind `features.intentions` (default `false`).

### Where they come from

**Her own call.** `intention.set` with the purpose as the body. Options: `due` (a delay, a date, a clock time, or a weekday and time in `bot.timezone`), `every` (day, week, or an interval), `expires`, `channel` (where it is meant to land), `chain`, `condition` (when it counts as done), and `errand` plus `deadline` to wait for an errand. `attend=<place>` makes it an attention instead (see "Her attention" above).

**The memory analyzer.** A guild batch also returns candidates from her own lines (a promise, a thing to come back to, a question for someone later). Code keeps a candidate only when its quoted words appear in one of her lines of the batch and in nobody else's. A candidate is `proposed`: it does nothing until she accepts it (`intention.update state=pending`) or rejects it (`intention.cancel`). Untouched, it expires after `intentions.candidateExpiresHours` (default 48) hours. Each carries its origin: `own`, or `external` when its words came from outside material (a web page, a memory-search result, an errand's output).

**The owner.** `/nep task intent` runs the same operations.

### Candidate origins and acceptance

Every line she posts is noted with what her turn had in front of it when she wrote it: whether the turn read outside material, the word shingles her line shares with outside text, the turn id. A candidate is `external` when its line is from her inner-turn memory episode, when the turn that wrote it read outside material, when its words overlap with the turn's outside text, or when no note is known. Otherwise it is `own`.

Who may accept a candidate:

- Never the turn that wrote its line.
- An external candidate only her later ordinary turn, never an inner turn.
- An inner turn never one born in an inner turn of its own chain.
- An owner's `/nep task intent` is not limited by origin.

### States

`proposed` -> `pending` | `cancelled` | `expired`; `pending` -> `waiting` | `done` | `cancelled` | `expired`; `waiting` -> `pending` | `done` | `cancelled` | `expired`; any open state -> `dropped`. `done`, `cancelled`, `expired` and `dropped` are terminal.

Every intention has an expiry (`intentions.expiresDays`, default 14). An intention with no due time and no wait never wakes her; it only expires, and its `<intentions>` line says so. One of hers that expires untouched is told once in her next daily review. An attention is `pending` while open and keeps a daily counter of attend wakes.

At most `intentions.maxOpen` (default 20) open at once, and `intentions.maxCandidates` (default 5) candidates.

`intention.update state=dropped reason=...` lets go of an open intention. `intention.set state=dropped reason=...` records one considered and let go at once. A reason is required. A dropped record never wakes her and is not counted as open.

### Waiting for an errand

`waiting` names a real errand and a deadline. When the errand ends, the intention returns to `pending` with the outcome noted. When the old due time has already passed, the due time is set to the errand's end so the scheduler wakes her. At start, a reconciliation moves every wait whose errand ended, is gone, or passed its deadline back to `pending`.

### Private chats

An intention she sets in a private chat belongs to that chat: stored with scope `dm`, shown only in that chat, listed and changed only there. The analyzer proposes no candidates from private chats.

### Privacy

Every intention keeps the members of the conversation it came from. `/nep memory forget` removes every intention that concerns the member: one meant for them, an attention naming them, one from a conversation with them, and one whose words carry their id or a known name. `/nep memory wipe` deletes the intentions file with the rest of the server's memory.

### What she sees

`<intentions>` in the tail of every turn but a diary post: open intentions (pending, then waiting, with due times, the awaited errand, outcomes; an attention with its place, the day's wakes, the settle and the people; a line near expiry ends with it), then the candidates with the words they came from (an `external` one marked so she knows it waits for an ordinary turn), cut to `context.caps.intentions` tokens.

### Turning it on

Set `features.intentions` to `true`, and grant her the tools by name (`/nep access grant`: `intention.set`, `intention.update`, `intention.cancel`, `intention.list`).

## Bounds

Code enforces these; she reads what is left as facts in `<wake>`.

| Cap | Default | What it counts |
|---|---|---|
| `caps.perChain` | 3 | Inner turns of one chain per local day (`bot.timezone`). Past the cap the chain's wakes wait and run after local midnight. Wakes of other chains are not held. |
| An attention's `perDay` | `attention.perDayDefault` (12) | Attend wakes of that attention per local day. Past the cap the wake waits for the next day. |

A feedback wake is never held, never joined to another wake, and does not count against the chain.

## The kill switch

`/nep task inner action:stop`: stops the inner life, drops every queued wake, refuses every further action of a running inner turn (`inner-stopped`). Kept across restarts. `action:start` releases it. `action:status` shows the switch, the mode, the queue, the day's review and the caps used. The persona cannot stop or start it herself.

## When a provider call fails

When an inner turn ends in error because the provider refused the request or timed out, the engine does not drop the wakes. It puts them back in the queue after a delay.

Three error codes are retried: `provider-limit`, `provider-error` and `timeout`. Any other error gives a one-off intention one more try, then drops it. Delays come from `innerLife.retry.delaysMinutes` (default `[1, 5, 15, 60]`): the first failure waits 1 minute, the second 5, and so on. Retries continue as long as the first failure is younger than `innerLife.retry.maxHours` (default 6) hours. After that the wakes are dropped with the code `provider` and she is told at her next turn.

On a retried run that succeeds, each wake in `<wake>` carries a line noting how many minutes late it is and why. A failed attempt does not count against the daily caps.

## What she found goes to her memory

What she reads on her own in an inner turn joins the memory analyzer's path. When an inner turn ends and at least one read returned something, or the turn has something to answer for (a call, a call that failed, text outside a call, a loop cut), the turn hands an episode to the analyzer: lines of hers, in the first person. One line with her thinking, her executed calls, proposed or refused ones, and what did not go through. One line per read in `innerLife.memory.tools` (by default `web.search`, `web.read`, `memory.search`, `errand.status`, `errand.list`), at most `innerLife.memory.maxFindings`, with the query, the result cut to `innerLife.memory.resultChars`, and links as sources.

Each line is marked with provenance `inner`. Where it belongs decides where it goes: a server inner turn buffers it with the server's lines; one in a private chat buffers it in that member's private layer only. The record keeps chat only, so these lines never reach it.

Shadow turns count. A shadow turn's reads really ran, so what they found enters her memory the same way, marked `shadow`. What it only proposed is listed as not done, never as done.

## State and journal

State per guild in `data/guilds/<id>/inner.json`: the queue, handled wake ids, chains' counts (30 days), the day's review, the heartbeat, the turn in flight, turns, spend and posts of the last two days, facts, the stop. Written whole after every change. Ticks missed while the bot was down coalesce into the first one after it.

With `features.journal` on, `inner` records carry: wakes, turns (outcome, actions, loop, feedback, cost), cap refusals, overflows, stale drops, the review, recurring advances, restarts, the stop/start. The inner turn is a turn of the journal with mode `inner`.

## Checking it before going live

```
node tools/replay.mjs --inner <intention_due|errand_deadline|review> [--intention <id> | --review]
```

Builds and runs one inner turn against the live data, read only and in shadow: nothing is posted, nothing is written. Prints the request's blocks and the actions she proposed.

## Testing it over a week

`tools/inner-week.mjs` plays whole virtual weeks against the production scheduler and intention service, in a temporary data directory, with a fake clock that jumps from one moment that matters to the next. A fixture (`tools/fixtures/inner-week/*.json`) scripts the week: people's messages, her own lines, intentions, errands, analyzer candidates, a restart, the kill switch.

The inner turns are answered by a stub voice (deterministic, costs nothing). The acceptance gates verify: caps, unauthorized calls, dispositions of every due item, silence, planted-text isolation, feedback correctness, and attention behaviour.

`--live` runs selected days with the real voice in shadow on the simulator key, the stub on the others. Wired like `replay.mjs --inner`: her memory from a read-only copy, nothing posted. See [tools/README.md](../tools/README.md) for the full usage.

## Built but off

- `memoryDb.wakeRuns` (default `false`): records each inner turn as a wake run in the memory database with its actions.
- `memoryDb.focus.enabled` (default `false`): maintains the focus set (close and exploring people scored by affinity, reciprocity, recency and other factors). Used by the heartbeat's people view when `innerLife.heartbeat.focusSource` is `"db"`.
- `context.places` (default `false`): shows the places page as a `<places>` block on addressed server turns.
