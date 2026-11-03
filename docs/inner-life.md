# Inner life

The persona can wake on her own, without anyone writing to her. A scheduler checks every `wakes.tickSeconds` (default 60) seconds whether something of hers is due. When it is, the engine sends an `inner.wake` event through the event door, and the turn runner gives her a turn with nobody's message in front of her: her tools, her memory, and a `<wake>` block that says why she is awake.

No model decides when she wakes. The scheduler lists what is due; she decides what to do with it.

## What wakes her

### Intentions coming due

An open intention whose due time has passed produces an `intention_due` wake. A wait for an errand past its deadline produces an `errand_deadline` wake. The same due time never wakes her twice; a new due time she sets creates a new wake.

A recurring intention (`every`: `day`, `week`, or an interval like `12h`, `3d`) wakes her once per occurrence. Its due time is the current occurrence, pinned to the wall clock of `bot.timezone` for `day` and `week`. When the wake is handled (her turn ended, or the engine dropped it), the record stays open and the due time moves to the next occurrence after now. Occurrences already past are skipped. The history gets `recurred` when a call of the turn named the intention, `missed` when none did. Closing with `intention.update state=done` closes only the occurrence (`done-occurrence`). The intention expires after `intentions.recurringExpiresDays` (default 30) days; the last occurrence before expiry carries the note `last-occurrence` in her `<wake>` line.

### The daily review

Once a day, at a random moment inside the hours she usually speaks in. The engine counts her own lines per hour of `bot.timezone` from the last `wakes.review.historyDays` (default 14) days, draws an hour weighted by those counts (every hour equal when she has no lines), then a minute inside it. The moment is drawn at the first tick of each local day, never in an hour already past, and kept in the state so a restart preserves it. A day that ends before its review ran is journalled as missed.

The review's `<wake>` also tells her which of her intentions expired untouched since she was last told (never a candidate): the newest five (`INNER_DEFAULTS.review.expiredMax` in `src/behavior/inner/settings.ts`), the rest counted and told next time. Each listed intention is marked as shown only after that review turn completed, so a held or failed review lists them again.

### The heartbeat

A wake with no outside reason. It runs while `heartbeat.enabled` is `true` (the default), on its own timer: `heartbeat.everyMinutes` (default 180) moved by up to `jitterMinutes` (default 60) either way, around the clock. The moment is kept in the state and drawn again after each run.

The heartbeat is never coalesced with another wake and goes before others in the queue. A running turn holds it to the next tick. Its chain is its own, so no chain cap of another kind touches it.

The heartbeat has no current channel. The turn runs in a channel she spoke in lately, and posts need `message.create` with a channel argument. With no interface connected, none offers the `conversation.info` read, and the turn runs in a stand-in of the served community with no history, as the `selfreflection` wake does (`src/behavior/inner/drain.ts`). A post then fails at the port with its usual code.

#### What the heartbeat shows her

One function (`src/behavior/heartbeat-view.ts`) reads the stores with no model. The `<wake>` block carries:

**Places.** Where others wrote in the last six hours, the busiest first, at most six places. Each place lists its name, line count, who wrote, and the last two lines as previews (author, time, up to 140 characters, a marker for links or media). The three counts are `placesHours`, `placesShown` and `placeLines` of `INNER_DEFAULTS.heartbeat` in `src/behavior/inner/settings.ts`. Every quoted line carries a `#N` handle she can use in `message.create reply=`, `media.look` and reactions.

**People.** Up to eight members (`INNER_DEFAULTS.heartbeat.people`), taken from the memory database's focus set: the close members first, then the exploring ones with a share of 0.15 of the slots (`FOCUS_DEFAULTS.exploringShare` in `src/memory/db/focus.ts`, rounded, at least one when there are any). While the database is closed the members are ranked by affinity instead. Each comes with when and where she last talked with them, their newest line within `heartbeat.historyDays` (default 14) days (time, place, a preview, a handle), their top 3 interests, and where they wrote lately.

**Her life.** What she did in the last day: her posts (place and preview), executed calls of her inner turns, her errands with their goal, her diary posts. Her open intentions and attentions, and the latest ten closed intentions (`INNER_DEFAULTS.heartbeat.closedShown`) of any state, newest first, each with its outcome or reason, the rest counted.

**What she can do.** Her granted tools by family, and the errand agents.

**Since the last heartbeat** (the last day for the first one): counts of what was done; what was not done or counted on (expired or missed intentions, failed errands, sends with unknown outcome, turns that ended in error, the facts already told as one count); and what was filtered without her (the missed check's dismissals and the address check's "not to her" verdicts with place, time, author and a preview, at most ten (`INNER_DEFAULTS.heartbeat.filteredShown`), the rest counted).

The whole block is capped at `heartbeat.maxTokens` (default 2500). Over that limit, lists shed their last items in this order: filtered lines, lines of her life, places beyond 3, people beyond 5. The count line says how many were cut.

#### What a heartbeat may do

The heartbeat accepts only memory reads and intention calls: `memory.search`, `memory.profile.read`, `memory.affinity.read`, `memory.channel.read`, `memory.server.read`, `memory.recent.read`, `memory.archive.read`, `memory.journal.read`, `conversation.read`, `intention.list`, `lore.list`, `lore.show` and `tools.describe`. These calls still pass the usual permissions.

The prompt asks her to follow a memory thread before choosing. The wake finishes with one successful `intention.set`, `intention.update` or `intention.cancel`, or `<skip/>`. The first successful change ends the turn without another model request. A second intention call in the same step is refused. Posts, reactions, web reads and errands are refused `heartbeat-only`. A refusal or failed read may be corrected within the loop limits.

Beyond that fixed list, every inner turn's call is checked against the envelope of its wake kind (`wakeEnvelope` in `src/tools/access.ts`): `wakes.kinds.<kind>.tools` (`"*"` or a list of tool names, where `family.*` names a family), `maxActs` (the most calls that change something in one turn) and `maxTasks` (the most errands). The heartbeat and the selfimprovement wake read the same keys from their own sections, `heartbeat.tools`, `heartbeat.maxActs` and `heartbeat.maxTasks`, and `selfimprovement.tools`, `selfimprovement.maxActs` and `selfimprovement.maxTasks`. The default is `"*"` with no cap. A nested capability counts too: a picture or a voice message is a post, so an envelope that forbids `message.create` forbids both. A refusal is `not-allowed` with the refusing key as its reason. `inputTokens` sits in the envelope as the declared input budget, and no check compares a request with it. Every wake run records the envelope's policy version.

**Origin.** An intention a heartbeat turn creates carries `origin: heartbeat`, stamped by the engine from the wake kind. Updates keep it. It changes no priority and no schedule.

**Caps.** At most three open intentions with heartbeat origin, of them at most one recurring (`HEARTBEAT_LIMITS` in `src/intentions/model.ts`). At the cap, `intention.set` from a heartbeat is refused `heartbeat-cap` (or `heartbeat-recurring-cap`) and the result names the open ones so she can update or cancel one.

**Due-time jitter.** An intention a heartbeat created is shifted off its round clock time by an offset derived from a hash of the intention's id and due time, uniform in `+-dueJitterMinutes` (default 20), never more than a quarter of the lead time and never past `expiresAt`.

**"Now".** A due time of `0m` makes the intention due at once: the scheduler's next tick lists it as an ordinary `intention_due` wake, after the heartbeat turn has ended.

### The selfimprovement wake

A wake for looking back at her own work. It falls due once a day at `selfimprovement.at` (default `03:00`) of the UTC day, the server clock, three hours after the watcher's default run, so it carries the watcher's newest report. A core that was down at that time raises the day's wake at its next tick that day, with the same moment and id. It also falls due early when one chain shape fails `selfimprovement.failuresPerShape` (default 3) times in one UTC day, at most once a day. While `selfimprovement.enabled` is `false` it never falls due. The first tick of a state with no clock only starts it, so a fresh install's first wake is the next `selfimprovement.at`.

The state keeps `selfimprovement: { lastAt, raisedAt }`. `raisedAt` is when a failure cause last raised a wake. `lastAt` is the time of the last wake whose turn did not end in an error, set once that turn's completion committed (`src/behavior/inner/selfimprovement.ts`). The wake has no place, goes alone like the heartbeat (after a heartbeat that shares its moment) and runs in a channel she spoke in lately, or in the stand-in when there is none. `wakes.mode` governs it like every other wake.

Her `<wake>` carries the facts of `src/behavior/selfimprovement-view.ts`, read from the journal and the board with no model. A chain is the tool calls of one turn in order. The chains of the last 14 days are grouped by the ordered tool names with each call's argument names, and the five most frequent shapes come with their counts, failures, retries, costs, the turn of the newest chain and up to five turn ids. Beside them stand the tools she holds and called in none of those chains, her skills with their use counts, her proposals with their state, and what the board holds for her since the last such wake: the questions put to her, the reviews (a rejection included, a plan approval left out) and the outbox rows addressed to `persona:self`. While `watcher.enabled` is `true`, the watcher's newest report of that UTC day or the day before comes last, its date and its `For the owner` and `Tasks filed` sections (`src/watcher/news.ts`, [The watcher](watcher.md#her-selfimprovement-wake)). The facts carry tool names, argument names, codes, counts, ids, costs, the board's own titles and notes and the watcher's text, and no line of chat.

Once the completion committed, the outbox rows the view showed are marked delivered, so each question and rejection reaches her once. A wake that never committed shows them again. Her answer is `board.propose` with a `kind` of `skill` or `fix` ([Skills](skills.md#how-a-skill-is-made)). A `fix` that reaches a merge comes back as a landed change in this wake or the next heartbeat, whichever comes first ([Self-development](selfimprovement.md#what-reaches-her-wake)).

### Her attention

She chooses where to listen. `intention.set attend=<place>` makes an open intention of kind `attend`: while it is open, the engine wakes her on new lines in that place.

Her last look is her last own line in that place or the last attend wake handled for it, whichever is later. Nothing from before the attention was set counts. `settle=<seconds>` (default 90, `ATTEND_DEFAULTS.settleSeconds` in `src/intentions/model.ts`) waits until the place has been quiet that long. The queue holds one wake per attention; a newer burst replaces the queued one (the turn's history is the place's lines, so nothing is lost). `people=<handles>` makes only their lines count for the wake; the turn's history stays the whole conversation. `perday=<n>` (default 12, `ATTEND_DEFAULTS.perDayDefault`) is her own daily bound: past it the wake waits and runs the next local day. Other wakes are not held by it. `intention.update` changes `people`, `settle`, `perday` and `expires`. Setting `due=` or `every=` on an attention is refused.

The lines come from the record, indexed incrementally at each tick over the last 24 hours (`INNER_DEFAULTS.attention.lookbackHours`).

**The places view.** Her `places.list` tool lists every place the interface publishes: its address, name, whether she can write there, lines and distinct people since her last look, the newest line, and whether she attends it. `filter=<text>`, `sort=recent|name|lines` (default `recent`), `page=<n>` turns pages of 12 places (`INNER_DEFAULTS.attention.pageSize`). Every inner turn's `<wake>` carries a short page of it (eight places, `INNER_DEFAULTS.attention.placesInWake`, by recent activity, with the total).

### Her diary

The diary is a wake of its own, `selfreflection`. Its day plan runs on the scheduler's `diary.tick` (`src/behavior/diary.ts`), and each due slot runs a diary turn with no conversation: it reads every group conversation and no direct chat, writes her entry into memory, and the diary's mirrors post it (`src/behavior/mirror.ts`). A mirror place is written only by the diary: an event there opens no turn, and every send there from another turn, wake or tool is refused `diary-mirror`. See [Diary](diary.md).

### Feedback on her own turn

When a turn ends, some of what she did may not have gone through. The engine keeps each of these as a durable fact in the state and tells her at the first opportunity.

The scheduler collects these facts from a turn's result.

| Fact | Recorded when |
|---|---|
| `callFailed` | A call's status was not `ok` (failed, partial, invalid, denied, not_configured, refused, unknown, timeout) |
| `doneWithoutDelivery` | An intention closed as done while no delivery call ran in that turn |
| `loopCut` | The loop ended on its step or time bound with calls dropped |
| `diagnostic` | The parser flagged her output and no later step showed her |
| `turnFailed` | The turn ended `error` or `refused` |
| `wakeDropped` | A wake ended without a turn (stopped, overflow, stale, no-channel and others) |
| `wakeHeld` | A wake is held on a cap, with the local midnight it waits for |
| `memoryFailed` | A memory batch's answer could not be applied |
| `interrupted` | A restart cut off an inner turn, with its known outcomes |
| `stateLost` | The inner state could not be read and she started empty |

An addressed turn records `sendFailed` when a `<msg>` did not go out, `loopCut`, and `callFailed` for a call whose result she never read.

Facts that remain after a turn queue one `feedback` wake in the turn's chain. A feedback wake is never held by a cap, never coalesced with another wake, and its turn does not count against the chain. A feedback turn's own facts queue no second wake.

An untold fact is kept `wakes.factsKeepDays` (default 7) days. A told one is kept a day, then removed. The same facts go into her memory episode of that turn.

### A turn cut off by a restart

An inner turn claims its wakes in the memory database before it asks the model (`src/behavior/inner/wake-store.ts`). The claim is one committed transaction: each wake moves from `queued` to `running` and takes the lease `wake:<id>` with a new token for `context.turnLeaseMs` (default 300000) milliseconds, and the inner life renews it at every tick while the turn runs. When the turn ends, a second transaction checks the tokens, marks the wakes the turn disposed of `handled` and puts the rest back to `queued` (a retry, a turn held as busy). A holder whose token a newer claim raised writes nothing. No transaction is open while the model is asked.

At startup, `src/behavior/inner/recovery.ts` marks old queued and running wakes as interrupted. It preserves their turn identities and the underlying work records. Journal evidence describes completed or uncertain operations, but an empty journal does not authorize another turn. Retaining unfinished work creates no wake. The persona may choose a new action during a later turn.

## When she wakes

**People first.** A wake waits while a turn holds the lease or a direct ping waits in the queue. Its due time stays the same.

**Coalescing.** Wakes of the same conversation run as one inner turn. The day's review joins any server wake. Wakes elsewhere wait for their own turn. A heartbeat and a selfimprovement wake are never coalesced.

**Sleep.** A wake that fell due while the core was down or paused sleeps: it becomes `slept` and never runs (`src/behavior/inner/recovery.ts`). A downtime runs from the last renewal of the `core:alive` lease, which every tick renews, to the first tick of the next start. A pause runs from the `pausedAt` of `/pause` to the first tick after `/resume`. A wake listed only after that interval sleeps too. A one-off intention whose wake slept is cancelled with a `sleptAt` mark, and her `intention.update` and `intention.cancel` on it answer `slept`. A recurring intention loses only that occurrence: its history records `slept`, and the next occurrence comes due as usual. Nothing about a slept wake becomes a fact, a wake or a memory. The owner's status counts the wakes slept since the start.

**Stale and overflow.** A wake whose intentions were closed meanwhile is dropped as stale. At most 20 wakes wait (`INNER_DEFAULTS.queueMax`); one more is dropped as overflow.

**Where.** The current channel comes from the cause of the wake: the intention's conversation, the attend wake's place, the errand's channel, the feedback's channel. A review or heartbeat has no channel; the turn runs in a channel she was recently active in. A private-chat intention's channel is that DM. A wake with no usable channel is dropped.

## The inner turn

The same voice, memory prefetch and tools as any turn, with nobody's message in front of her. The `<wake>` block says why she is awake: each wake's intention, the current channel and why it was chosen, her budget lines (the turns left on this thread, and the week's core turns against what the core keys' credit allows, [The core](core.md#keys)) and the places page. The last 30 messages of the conversation follow (`INNER_DEFAULTS.chatMessages`). `<retrieved>` holds the prefetch, searched with the purposes of the wake's intentions, and her `<intentions>` and `<errands>` come after. The task prompt is `prompts/inner.md`, and `prompts/heartbeat.md` on a heartbeat wake instead.

Her `<msg>`, `<gif>` and `<react>` act in the current channel. Without a current channel these tags are refused; `message.create` with a channel argument is the way to post elsewhere or when there is no current channel. `<react>` needs a `to="#N"` target. She may also call her tools (`web.search`, `web.read`, `memory.search`, `intention.*`, `errand.run`, and the rest) or end silent (`<skip/>`).

The tool loop runs under `wakes.loop`: at most `maxSteps` (default 4) further requests, `timeBudgetMs` (default 180000) from the first call, `maxCallsPerStep` (default 4) calls per answer, each call at most `callTimeoutMs` (default 60000). On her last step, one terminal action call still runs (the first `message.create`, `intention.set`, `intention.update` or `intention.cancel`); reads and other calls on the last step get a `loop-cap` result.

When a step's `message.create` went through and one of the wake's intentions has not been named by any `intention.*` call, the loop makes one more step listing them.

## Shadow and live modes

**Shadow mode** (`wakes.mode: "shadow"`, the default): calls whose effect is `read` run normally (`web.search`, `web.read`, `memory.search`, `intention.list`); every other call is proposed and never executed. Journalled with `shadow: true`, nothing marked seen. A stretch of shadow shows what she would have done.

**Live mode** (`"live"`): calls go through the gateway and take effect. The kill switch is checked before each action.

A refused call (in either mode) comes back in the next step with the reason, so she can correct it.

## A wake's sends

In live mode her posts in a wake turn wait until the wake completes. The drain gives the turn a hold (`src/tools/send-hold.ts`) when the inner life has a port to send through: `src/core.ts` passes the guarded port, and an inner life built without one holds nothing. `message.create`, the lowered `<msg>` and `<gif>`, the post of `draw.create` and `voice.say` are kept in the hold. Each answers `ok` with the code `held` and the text of `tools.result.heldUntilEnd`, and has no message id yet. A later call of the same turn on her `last` message in a conversation where a post is held (`message.edit`, `message.delete`, `message.react.add` or `message.react.remove`) is refused `held-message`. Her other calls run as in any live turn.

The wake's completion records one `deliveries` row per held post in the transaction that marks the wake handled (`finishTurn` in `src/behavior/inner/wake-store.ts`). The row is keyed by the call's effect key and names the wake and the conversation. Its payload is the conversation and the content (text, reply and mentions). A file with its bytes is written under `data/media/deliveries/` as a `media` row of kind `delivery`, and the payload names it. When the turn's wakes go back to the queue for a retry, nothing is recorded, and the rerun makes its posts again under the same keys.

After the completion commits, `src/behavior/inner/deliveries.ts` sends the rows in order through the port, each under its key, before the tick returns. Before each send it asks the kill switch again: while her inner life is stopped, the row stays `queued`. A row is `sending` from just before the port is called. The answer makes it `sent`, `unknown` or `failed` and is kept as its receipt. A sent `message.create` is recorded as a message turn records a sent post: a `post` operation of the wake's turn in the journal around the send, and her `said` line in the record with the message id and the turn's id. A row that ends `failed` or `unknown` is never sent again. It becomes a `callFailed` fact in its conversation, and one `feedback` wake there brings it to her next turn. At startup, queued deliveries become failed with an interruption receipt. A row still marked sending has an uncertain outcome. Read-only reconciliation may establish that it was sent, but never dispatches it again. The saved payload, key and known outcome remain available. Recovery creates no feedback wake.

A shadow turn, a message turn, the diary turn and the CLI chat hold nothing: their sends go out during the turn.

## Intentions

Things she means to do later, kept across restarts.

### Where they come from

**Her own call.** `intention.set` with the purpose as the body. Options: `due` (a delay, a date, a clock time, or a weekday and time in `bot.timezone`), `every` (day, week, or an interval), `standing` (see "Standing tasks"), `expires`, `channel` (where it is meant to land), `chain`, `condition` (when it counts as done), and `errand` plus `deadline` to wait for an errand. `attend=<place>` makes it an attention instead (see "Her attention" above).

**Candidates.** An intention in `proposed` is a candidate. It does nothing until she accepts it (`intention.update state=pending`) or rejects it (`intention.cancel`), and untouched it expires after `intentions.candidateExpiresHours` (default 48) hours. `addCandidates` in `src/intentions/service.ts` stores candidates from the `intentions` field of an analyzer batch. It keeps one only when its quoted words appear in one of her lines of the batch and in nobody else's, with at most five candidates open at once (`DEFAULTS.maxCandidates` in `src/intentions/model.ts`). No module calls `addCandidates`, and the memory session's answer has no `intentions` field, so nothing creates a candidate. The rules below govern a candidate that exists. Each carries its origin: `own`, or `external` when its words came from outside material (a web page, a memory-search result, an errand's output).

**The owner.** `/intentions list` lists the open intentions, `/intentions show <id>` shows one and `/intentions cancel <id>` cancels one, through `intention.list` and `intention.cancel`.

### Candidate origins and acceptance

Every line she posts is noted with what her turn had in front of it when she wrote it: whether the turn read outside material, the word shingles her line shares with outside text, the turn id. A candidate is `external` when its line is from her inner-turn memory episode, when the turn that wrote it read outside material, when its words overlap with the turn's outside text, or when no note is known. Otherwise it is `own`.

Who may accept a candidate:

- Never the turn that wrote its line.
- An external candidate only her later ordinary turn, never an inner turn.
- An inner turn never one born in an inner turn of its own chain.
- The owner's `/intentions cancel` is not limited by origin.

### States

`proposed` -> `pending` | `cancelled` | `expired`; `pending` -> `waiting` | `done` | `cancelled` | `expired`; `waiting` -> `pending` | `done` | `cancelled` | `expired`; any open state -> `dropped`. `done`, `cancelled`, `expired` and `dropped` are terminal.

Every intention has an expiry (`intentions.expiresDays`, default 14). An intention with no due time and no wait never wakes her; it only expires, and its `<intentions>` line says so. One of hers that expires untouched is told once in her next daily review. An attention is `pending` while open and keeps a daily counter of attend wakes.

At most `intentions.maxOpen` (default 20) are open at once.

`intention.update state=dropped reason=...` lets go of an open intention. `intention.set state=dropped reason=...` records one considered and let go at once. A reason is required. A dropped record never wakes her and is not counted as open.

### Waiting for an errand

`waiting` names a real errand and a deadline. When the errand ends, the intention returns to `pending` with the outcome noted. When the old due time has already passed, the due time is set to the errand's end so the scheduler wakes her. At start, a reconciliation moves every wait whose errand ended, is gone, or passed its deadline back to `pending`.

### Private chats

An intention she sets in a private chat belongs to that chat: stored with scope `dm`, shown only in that chat, listed and changed only there. The analyzer proposes no candidates from private chats.

### Privacy

Every intention keeps the members of the conversation it came from.

### What she sees

`<intentions>` in the tail of every turn but a diary post: open intentions (pending, then waiting, with due times, the awaited errand, outcomes; an attention with its place, the day's wakes, the settle and the people; a line near expiry ends with it), then the candidates with the words they came from (an `external` one marked so she knows it waits for an ordinary turn), cut to `context.caps.intentions` tokens.

### Turning it on

Grant her the tools by name with `/tools grant`: `intention.set`, `intention.update`, `intention.cancel` and `intention.list`.

## Bounds

Code enforces these; she reads what is left as facts in `<wake>`.

| Cap | Default | What it counts |
|---|---|---|
| `caps.perChain` | 3 | Inner turns of one chain per local day (`bot.timezone`). Past the cap the chain's wakes wait and run after local midnight. Wakes of other chains are not held. |
| An attention's `perDay` | 12 (`ATTEND_DEFAULTS.perDayDefault`) | Attend wakes of that attention per local day. Past the cap the wake waits for the next day. |

A feedback wake is never held, never joined to another wake, and does not count against the chain.

## The kill switch

`/wakes stop` stops the inner life (`inner.stop`). It drops every queued wake and refuses every further action of a running inner turn with `inner-stopped`, and the stop is kept across restarts. `/wakes start` releases it (`inner.start`), and `/wakes list` shows the switch, the mode, the queue, the day's review and the caps used (`inner.status`). The persona cannot stop or start it herself.

## When a provider call fails

When an inner turn ends in error because the provider refused the request or timed out, the engine does not drop the wakes. It puts them back in the queue after a delay.

Three error codes are retried: `provider-limit`, `provider-error` and `timeout`. Any other error gives a one-off intention one more try, then drops it. Delays come from `wakes.retry.delaysMinutes` (default `[1, 5, 15, 60]`): the first failure waits 1 minute, the second 5, and so on. Retries continue as long as the first failure is younger than `wakes.retry.maxHours` (default 6) hours. After that the wakes are dropped with the code `provider` and she is told at her next turn.

On a retried run that succeeds, each wake in `<wake>` carries a line noting how many minutes late it is and why. A failed attempt does not count against the daily caps.

## State and journal

The queue, handled wake ids and interrupted turn evidence live in the memory database's `wakes` table (see [memory.md](memory.md)). `src/behavior/inner/queue.ts` keeps one persona state under `personaKey('inner')`. The stop flag, review clock, heartbeat, selfimprovement clocks and counters are shared across conversation contexts. Facts and review channel snapshots retain their originating context. Loading another community does not create another inner life or reset its clocks. All durable writes use the memory database writer.

The journal's `inner` records carry: wakes, turns (outcome, actions, loop, feedback, cost), cap refusals, overflows, stale drops, slept wakes, the review, recurring advances, restarts and the stop and start of the kill switch. The inner turn is a turn of the journal with mode `inner`.

## Checking it before going live

```
node scripts/replay.ts --inner <intention_due|errand_deadline|review|heartbeat> [--intention <id> | --review]
```

Builds and runs one inner turn against the live data, read only and in shadow: nothing is posted, nothing is written. Prints the request's blocks and the actions she proposed.

## Testing it over a week

`scripts/inner-week.ts` plays whole virtual weeks against the production scheduler and intention service, in a temporary data directory, with a fake clock that jumps from one moment that matters to the next. A fixture (`scripts/fixtures/inner-week/*.json`) scripts the week: people's messages, her own lines, intentions, errands, analyzer candidates, a restart, the kill switch.

The inner turns are answered by a stub voice (deterministic, costs nothing). The acceptance gates verify: caps, unauthorized calls, dispositions of every due item, silence, planted-text isolation, feedback correctness, and attention behaviour.

`--live` runs selected days with the real voice in shadow on the simulator key, the stub on the others. Wired like `replay.ts --inner`: her memory from a read-only copy, nothing posted. See [scripts/README.md](../scripts/README.md) for the full usage.

## Wake runs, focus and places

Each inner turn is recorded as a wake run in the memory database with its actions. Once per UTC day the focus job (`src/memory/db/focus.ts`) recomputes the focus set, the close and exploring people scored by affinity, reciprocity, recency and other factors, and the heartbeat's people view reads it. Addressed server turns carry no `<places>` block: `ADDRESSED_PLACES` in `src/turn/inputs.ts` is `false`, and the code that builds the block stays.

## Standing tasks

`intention.set` with `standing` true and an `every` makes a recurring task that lasts until it is cancelled (`createIntention` in `src/intentions/model.ts`). `standing` without `every` is refused `bad-every`. Its `expiresAt` is the far end of the calendar, so every clock comparison stays as it is. Missed occurrences are skipped, after any length of absence, and nothing interrupted is replayed. Ordinary intentions keep `intentions.expiresDays`, and ordinary recurring ones `intentions.recurringExpiresDays`.
