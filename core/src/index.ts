export {
  audioId,
  audioKey,
  findLine,
  lexiconUsed,
  lineTakes,
  type MusicAsk,
  musicAsk,
  projectSampleRate,
  scriptLines,
  selectedTake,
  speakerOf,
  TakeError,
  takeId,
  takeKey,
  takeSeed,
} from "./audio/select.js";
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
export { type CasRemote, CasRemoteError, httpRemote, remotesFromEnv } from "./cas/remote.js";
export {
  CascadeError,
  isByAspect,
  type Origin,
  type OverrideLayer,
  type Resolved,
  type ResolvedField,
  type ResolvedToken,
  resolveEntity,
  resolvePackTokens,
  type TokenTree,
  tokenLayers,
} from "./cascade/resolve.js";
export {
  Catalog,
  type CatalogEntry,
  CatalogError,
  type CatalogIssue,
  type ComponentExample,
  catalogErrors,
  loadCatalog,
  loadExamples,
} from "./catalog/catalog.js";
export { CLEARANCE_CRITIC, clearanceFindings } from "./clearance.js";
export {
  type CriticFinding,
  dedupeFindings,
  type Evidence,
  type Finding,
  type FindingFrames,
  finding,
  findingId,
  type OwnerClass,
  RULES,
  sign,
  sortCriticFindings,
  sortFindings,
  validateCriticFinding,
} from "./findings.js";
export type * from "./generated/ir.js";
export { dependencyGraph, dirtyNodes, type Graph } from "./graph/deps.js";
export {
  type RendererInfo,
  type RenderInputs,
  renderKey,
  renderKeyV1,
  unwrap,
} from "./graph/render-key.js";
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
export {
  anchorErrors,
  crossDocumentErrors,
  layoutErrors,
  tokenErrors,
  wrapperErrors,
} from "./ir/semantic.js";
export { type Box, CORE_TEMPLATES, isExtTemplate, regionBox, safeRect } from "./pack/layouts.js";
export {
  loadPack,
  type Pack,
  PackError,
  type PackFont,
  type PackIssue,
  type PackLayouts,
  type PackManifest,
} from "./pack/load.js";
export { resolveProjectPack } from "./pack/pin.js";
export { citation, parseRules, type Rule } from "./pack/rules.js";
export { builtinPacksDir, packSearchPath } from "./pack/search.js";
export {
  type ContrastPair,
  checkResolved,
  contrastPairs,
  contrastRatio,
  cssValue,
  cssVar,
  type EmittedTokens,
  tokenEmit,
  tokenPointer,
  UNSAFE_CSS,
  UnsafeValueError,
} from "./pack/tokens.js";
export {
  checkLiteral,
  isVocabularyPath,
  type TokenSpec,
  type TokenType,
  vocabulary,
} from "./pack/vocabulary.js";
export { commitCacheDir } from "./project/cache.js";
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
export {
  profileRefPath,
  registryProfileNames,
  registryProfilesDir,
  UnknownProfileError,
} from "./registry/profiles.js";
export { describeKind, entitySchemas } from "./schema/describe.js";
export { type DetailedError, normalizeErrors, type ValidationError } from "./schema/errors.js";
export { type JsonObject, loadSchemas, resolveRef, type SchemaSet } from "./schema/load.js";
export {
  type DocumentKind,
  describeSchemaError,
  explainProject,
  type ProjectOptions,
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
  type ApplyOptions,
  type ApplyResult,
  ProjectLoadError,
  replayLog,
  Store,
  type StoreOptions,
  type TaskScope,
} from "./store/store.js";
export { parseTime, TimeError } from "./time.js";
export { resolveAnchor, TimingError } from "./timing/anchor.js";
export { readableWords, type SolvedTiming, solveTiming } from "./timing/solve.js";
export {
  compileSpan,
  layerTiming,
  type Segment,
  type Span,
  segmentsOf,
  shotSpan,
  shotsInOrder,
} from "./timing/span.js";
export { type TimingTable, validateTimingTable } from "./timing/table.js";
export { interpolateWords, lineWords, type TimedWord, type WordTime } from "./timing/words.js";

export const VERSION = "0.0.0";
