// A question the console asks the owner and waits for: the answer of a command that is not finished. It carries a
// `dialogId`, the `prompt` and, when the answer is one of a list, its `choices` (free text stays allowed). The owner's
// chat answers by running the same command again with the `dialogId` and the `answer`. This type is the whole of the
// shape here: the console and the chat take it over from the key store's own `ask` status (src/keys/) when both exist.

/** The part of a command's answer that asks. */
export type Ask = { dialogId: string; prompt: string; choices?: Array<string> };

/** The answer of a command that asks: status `ask`, the prompt as its text. */
export type AskAnswer = { text: string; status: 'ask' } & Ask;

/** `ask` as an answer. */
export const askAnswer = (ask: Ask): AskAnswer => ({ ...ask, text: ask.prompt, status: 'ask' });
