// The setup of the Discord interface: the token into its environment file, the intents check, the invite link, the
// guild and the owner's id. It runs as `neptunia interface setup discord`, which the `neptunia` CLI brings. Until the
// CLI has that command, `setup` refuses and names the manual steps of deploy/README.md.

/** Refuses with the manual steps: the setup command comes with the `neptunia` CLI. */
export function setup(): Promise<never> {
  return Promise.reject(
    new Error(
      'the Discord setup comes with the neptunia CLI; follow "Running the interfaces as units" in deploy/README.md'
    )
  );
}
