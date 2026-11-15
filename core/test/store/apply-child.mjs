// Applies one patch from a separate process (concurrency tests). Imports the built package:
// run `pnpm typecheck` first. Waits until the file named by START exists, so two children race.
import { existsSync } from "node:fs";
import { Store } from "../../dist/index.js";

const [dir, patchJson, start] = process.argv.slice(2);
while (start && !existsSync(start)) await new Promise((r) => setTimeout(r, 5));
const store = await Store.open(dir, {
  sessionId: `child-${process.pid}`,
  now: () => "2026-11-13T00:00:00Z",
});
const result = await store.apply(JSON.parse(patchJson));
process.stdout.write(JSON.stringify(result));
