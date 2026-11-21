import { readFileSync } from "node:fs";

const manifest = JSON.parse(readFileSync(new URL("../manifest.json", import.meta.url), "utf8")) as {
  id: string;
  version: string;
};

/** This critic's id and version, from its manifest: part of every baseline (D36). */
export const CRITIC = { id: manifest.id, version: manifest.version } as const;
