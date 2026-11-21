import { type ChildProcessWithoutNullStreams, spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  CONTAINER_START_TIMEOUT_MS,
  CONTAINER_WORK_DIR,
  containerCommand,
  DEFAULT_SDK_DIR,
  resolveContainerImage,
} from "./container.js";
import { type PluginError, pluginError } from "./errors.js";
import { DEFAULT_LIMITS } from "./limits.js";
import { setSubprocessFactory } from "./loader.js";
import type { PluginManifest } from "./manifest.js";
import type { Plugin, PluginContext, PluginRequest, PluginResponse } from "./plugin.js";
import { RpcClient } from "./rpc.js";
import { StderrTail } from "./stderr.js";

const HEALTH_TIMEOUT_MS = 5000;
const CANCEL_GRACE_MS = 1000;
const STOP_STEP_MS = 2000;
/** stdout and stderr are separate pipes: give a failed call's stderr a moment to arrive. */
const STDERR_SETTLE_MS = 100;

/** Every child this process started, so none outlives it (M1.8b). */
const children = new Set<ChildProcessWithoutNullStreams>();
/** Every container this process started (G14): killing the docker CLI does not stop them. */
const containers = new Set<string>();
let hooked = false;

function killContainer(name: string): void {
  spawnSync("docker", ["kill", name], { stdio: "ignore", timeout: 30_000 });
  containers.delete(name);
}

function killAll(): void {
  for (const child of children) child.kill("SIGKILL");
  children.clear();
  for (const name of [...containers]) killContainer(name);
}

function hookExit(): void {
  if (hooked) return;
  hooked = true;
  process.on("exit", killAll);
  for (const [signal, code] of [
    ["SIGINT", 130],
    ["SIGTERM", 143],
  ] as const) {
    process.once(signal, () => {
      killAll();
      process.exit(code);
    });
  }
}

/** Where a host-side subprocess plugin's container settings come from (tests override them). */
export interface SubprocessOptions {
  /** The image reference; default `resolveContainerImage(runtime.container.image)`. */
  image?: string;
  sdkDir?: string;
}

/**
 * A plugin in a child process speaking JSON-RPC 2.0 on stdio (D32, M1.8b). Python and GPL
 * plugins run this way. A call that outlives its timeout is cancelled, given a second, then the
 * process is killed and the call reports `timeout`.
 *
 * A manifest with `runtime.container` runs the command in a pinned image (M4): the child is the
 * docker CLI, the container has a unique name, and every stop (timeout, shutdown, host exit)
 * is a `docker kill` of that name, so no container outlives the host (G14).
 */
export class SubprocessPlugin implements Plugin {
  private child: ChildProcessWithoutNullStreams | undefined;
  private rpc: RpcClient | undefined;
  private context: PluginContext = { secrets: {}, callTimeoutMs: 60_000 };
  private stderr: StderrTail = new StderrTail({});
  private ownedWorkDir: string | undefined;
  private name: string | undefined;

  constructor(
    readonly manifest: PluginManifest,
    readonly dir: string,
    private readonly options: SubprocessOptions = {},
  ) {}

  /** The child's pid while it runs. */
  get pid(): number | undefined {
    return this.child?.pid;
  }

  /** The container's name while a containerized plugin runs. */
  get containerName(): string | undefined {
    return this.name;
  }

  /** The work folder files cross the boundary through. */
  get workDir(): string | undefined {
    return this.context.workDir;
  }

  async init(context: PluginContext): Promise<void> {
    const runtime = this.manifest.runtime;
    if (runtime.kind !== "subprocess")
      throw new Error(`${this.manifest.id} is not a subprocess plugin`);
    let workDir = context.workDir;
    if (workDir === undefined) {
      workDir = mkdtempSync(join(tmpdir(), `cinewright-${this.manifest.id}-`));
      this.ownedWorkDir = workDir;
    }
    this.context = { ...context, workDir };
    this.stderr = new StderrTail(context.secrets, undefined, context.onLog);
    // Only what the plugin needs: a PATH and the secrets its manifest declares (D32).
    const env = { PATH: process.env.PATH ?? "", ...context.secrets };
    let child: ChildProcessWithoutNullStreams;
    let pluginWorkDir = workDir;
    if (runtime.container) {
      const name = `cinewright-plugin-${randomUUID()}`;
      const args = containerCommand(this.manifest, workDir, DEFAULT_LIMITS, name, {
        image: this.options.image ?? resolveContainerImage(runtime.container.image),
        pluginDir: resolve(this.dir),
        sdkDir: this.options.sdkDir ?? DEFAULT_SDK_DIR,
        ...(typeof process.getuid === "function" && typeof process.getgid === "function"
          ? { user: { uid: process.getuid(), gid: process.getgid() } }
          : {}),
      });
      // DOCKER_* and HOME let the CLI find its daemon and config; the container gets none of it.
      const dockerEnv = Object.fromEntries(
        Object.entries(process.env).filter(([key]) => key.startsWith("DOCKER_") || key === "HOME"),
      ) as Record<string, string>;
      child = spawn("docker", args, {
        env: { ...dockerEnv, ...env },
        stdio: ["pipe", "pipe", "pipe"],
      });
      this.name = name;
      containers.add(name);
      pluginWorkDir = CONTAINER_WORK_DIR;
    } else {
      const [command, ...args] = runtime.command;
      child = spawn(command as string, args, {
        cwd: resolve(this.dir, runtime.cwd ?? "."),
        env,
        stdio: ["pipe", "pipe", "pipe"],
      });
    }
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => this.stderr.push(chunk));
    // A command that cannot start (ENOENT) emits `error`, not `exit`; unhandled, it would crash
    // the host. It surfaces in the start failure's message instead.
    child.on("error", (error) => this.stderr.push(`${error.message}\n`));
    hookExit();
    children.add(child);
    child.on("exit", () => {
      children.delete(child);
      if (this.name) containers.delete(this.name);
    });
    this.child = child;
    this.rpc = new RpcClient(child);
    const startMs = runtime.container ? CONTAINER_START_TIMEOUT_MS : HEALTH_TIMEOUT_MS;
    try {
      await this.rpc.request("health", null, startMs);
      await this.rpc.request(
        "initialize",
        { secrets: context.secrets, callTimeoutMs: context.callTimeoutMs, workDir: pluginWorkDir },
        HEALTH_TIMEOUT_MS,
      );
    } catch (error) {
      this.kill();
      const tail = this.stderr.text();
      throw new Error(
        `${this.manifest.id} did not start: ${(error as Error).message}${tail ? `\n${tail}` : ""}`,
      );
    }
  }

  /** Stop the process now; a container is killed by name. */
  private kill(): void {
    if (this.name) killContainer(this.name);
    this.child?.kill("SIGKILL");
  }

  /** A failed call's error, with the stderr tail in `data.stderr` (F18). */
  private withStderr(error: PluginError): PluginError {
    const stderr = this.stderr.text();
    if (!stderr) return error;
    const data =
      error.data !== null && typeof error.data === "object" && !Array.isArray(error.data)
        ? { ...(error.data as Record<string, unknown>), stderr }
        : error.data === undefined
          ? { stderr }
          : { detail: error.data, stderr };
    return { ...error, data };
  }

  async capabilities(): Promise<string[]> {
    if (!this.rpc) throw new Error("init() first");
    return (await this.rpc.request("capabilities", null, HEALTH_TIMEOUT_MS)) as string[];
  }

  call(request: PluginRequest, signal: AbortSignal): Promise<PluginResponse> {
    const rpc = this.rpc;
    const child = this.child;
    if (!rpc || !child || !rpc.running) {
      return Promise.resolve({
        ok: false,
        error: pluginError("internal", "the plugin process is not running"),
      });
    }
    const id = rpc.reserveId();
    return new Promise((done) => {
      let settled = false;
      let timedOut = false;
      let grace: NodeJS.Timeout | undefined;
      const finish = (response: PluginResponse) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(grace);
        signal.removeEventListener("abort", onAbort);
        if (response.ok) done(response);
        else
          setTimeout(
            () => done({ ok: false, error: this.withStderr(response.error) }),
            STDERR_SETTLE_MS,
          );
      };
      const onAbort = () => rpc.notify("$/cancel", { id });
      signal.addEventListener("abort", onAbort);
      const timer = setTimeout(() => {
        timedOut = true;
        rpc.notify("$/cancel", { id });
        grace = setTimeout(() => {
          this.kill();
          finish({
            ok: false,
            error: pluginError(
              "timeout",
              `${request.method} did not finish in ${this.context.callTimeoutMs} ms`,
              true,
            ),
          });
        }, CANCEL_GRACE_MS);
      }, this.context.callTimeoutMs);
      rpc.request("call", { request }, undefined, id).then(
        (result) => {
          const response = result as PluginResponse;
          if (timedOut && !response.ok && response.error.code === "cancelled") {
            finish({
              ok: false,
              error: pluginError("timeout", `${request.method} timed out`, true),
            });
          } else finish(response);
        },
        (error: Error) => finish({ ok: false, error: pluginError("internal", error.message) }),
      );
    });
  }

  async shutdown(): Promise<void> {
    try {
      await this.stop();
    } finally {
      if (this.name) killContainer(this.name);
      this.name = undefined;
      if (this.ownedWorkDir) rmSync(this.ownedWorkDir, { recursive: true, force: true });
      this.ownedWorkDir = undefined;
    }
  }

  private async stop(): Promise<void> {
    const child = this.child;
    const rpc = this.rpc;
    if (!child || !rpc) return;
    this.child = undefined;
    this.rpc = undefined;
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise<void>((r) => child.once("exit", () => r()));
    const wait = (ms: number) =>
      Promise.race([
        exited.then(() => true),
        new Promise<boolean>((r) => setTimeout(() => r(false), ms)),
      ]);
    try {
      await rpc.request("shutdown", null, STOP_STEP_MS);
    } catch {
      // A plugin that does not answer is stopped below.
    }
    rpc.notify("exit");
    if (await wait(STOP_STEP_MS)) return;
    if (this.name) killContainer(this.name);
    child.kill("SIGTERM");
    if (await wait(STOP_STEP_MS)) return;
    child.kill("SIGKILL");
    await exited;
  }
}

export function createSubprocessPlugin(
  manifest: PluginManifest,
  dir: string,
  options: SubprocessOptions = {},
): SubprocessPlugin {
  return new SubprocessPlugin(manifest, dir, options);
}

setSubprocessFactory(createSubprocessPlugin);
