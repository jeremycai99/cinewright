import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const COMPONENTS = fileURLToPath(new URL("../../", import.meta.url));

/**
 * Bundle the host and every core component into one browser script (an IIFE, unminified, no
 * source map). The working directory is pinned so two builds are byte-identical wherever they run.
 */
export async function bundleRuntime(outfile: string): Promise<void> {
  await build({
    absWorkingDir: COMPONENTS,
    entryPoints: ["src/runtime.ts"],
    bundle: true,
    format: "iife",
    target: "chrome120",
    minify: false,
    sourcemap: false,
    legalComments: "none",
    charset: "utf8",
    logLevel: "silent",
    outfile,
  });
}
