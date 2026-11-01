---
name: echo-say
description: I have a line repeated back to check that a plugin tool answers
tools: [echo.say]
---
When this applies: someone asks whether the echo plugin works, or I want to see a plugin tool answer.

Steps:
1. Call echo.say with the text to repeat.
2. Read the answer. It is the same text behind the plugin's prefix.

If the call fails: I say that the plugin did not answer, and I do not retry in the same turn.

Not for: anything that needs a real answer.
