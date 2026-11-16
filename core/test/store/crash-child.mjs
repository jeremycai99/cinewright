// Applies one multi-file patch in a child process; the store exits at the journal step named by
// CINEWRIGHT_TEST_CRASH_AT (core/src/store/txn.ts). Imports the built package: run `pnpm typecheck` first.
import { Store } from "../../dist/index.js";

const [dir, patchJson] = process.argv.slice(2);
const store = await Store.open(dir, {
  sessionId: "crash-child",
  now: () => "2026-11-13T00:00:00Z",
});
const result = await store.apply(JSON.parse(patchJson));
process.stdout.write(JSON.stringify(result));
