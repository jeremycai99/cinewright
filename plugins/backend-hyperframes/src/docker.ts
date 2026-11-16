import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import type { RunLimits } from "./limits.js";

export const IMAGE_PLATFORM = "linux/amd64";

export interface Mount {
  source: string;
  target: string;
  readonly: boolean;
}

function csvQuote(field: string): string {
  return `"${field.replace(/"/g, '""')}"`;
}

/**
 * A `--mount` value; CSV quoting keeps commas, spaces and quotes in paths intact. The source is
 * resolved through symlinks (macOS `/var` is `/private/var`, and only the real path is shared
 * with the Docker VM) when it exists.
 */
export function bindMount(mount: Mount): string {
  let source = mount.source;
  try {
    source = realpathSync(source);
  } catch {
    // Not on disk (unit tests): use the path as given.
  }
  return ["type=bind", csvQuote(`source=${source}`), `target=${mount.target}`]
    .concat(mount.readonly ? ["readonly"] : [])
    .join(",");
}

/**
 * The `docker` arguments for one render-container run: network off, the host user, every limit,
 * a read-only root with a tmpfs at /tmp, and the given mounts. Never through a shell.
 */
export function dockerRunArgs(options: {
  image: string;
  name: string;
  mounts: readonly Mount[];
  user?: { uid: number; gid: number };
  limits: RunLimits;
  entrypoint?: string;
  command: readonly string[];
}): string[] {
  const { image, name, mounts, user, limits, entrypoint, command } = options;
  return [
    "run",
    "--rm",
    "--name",
    name,
    "--network",
    "none",
    "--platform",
    IMAGE_PLATFORM,
    ...(user ? ["--user", `${user.uid}:${user.gid}`, "--env", "HOME=/tmp"] : []),
    "--memory",
    `${limits.memoryMb}m`,
    "--memory-swap",
    `${limits.memoryMb}m`,
    "--pids-limit",
    String(limits.pids),
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--read-only",
    "--tmpfs",
    `/tmp:rw,exec,size=${limits.tmpfsMb}m`,
    ...mounts.flatMap((m) => ["--mount", bindMount(m)]),
    ...(entrypoint ? ["--entrypoint", entrypoint] : []),
    image,
    ...command,
  ];
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** Run docker with `args`; past `timeout` ms the named container is killed. */
export function runDocker(
  args: readonly string[],
  name: string,
  timeout: number,
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.on("data", (d) => {
      stdout += d;
    });
    child.stderr.on("data", (d) => {
      stderr += d;
    });
    const timer = setTimeout(() => {
      timedOut = true;
      spawn("docker", ["kill", name], { stdio: "ignore" });
    }, timeout);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr, timedOut });
    });
  });
}
