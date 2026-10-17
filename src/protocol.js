// The one place the engine imports the protocol package (packages/protocol/, @neptunia/protocol)
// from. It is reached by a relative path for now: npm workspaces would link it into
// node_modules as `@neptunia/protocol`, but declaring the workspace needs a lockfile update
// (`npm ci` refuses a package.json and package-lock.json out of step), so the switch waits for
// the change that runs `npm install`. Then this line becomes `export * from '@neptunia/protocol';`
// and no importer changes.

export * from '../packages/protocol/index.js';
