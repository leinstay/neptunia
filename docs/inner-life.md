# Inner life

The persona can take a turn without an incoming message. Heartbeat, selfimprovement, attention, review and intentions provide reasons to wake; the model decides what to do with them.

## Wakes

Heartbeat supplies an opportunity to notice ongoing life and decide whether to act. Attention concerns a person or conversation worth revisiting. A review collects pending matters. These wakes pass through the same turn machinery as a conversation and can result in silence.

State belongs to one persona. Individual records carry their place and audience, so a thought about one server does not create another independent persona for that server. The scheduler and its queues are in [src/behavior/inner/](../src/behavior/inner/).

## Intentions

An intention records something the persona wants to do, where it belongs and any schedule or waiting condition. Ordinary intentions can expire. Standing recurring intentions persist until cancelled. Their schedule determines opportunities to consider the work; it does not force a particular outward action.

Missed occurrences are skipped. Interrupted sends are not replayed automatically after downtime. A saved unfinished record can appear as context in a fresh turn, and the persona can continue it or leave it alone.

Use the `intentions`, `wakes` and `heartbeat` sections of [configuration](configuration.md) for limits, and `neptunia service <name> setup` from [the CLI](cli.md#scheduled-services) for the schedules of `heartbeat`, `selfreflection` and `selfimprovement`. [src/intentions/service.ts](../src/intentions/service.ts) applies intention changes and recurrence.

## Heartbeat and selfimprovement

Heartbeat and selfimprovement are separate wakes with separate prompts, schedules and switches. Each one wakes the persona with her character and memory, without the chat of the channel the turn is anchored on. [src/tools/wake-tools.ts](../src/tools/wake-tools.ts) holds what each accepts, and the model is offered the same set.

A heartbeat runs on `heartbeat.schedule` with `prompts/heartbeat.md`. It may read memory and conversations, and it ends when one intention change goes through or she answers `<skip/>`. A call outside that set is refused with `heartbeat-only`. Filing a task, skills and diary writing have no route here, and a heartbeat neither shows nor marks a merged change.

A selfimprovement wake runs on `selfimprovement.schedule`, by default daily at 03:00 UTC, and early when one chain shape fails `selfimprovement.failuresPerShape` times in a UTC day. Its prompt is `prompts/selfimprovement.md`. Its `<wake>` carries her chain shapes, the needs she repeated, her failed calls by tool and code and her skills. It also lists her tasks, why a blocked one waits, and what came back on them since the last wake. It accepts the same reads, `board.status`, `board.answer`, `board.comment`, `board.cancel` and one `board.propose`. Answers on older tasks leave the wake open. A filed task ends it, and so does `<skip/>`. A call outside the set, and a second filing, are refused with `selfimprovement-only`, as is a task answer on any other turn.

Neither wake starts an agent. A filed task starts the [development worker](selfimprovement.md) by itself, at the board's next event. No random draw or count decides whether she files anything.

A restarted wake does not repeat its decision. A heartbeat's `intention.set` and a selfimprovement wake's `board.propose` carry a key built from the wake's `chainId`, and a repeated call answers with what the first one made. Any other `intention.set` of hers is keyed by its turn and its place in that turn.

Results of her tasks reach her once, in the selfimprovement wake. [src/behavior/inner/selfimprovement.ts](../src/behavior/inner/selfimprovement.ts) marks exactly the outbox rows the wake showed once its turn committed, so a turn that failed shows them again and a row that arrived during the read stays for the next wake. `lastAt` moves to the moment the view was read, so a question made after the wake fell due shows in that wake alone.

## Missed and changed schedules

All three wakes run in the core's one scheduler, each with its own policy after a downtime. When a selfimprovement wake and a heartbeat are queued together, the selfimprovement wake runs first and the heartbeat at the next tick. The heartbeat keeps its next moment in its state, gives one wake when that moment has passed, and draws the next one from then. `heartbeat.schedule` as an interval is moved by `heartbeat.jitterMinutes`, and daily times stay exact. A moment ahead that a changed schedule no longer holds is drawn again at the next tick.

The selfimprovement wake counts from its last wake. However many slots passed, it gives one wake, for the newest slot, and a clock set back fires no slot twice. A changed schedule starts the count again, so a slot of the new schedule that already passed owes nothing.

Selfreflection plans one day at a time. With no `selfreflection.schedule` it draws from `selfreflection.windows`, with quiet days and a minimum gap. Setting a schedule replaces the windows and has no quiet day: daily times are exact in UTC, and an interval is laid from the start of the UTC day. A change moves the slots ahead of the current day's plan and keeps what already ran. Slots missed past the grace are dropped together, so a downtime never comes back as a row of posts.
