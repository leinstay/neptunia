# cli

The interactive presentation of the `neptunia` chat, built with Ink and written with `React.createElement`, so nothing is built. `bin/neptunia.ts` calls `runInteractive` in a terminal. Without a terminal, `-p` and piped input stay in `bin/` with no animation and no control sequences.

`state.ts` and `galaxy.ts` are pure and hold the behaviour: the input, its history, the slash menu, folding and the status line. `app.ts` draws them. The package imports nothing of the engine: the commands, the link to the core and the status come in through `ChatEnv`.

Enter sends, Alt+Enter or Ctrl+J adds a line, Up and Down walk the history or the menu, Tab completes a command, Esc cancels, Ctrl+O shows folded answers, and Ctrl+C leaves. `NEPTUNIA_REDUCED_MOTION=1`, `TERM=dumb` or `NO_COLOR` stills the galaxy.
