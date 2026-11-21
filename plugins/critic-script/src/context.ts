/** What every finding of one deliverable shares. */
export interface ScriptContext {
  critic: { id: string; version: string };
  deliverable: string;
  /** The project's frame rate. */
  fps: { num: number; den: number };
}
