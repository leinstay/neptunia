// The chat's semantic colour and weight tokens, the one place a colour is named. A token asks the terminal for an ANSI
// style, and the emulator's palette and font decide how it looks. Every status and selection also carries text or a shape,
// so nothing here is the only sign of anything. The values are this project's own choice, with no capture of
// another program behind them. One red marks the title, the galaxy and the user's lines, so what was typed at the command
// line stands apart from the persona's text. interfaces/cli/chat-view.ts draws with them.

/**
 * The header's title, in the red of the user's lines. The bright red is the one a terminal that draws bold as bright shows for a bold
 * base red, and bold leaves a bright colour as it is, so the title and everything in its colour look alike in any terminal.
 */
const TITLE = { bold: true, color: 'redBright' } as const;

export const THEME = {
  text: {},
  /** the line numbers, the time rows and every other service mark */
  muted: { dimColor: true },
  title: TITLE,
  /** the header's galaxy, in the title's colour */
  mark: { color: TITLE.color },
  /** the user's lines in the chat, and their commands in the command window, in the title's colour */
  owner: { color: TITLE.color },
  /** the rule above the slash menu */
  rule: { color: 'white' },
  activeBorder: { borderColor: 'cyan' },
  inactiveBorder: { borderColor: 'gray' },
  selection: { inverse: true },
  caret: { inverse: true },
  code: { color: 'cyan' },
  quote: { italic: true },
  heading: { bold: true },
  success: { color: 'green' },
  warning: { color: 'yellow' },
  error: { color: 'red' },
} as const;
