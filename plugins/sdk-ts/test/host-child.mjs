// A host process for the cleanup tests: starts the Python stub, prints the plugin's pid (or,
// with a fourth argument "name", its container's name), then either exits without shutting the
// plugin down ("exit") or waits to be killed ("wait").
// Imports the built package: run `pnpm typecheck` first.
import { createSubprocessPlugin } from "../dist/index.js";

const [manifestJson, dir, mode, print] = process.argv.slice(2);
const plugin = createSubprocessPlugin(JSON.parse(manifestJson), dir);
await plugin.init({ secrets: {}, callTimeoutMs: 5000 });
process.stdout.write(`${print === "name" ? plugin.containerName : plugin.pid}\n`);
if (mode === "exit") process.exit(0);
setInterval(() => {}, 1000);
