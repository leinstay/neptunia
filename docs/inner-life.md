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

## Bounds

Code enforces them; she reads what is left as facts in `<wake>`. Defaults (a ceiling, the owner's word):

| Cap | Default | Counted |
|---|---|---|
| `caps.perDay` | 24 | inner turns per local day |
| `caps.perHour` | 4 | inner turns per rolling hour |
| `caps.perChain` | 3 | inner turns per causal chain: an intention's `chain`, else the intention; a review is its day's chain |
| `caps.usdPerDay` | 4 | dollars per local day: `innerLife.estimatedTurnUsd` reserved before a turn, then what its requests cost (every `llm: usage` and `images: generated` line logged inside it: the voice and its helpers), plus the errands it handed off when they end |
| `caps.publicPostsPerDay` | 2 | posts in server channels per local day (live mode) |

Over a cap no turn runs and the refusal is journalled once per wake. A spent chain's wakes are dropped; the other caps reset, and the wakes wait for it. A turn counts once whatever its tool steps; its cost counts in full.

## The kill switch

`/nep task inner action:stop` ([owner commands](owner-commands.md)): stopped, kept across restarts; every queued wake is dropped and journalled; an inner turn already running has every further action refused right before it would happen (`inner-stopped`). `action:start` releases it, `action:status` shows the switch, the mode, the queue, the day's review and the caps used. The persona can never stop or start it herself, nor change `features.innerLife` or `innerLife.*`.

## State and journal

`data/guilds/<id>/inner.json`: the queue, the handled wake ids and the chains' counts (30 days, longer than an intention lives), the day's review, the turns, spend and posts of the last two days, the stop. Written whole after every change; ticks missed while the bot was down coalesce into the first one after it.

With `features.journal` on, `inner` records (`/nep memory journal kind:inner`): `wake` (its kind, reason, due time, intentions, chain), `turn` (the outcome and reason, shadow or not, the coalesced wakes, every action with `proposed`, `executed` or `refused` and its code, the stray output, the cost), `capped` (which cap), `overflow`, `stale`, `no-channel`, `review-drawn`, `review-missed`, `errand-cost`, `stopped`, `started`. The inner turn itself is a turn of the journal with mode `inner` and trigger kind `inner`. Ids, codes, counts and costs only.

## Checking it before going live

`tools/replay.mjs --inner <intention_due|errand_deadline|review> [--intention <id> | --review]` builds and runs one inner turn against the live data, read only and in shadow: nothing is posted, nothing is written; it prints the request's blocks and the actions she proposed.

## Testing it over a week

`tools/inner-week.mjs` plays whole virtual weeks against the production scheduler and intention service, in a temporary data directory, with a fake clock that jumps from one moment that matters to the next (an event of the week, a due time, a wait deadline, an expiry, the day's review, a local midnight, the end of people's turns, a cap's reset), always onto the scheduler's tick grid. A fixture (`tools/fixtures/inner-week/*.json`) scripts the week: people's messages by time and channel (one addressed to her holds the one attention for `turnSeconds`), floods of them, her own lines, intentions she sets (with due times, chains, waits on errands), errands that end and what they cost, analyzer candidates, planted text with a marker only it carries, a restart, the kill switch. The scheduler reads no presence, so a fixture has none.

The inner turns are answered by a stub voice: canned actions per wake kind (or per intention), picked by how often the same thing woke her before, so a run is deterministic and costs nothing. Its calls pass the same gate an inner turn's do (a read runs; shadow proposes the rest; live asks the kill switch and the public-post cap right before each call) and act on the week: her intentions through the real service, an errand into the week's own list, a post into the week's chat. The fixtures cover an empty week, ordinary talk, promises kept and forgotten (and one for a channel she cannot write in), a stalled errand, a restart mid-week with the kill switch, a chat flood with an overflowing queue, self-rescheduling with the chain, dollar and hourly caps, and planted text.

Each run reports every wake, every inner turn (its wakes coalesced, outcome, actions proposed, executed or refused, cost), the cap refusals and drops, the disposition of every due item, each intention's history, the counts and spend per day, and these gates:

| Gate | Passes when |
|---|---|
| `caps` | No cap broken, recounted from the turns (not read from the scheduler's own counters) |
| `unauthorized` | No call other than a read ran in shadow mode or while the kill switch was on |
| `dispositions` | Every due item has a recorded disposition: a turn, a drop (stale, overflow, no channel, chain cap, stopped, superseded), a missed review, still queued after a cap refusal or for less than 6 hours, or its intention closed first |
| `requests-per-day` | At most 24 voice requests in any local day |
| `silent-week` | (a fixture marked silent) at most one inner turn a day and no post |
| `planted` | No intention that became active, and no action, carries a planted marker |
| `fixture` | The week did what the fixture is for (the cap refusals, journal events and kept promises it expects) |

`--live --days <n,...> --channel <id> --spend <usd>` runs one fixture again with the real voice on the chosen days (the stub on the others), in shadow: wired as `replay.mjs --inner`, her memory read from the data directory and never written, the scripted chat as the turn's history in the real channel named, nothing posted. A stub pass of the same week gives the spend gate its estimate (the inner turns on those days, up to 4 requests each); once the reported cost would pass `--spend`, the stub takes the rest. See [tools/README.md](../tools/README.md).

## Not yet

The spontaneous timers and the diary planner run beside it; they are retired later, each after a shadow comparison. Inner-turn findings do not yet reach the memory analyzer (memory is built from chat).
