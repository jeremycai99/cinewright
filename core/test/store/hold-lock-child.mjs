// Holds the store lock for the given milliseconds (lock tests). Imports the built package.
import { withLock } from "../../dist/index.js";

const [dir, ms] = process.argv.slice(2);
await withLock(dir, 5000, async () => {
  process.stdout.write("locked\n");
  await new Promise((r) => setTimeout(r, Number(ms)));
});
