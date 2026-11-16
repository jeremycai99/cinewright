/** Who sends a patch (M1 convention 10). In v0.1 the caller asserts it (D41). */
export type Author =
  | { kind: "user" }
  | { kind: "agent"; role: string }
  | { kind: "job"; name: string }
  | { kind: "session" };
