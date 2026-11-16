export { collectEntities, type EntityInfo, entityIndex, locate, walkDocument } from "./ir/index.js";
export { wrapperErrors } from "./ir/semantic.js";
export { normalizeErrors, type ValidationError } from "./schema/errors.js";
export { type JsonObject, loadSchemas, resolveRef, type SchemaSet } from "./schema/load.js";
export { type DocumentKind, validateDocument } from "./schema/validate.js";

export const VERSION = "0.0.0";
