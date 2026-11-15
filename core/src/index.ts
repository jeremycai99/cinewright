export {
  type HashString,
  sha256Bytes,
  sha256Hash,
  stateHash,
  toHashForm,
} from "./canonical/hash.js";
export { toStoredForm } from "./canonical/stored.js";
export {
  AssetMissingError,
  Cas,
  CasCorruptError,
  CasMissingError,
  resolveAsset,
} from "./cas/cas.js";
export type * from "./generated/ir.js";
export { collectEntities, type EntityInfo, entityIndex, locate, walkDocument } from "./ir/index.js";
export { type InlinedIr, inlineIr, splitIr } from "./ir/inlined.js";
export { anchorErrors, crossDocumentErrors, wrapperErrors } from "./ir/semantic.js";
export {
  ProjectFilesError,
  projectFileContents,
  readProjectFiles,
  writeProjectFiles,
} from "./project/files.js";
export {
  InitError,
  type InitInput,
  type InitOptions,
  type InitResult,
  initProject,
} from "./project/init.js";
export * from "./project/layout.js";
export { normalizeErrors, type ValidationError } from "./schema/errors.js";
export { type JsonObject, loadSchemas, resolveRef, type SchemaSet } from "./schema/load.js";
export { type DocumentKind, validateDocument, validateProject } from "./schema/validate.js";

export type { Author } from "./store/author.js";
export { appendLog, type InitEntry, type LogEntry, readLog } from "./store/log.js";
export { parseTime, TimeError } from "./time.js";

export const VERSION = "0.0.0";
