# Inner life

The persona can take a turn without an incoming message. Heartbeat, attention, review and intentions provide reasons to wake; the model decides what to do with them.

## Wakes

Heartbeat supplies an opportunity to notice ongoing life and decide whether to act. Attention concerns a person or conversation worth revisiting. A review collects pending matters. These wakes pass through the same turn machinery as a conversation and can result in silence.

State belongs to one persona. Individual records carry their place and audience, so a thought about one server does not create another independent persona for that server. The scheduler and its queues are in [src/behavior/inner/](../src/behavior/inner/).

## Intentions

An intention records something the persona wants to do, where it belongs and any schedule or waiting condition. Ordinary intentions can expire. Standing recurring intentions persist until cancelled. Their schedule determines opportunities to consider the work; it does not force a particular outward action.

Missed occurrences are skipped. Interrupted sends are not replayed automatically after downtime. A saved unfinished record can appear as context in a fresh turn, and the persona can continue it or leave it alone.

Use the `intentions`, `wakes` and `heartbeat` sections of [configuration](configuration.md) for schedules and limits. [src/intentions/service.ts](../src/intentions/service.ts) applies intention changes and recurrence.

## Development is a separate schedule

The daily self-improvement wake is a persona turn. The [development executor](selfimprovement.md) processes approved work every six hours when its timer is enabled. Changing the executor timer does not change heartbeat or the daily wake.
