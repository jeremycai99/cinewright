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
export {
  CascadeError,
  type Origin,
  type Resolved,
  type ResolvedField,
  type ResolvedToken,
  resolveEntity,
  type TokenTree,
} from "./cascade/resolve.js";
export type * from "./generated/ir.js";
export { dependencyGraph, dirtyNodes, type Graph } from "./graph/deps.js";
export { type RenderInputs, renderKey, unwrap } from "./graph/render-key.js";
export {
  collectEntities,
  type EntityInfo,
  entityIndex,
  locate,
  resolveNode,
  walkDocument,
} from "./ir/index.js";
export { type InlinedIr, inlineIr, splitIr } from "./ir/inlined.js";
export {
  INLINED_ROOT,
  type IrEntity,
  indexIr,
  inlinedSchemas,
  isObject,
  resolveTarget,
  type Target,
  wrapperValueSchema,
} from "./ir/paths.js";
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
export { describeKind, entitySchemas } from "./schema/describe.js";
export { type DetailedError, normalizeErrors, type ValidationError } from "./schema/errors.js";
export { type JsonObject, loadSchemas, resolveRef, type SchemaSet } from "./schema/load.js";
export {
  type DocumentKind,
  describeSchemaError,
  explainProject,
  validateDocument,
  validateProject,
} from "./schema/validate.js";
export { applyOps, projectFps } from "./store/apply.js";
export { stateFor } from "./store/author.js";
export { type Conflict, findConflicts } from "./store/conflict.js";
export { LockTimeoutError, withLock } from "./store/lock.js";
export {
  type AppliedEntry,
  type ApproveFailedEntry,
  appendLog,
  type LogEntry,
  type PendingEntry,
  readLog,
} from "./store/log.js";
export { type PatchError, validatePatch } from "./store/patch.js";
export { inScope, type WriteScopes } from "./store/scopes.js";
export {
  type ApplyResult,
  ProjectLoadError,
  replayLog,
  Store,
  type StoreOptions,
} from "./store/store.js";
export { parseTime, TimeError } from "./time.js";

export const VERSION = "0.0.0";
