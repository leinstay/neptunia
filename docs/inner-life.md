# Inner life

The persona can take a turn without an incoming message. Heartbeat, attention, review and intentions provide reasons to wake; the model decides what to do with them.

## Wakes

Heartbeat supplies an opportunity to notice ongoing life and decide whether to act. Attention concerns a person or conversation worth revisiting. A review collects pending matters. These wakes pass through the same turn machinery as a conversation and can result in silence.

State belongs to one persona. Individual records carry their place and audience, so a thought about one server does not create another independent persona for that server. The scheduler and its queues are in [src/behavior/inner/](../src/behavior/inner/).

## Intentions

An intention records something the persona wants to do, where it belongs and any schedule or waiting condition. Ordinary intentions can expire. Standing recurring intentions persist until cancelled. Their schedule determines opportunities to consider the work; it does not force a particular outward action.

Missed occurrences are skipped. Interrupted sends are not replayed automatically after downtime. A saved unfinished record can appear as context in a fresh turn, and the persona can continue it or leave it alone.

Use the `intentions`, `wakes` and `heartbeat` sections of [configuration](configuration.md) for limits, and `neptunia service <name> setup` from [the CLI](cli.md#scheduled-services) for the schedules of `heartbeat`, `selfreflection` and `selfimprovement`. [src/intentions/service.ts](../src/intentions/service.ts) applies intention changes and recurrence.

## Development is a separate schedule

The self-improvement wake is a persona turn on `selfimprovement.schedule`, by default daily at 03:00 UTC. The [development executor](selfimprovement.md) processes approved work every six hours when its timer is enabled. Changing the executor timer does not change heartbeat or the wake.

## Missed and changed schedules

All three wakes run in the core's one scheduler, each with its own policy after a downtime. The heartbeat keeps its next moment in its state, gives one wake when that moment has passed, and draws the next one from then. `heartbeat.schedule` as an interval is moved by `heartbeat.jitterMinutes`, and daily times stay exact. A moment ahead that a changed schedule no longer holds is drawn again at the next tick.

The self-improvement wake counts from its last wake. However many slots passed, it gives one wake, for the newest slot, and a clock set back fires no slot twice. A changed schedule starts the count again, so a slot of the new schedule that already passed owes nothing.

Selfreflection plans one day at a time. With no `selfreflection.schedule` it draws from `selfreflection.windows`, with quiet days and a minimum gap. Setting a schedule replaces the windows and has no quiet day: daily times are exact in UTC, and an interval is laid from the start of the UTC day. A change moves the slots ahead of the current day's plan and keeps what already ran. Slots missed past the grace are dropped together, so a downtime never comes back as a row of posts.
