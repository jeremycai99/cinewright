import { defineConfig } from "vitest/config";

// Schema compilation and child processes can exceed the 5 s default under load (audit F6).
export default defineConfig({ test: { testTimeout: 30_000, hookTimeout: 30_000 } });
