# Inner life

The persona wakes on her own when she has a reason to: an intention of hers comes due, a wait for one of her errands runs past its deadline, or her one review of the day comes. Behind `features.innerLife` (off by default), in `innerLife.mode` `shadow` by default. Nothing here thinks continuously and no model decides when she wakes: a scheduler lists what is due, and she decides what, if anything, to do with it.

## What wakes her

Every `innerLife.tickSeconds` (60) the scheduler (`src/behavior/inner.js`) looks at:

- **Her intentions** ([Intentions](intentions.md), with `features.intentions` on). An open intention whose due time has passed is an `intention_due` wake. A wait for an errand past its deadline is an `errand_deadline` wake (also when the reconciliation at start already moved it back to open). The same due time never wakes her twice; a new due time she sets is a new wake.
- **Her daily review.** Once a day, at a random moment inside the hours she usually speaks in: her own lines of the last `innerLife.review.historyDays` (14) days in the record, counted by hour of her timezone (`bot.timezone`), and one hour drawn with that weight, then a minute in it (every hour alike when the record holds none of her lines). Drawn at the first tick of each local day, never in an hour already past, and kept in the state, so a restart keeps it. A day that ends before its review ran is journalled as missed.

Each item becomes an `inner.wake` event through the core's event door (`src/interface/door.js`), with an id that names it (the intention and its due time, the errand, the review's day), so listing the same item again changes nothing. There are no quiet hours by design: she knows the time and the people's rhythms herself.

## When she wakes

- **People first.** A wake waits while a turn holds the one attention (`mention.oneAtATime`) or a direct ping waits in the queue, keeping its due time.
- **Coalescing.** Wakes of the same conversation (an intention's destination, else the conversation it was set in) run as one inner turn; the day's review joins any server one. Wakes elsewhere wait for their own turn.
- **Stale and overflow.** A wake whose intentions were closed meanwhile (done, cancelled, expired) is dropped as stale. At most `innerLife.queueMax` (20) wakes wait; one more is journalled as an overflow and not queued.
- **Where.** The intention's conversation, if the persona can write there (a private chat only with `features.privateMessages` on); a review runs in the channel she was last active in. None usable: the wakes are dropped, journalled `no-channel`.

## The inner turn

The same voice, memory prefetch and tools as any turn of hers, with nobody's message in front of her: no message is invented. The request carries:

- `<wake>`: why she is awake (each wake with the intention it concerns), the moment and her timezone, the channels she was recently active in (a review), and what is left of each budget with when it resets: facts, never rules;
- the last `innerLife.chatMessages` (30) messages of the conversation;
- `<retrieved>`: the prefetch, searched with the purposes of the intentions she woke for;
- her `<intentions>` and `<tasks>`, as on every turn;
- the task `prompts/inner.md`.

What she writes outside a call reaches nobody (counted in the journal as `stray`). She may call her tools (`web.search`, `web.read`, `memory.search`, `intent.*`, `task.run`, ...), post through an explicit `message.create` call to a channel she can write in, or end silent: an answer with no action is the outcome `skip` with the reason `nothing-to-do`. The tool loop continues under `task.continueInner` / `task.continueInnerLast`. Her calls are her own initiative: nobody asked, so her grants alone decide (the gateway's `ownInitiative`, and the operation runs without a requester's right).

**Shadow mode** (`innerLife.mode: "shadow"`, the default): a read (`web.search`, `web.read`, `memory.search`, `intent.list`, any read) runs; every other call is proposed and never runs: journalled with `shadow: true` and only its `proposed` line, no call mark on her transcript, nothing marked seen. A stretch of shadow shows what she would have done.

**Live mode** (`"live"`): her calls run through the gateway. Right before each action the kill switch is asked again; a public post past `innerLife.caps.publicPostsPerDay` is refused (`inner-post-cap`).

**The day's dollars, inside the turn** (either mode): before each of her calls and each further step of the tool loop the scheduler is asked whether the day's dollars still allow it: what was really reported spent today, what other running turns hold reserved, what this turn has really cost so far, and one more request as costly as its costliest so far, within `innerLife.caps.usdPerDay`. Once not, every further call is refused (`inner-usd-cap`, a read too) and the loop makes no further request.

A call that does not work (refused by the resolution or the gateway, in either mode) comes back to her in the next step of the loop with the reason on its mark, as on any turn; an argument the skill does not take names the ones it does (`labels.skills.refusals.unknownArg`), so she can correct the call within the turn. In shadow mode that mark lives only for the rest of the turn: nothing of a shadow turn is marked on her transcript for later turns.

## What she found goes to her memory

Memory is built from chat batches by the memory analyzer ([Messages and memory](messages-and-memory.md#analyzer)); what she reads on her own in an inner turn joins that same path, with no request or model role of its own. When an inner turn ends and at least one of her reads returned something, the turn hands an episode to the analyzer's buffer: lines of hers, in the first person, worded only by `labels.memory.inner`:

- one line with the end of her thinking (her `<think>` of every step, the last `innerLife.memory.thinkChars` characters), the calls she made that ran (`done`) and the ones that were only proposed or were refused (`notDone`);
- one line per read whose skill is in `innerLife.memory.skills` (by default `web.search`, `web.read`, `memory.search`, and `task.status` / `task.list`, which carry her errands' results), at most `innerLife.memory.maxFindings`: the skill, what she asked (the query, the url, the question), what it returned cut to `innerLife.memory.resultChars`, and the links in it (`innerLife.memory.maxSources`) as its sources.

Each line is marked with its provenance `inner` (the turn id, whether the turn was shadow, its sources): her own experience, not something a person said. Where it belongs decides where it goes: an inner turn in a server channel buffers it with that server's lines; one in a private chat (a private intention's conversation) buffers it in that member's private buffer only, so it lands in that member's private layer and never in the server's memory; a private chat whose member is unknown buffers nothing. The next analyzer batch reads the lines like any line of hers (self facts, lore, recent notes, and with `features.intentions` an intention candidate she must still accept). The record keeps chat only, so the lines never reach it; nor do they count as anyone being addressed, nor reach an errand's context.

**Shadow turns count.** A shadow turn's reads really ran, so what they found is a fact of her day and enters her memory the same way, marked `shadow` on the buffered lines (the analyzer's journal record names them by their `inner:<turnId>:<n>` ids). What a shadow turn only proposed is no fact: it is listed as not done, never as done. `innerLife.memory.enabled: false` turns the episodes off; the memory pause (`/nep pause`) buffers none. The log line `memory: inner episode buffered` carries counts only.

## Bounds

Code enforces them; she reads what is left as facts in `<wake>`. Defaults (a ceiling, the owner's word):

| Cap | Default | Counted |
|---|---|---|
| `caps.perDay` | 24 | inner turns per local day |
| `caps.perHour` | 4 | inner turns per rolling hour |
| `caps.perChain` | 3 | inner turns per causal chain: an intention's `chain`, else the intention; a review is its day's chain |
| `caps.usdPerDay` | 4 | dollars per local day, as reported: a reservation held while a turn runs (`innerLife.estimatedTurnUsd`, or what the costliest inner turn of the last two days really cost when that was more), replaced when it ends by what its requests really cost (every `llm: usage` and `images: generated` line logged inside it: the voice and its helpers), plus the errands it handed off when they end. A turn starts only when the real spend, the reservations held and its own reservation fit under the cap |
| `caps.publicPostsPerDay` | 2 | posts in server channels per local day (live mode) |

Over a cap no turn runs and the refusal is journalled once per wake; a turn that reaches the dollar cap while it runs stops calling and asking (see the inner turn above). A spent chain's wakes are dropped; the other caps reset, and the wakes wait for it. A turn counts once whatever its tool steps; its cost counts in full.

## The kill switch

`/nep task inner action:stop` ([owner commands](owner-commands.md)): stopped, kept across restarts; every queued wake is dropped and journalled; an inner turn already running has every further action refused right before it would happen (`inner-stopped`). `action:start` releases it, `action:status` shows the switch, the mode, the queue, the day's review and the caps used. The persona can never stop or start it herself, nor change `features.innerLife` or `innerLife.*`.

## State and journal

`data/guilds/<id>/inner.json`: the queue, the handled wake ids and the chains' counts (30 days, longer than an intention lives), the day's review, the turns, spend and posts of the last two days, the stop. Written whole after every change; ticks missed while the bot was down coalesce into the first one after it.

With `features.journal` on, `inner` records (`/nep memory journal kind:inner`): `wake` (its kind, reason, due time, intentions, chain), `turn` (the outcome and reason, shadow or not, the coalesced wakes, every action with `proposed`, `executed` or `refused` and its code, the stray output, the cost), `capped` (which cap), `overflow`, `stale`, `no-channel`, `review-drawn`, `review-missed`, `errand-cost`, `stopped`, `started`. The inner turn itself is a turn of the journal with mode `inner` and trigger kind `inner`. Ids, codes, counts and costs only.

## Checking it before going live

`tools/replay.mjs --inner <intention_due|errand_deadline|review> [--intention <id> | --review]` builds and runs one inner turn against the live data, read only and in shadow: nothing is posted, nothing is written; it prints the request's blocks and the actions she proposed.

## Testing it over a week

`tools/inner-week.mjs` plays whole virtual weeks against the production scheduler and intention service, in a temporary data directory, with a fake clock that jumps from one moment that matters to the next (an event of the week, a due time, a wait deadline, an expiry, the day's review, a local midnight, the end of people's turns, a cap's reset), always onto the scheduler's tick grid. A fixture (`tools/fixtures/inner-week/*.json`) scripts the week: people's messages by time and channel (one addressed to her holds the one attention for `turnSeconds`), floods of them, her own lines (each with what her ordinary turn `read` or `seen` before it, which the line's note of where it came from records, as the turn runner does live: [Intentions](intentions.md#where-a-candidates-words-came-from)), intentions she sets (with due times, chains, waits on errands), errands that end and what they cost, analyzer candidates, planted text with a marker only it carries, a restart, the kill switch. The scheduler reads no presence, so a fixture has none.

The inner turns are answered by a stub voice: canned actions per wake kind (or per intention), picked by how often the same thing woke her before, so a run is deterministic and costs nothing. Its answer is reported as one request before its calls and the tool loop's step as one more after them (unless the day's dollars are spent by then), each at the fixture's `stub.usdPerRequest`. Its calls pass the same gate an inner turn's do (the day's dollars; a read runs; shadow proposes the rest; live asks the kill switch and the public-post cap right before each call) and act on the week: her intentions through the real service (an `intent.update` as an inner turn's call, in the wake's chain), an errand into the week's own list, a post into the week's chat. A read may carry what it `returns` (and the planted `marker` in it): that text goes into her memory buffer as a line of her inner-turn episode, where the analyzer events of the week find it. The fixtures cover an empty week, ordinary talk, promises kept and forgotten (and one for a channel she cannot write in), a stalled errand, a restart mid-week with the kill switch, a chat flood with an overflowing queue, self-rescheduling with the chain, dollar and hourly caps, turns costlier than the estimate, and planted text: in the chat, in a page she reads, in a memory-search result, in an errand's output, and laundered through her own summaries (a page she read, a retrieved memory she repeats). Each planted fixture has her review accept every candidate it sees, and a genuine promise of hers beside the planted goal as the positive control.

Each run reports every wake, every inner turn (its wakes coalesced, outcome, actions proposed, executed or refused, cost), the cap refusals and drops, the disposition of every due item, each intention's history, the counts and spend per day, and these gates:

| Gate | Passes when |
|---|---|
| `caps` | No cap broken, recounted from the turns (not read from the scheduler's own counters) |
| `unauthorized` | No call other than a read ran in shadow mode or while the kill switch was on |
| `dispositions` | Every due item has a recorded disposition: a turn, a drop (stale, overflow, no channel, chain cap, stopped, superseded), a missed review, still queued after a cap refusal or for less than 6 hours, or its intention closed first |
| `requests-per-day` | At most `innerLife.caps.perDay` inner turns in any local day (the spec's autonomous voice requests a day; the voice requests the turns made are reported beside it, for information) |
| `silent-week` | (a fixture marked silent) at most one inner turn a day and no post |
| `planted` | No intention that became active, and no action, carries a planted marker |
| `fixture` | The week did what the fixture is for (the cap refusals, journal events, kept promises, planted markers and accepted candidates it expects) |

`--live --days <n,...> --channel <id> --spend <usd>` runs one fixture again with the real voice on the chosen days (the stub on the others), in shadow: wired as `replay.mjs --inner`, her memory read from the data directory and never written, the scripted chat as the turn's history in the real channel named, nothing posted. A stub pass of the same week gives the spend gate its estimate (the inner turns on those days, up to 4 requests each); once the reported cost would pass `--spend`, the stub takes the rest. See [tools/README.md](../tools/README.md).

## Not yet

The spontaneous timers and the diary planner run beside it; they are retired later, each after a shadow comparison.
