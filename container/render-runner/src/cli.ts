#!/usr/bin/env node
import { reportVersions } from "./versions.js";

async function main(argv: readonly string[]): Promise<number> {
  if (argv.length === 1 && argv[0] === "--versions") {
    console.log(JSON.stringify(await reportVersions()));
    return 0;
  }
  console.error("usage: render-job --versions");
  return 2;
}

process.exitCode = await main(process.argv.slice(2));
