/** Exit codes of the `cinewright` CLI; agents rely on them (cli/README.md). */
export const EXIT = {
  /** Done; also "stored as pending" for proposals and session edits. */
  ok: 0,
  internal: 1,
  usage: 2,
  /** An invalid patch or IR: schema, semantic, path, or an op the author may not send. */
  invalid: 3,
  conflict: 4,
  /** Blocked by authorship and stored as a pending suggestion. */
  blocked: 5,
  /** The project failed to load: edited outside the store, corrupt CAS, missing file. */
  load: 6,
  /** The store lock was held by another process until the timeout. */
  lock: 7,
  /** A render failed: its timeout, its memory limit, or render-job itself (M3.2a). */
  render: 8,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];
