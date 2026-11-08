# Interactive CLI

This workspace draws the owner chat and setup questions with Ink and React, using `createElement` so Node runs it without a build step. The entry point supplies the core connection and command handlers. This package imports no engine modules.

`app.ts` and `chat-view.ts` draw the chat, rotating ASCII galaxy, status and command menu, and `chat-controller.ts` holds what each key does to the draft and the transcript. `panel-view.ts` handles tabs, search, row selection and value editing. `question.ts` draws installation questions. `state.ts` holds input and status formatting. The public keyboard controls and commands are in [the CLI guide](../docs/cli.md).

Panel actions are provided by `bin/chat-panels.ts` and call the existing core commands. Displaying a panel never probes a provider. A credential dialog masks input and saves no secret in history. `NEPTUNIA_REDUCED_MOTION=1` disables the galaxy animation, and `NEPTUNIA_PLAIN_CHAT=1` selects the plain chat.
