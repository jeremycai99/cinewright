import { main } from "../src/main.js";

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run the CLI in process with captured output. */
export async function run(argv: string[], env: Record<string, string> = {}): Promise<RunResult> {
  let stdout = "";
  let stderr = "";
  const code = await main(argv, {
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
    env: { CINEWRIGHT_SESSION_ID: "test-session", ...env },
    cwd: process.cwd(),
  });
  return { code, stdout, stderr };
}
