export { type HashString, sha256Bytes, sha256Hash, toHashForm } from "./canonical/hash.js";
export type * from "./generated/ir.js";
export { collectEntities, type EntityInfo, entityIndex, locate, walkDocument } from "./ir/index.js";
export { type InlinedIr, inlineIr, splitIr } from "./ir/inlined.js";
export { anchorErrors, crossDocumentErrors, wrapperErrors } from "./ir/semantic.js";
export { normalizeErrors, type ValidationError } from "./schema/errors.js";
export { type JsonObject, loadSchemas, resolveRef, type SchemaSet } from "./schema/load.js";
export { type DocumentKind, validateDocument, validateProject } from "./schema/validate.js";

export const VERSION = "0.0.0";
