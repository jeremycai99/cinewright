import { fileURLToPath } from "node:url";

/** The component folders (each with component.json, props.schema.json, examples.json, index.ts). */
export const catalogDir = fileURLToPath(new URL("../src/", import.meta.url));
