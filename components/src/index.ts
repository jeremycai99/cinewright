import { fileURLToPath } from "node:url";

/** The component folders (each with component.json, props.schema.json, examples.json, index.ts). */
export const catalogDir = fileURLToPath(new URL("../src/", import.meta.url));

export type { Alignment, Box, LayerSpec, MotionEntry, MountSpec, Rational } from "./host/spec.js";
export { bundleRuntime } from "./node/bundle.js";
export { buildSpecimen, type SpecimenItem, type SpecimenResult } from "./node/specimen.js";
