// The setup of the Discord interface: the token into its environment file, the intents check, the invite link, the
// guild and the owner's id. It runs as `neptunia interface setup discord`, which the `neptunia` CLI brings. Until the
// CLI has that command, `setup` refuses and names the chat command that writes the token.

/** Refuses and names the chat command that saves the token: the setup command comes with the `neptunia` CLI. */
export function setup(): Promise<never> {
  return Promise.reject(
    new Error(
      'the Discord setup comes with the neptunia CLI; save the bot token with "interface token set discord" in the chat, then "interface enable discord"'
    )
  );
}
