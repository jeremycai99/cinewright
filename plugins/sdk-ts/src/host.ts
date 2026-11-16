import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { resolve } from "node:path";
import { pluginError } from "./errors.js";
import { setSubprocessFactory } from "./loader.js";
import type { PluginManifest } from "./manifest.js";
import type { Plugin, PluginContext, PluginRequest, PluginResponse } from "./plugin.js";
import { RpcClient } from "./rpc.js";

const HEALTH_TIMEOUT_MS = 5000;
const CANCEL_GRACE_MS = 1000;
const STOP_STEP_MS = 2000;

/** Every child this process started, so none outlives it (M1.8b). */
const children = new Set<ChildProcessWithoutNullStreams>();
let hooked = false;

function killAll(): void {
  for (const child of children) child.kill("SIGKILL");
  children.clear();
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

/**
 * A plugin in a child process speaking JSON-RPC 2.0 on stdio (D32, M1.8b). Python and GPL
 * plugins run this way. A call that outlives its timeout is cancelled, given a second, then the
 * process is killed and the call reports `timeout`.
 */
export class SubprocessPlugin implements Plugin {
  private child: ChildProcessWithoutNullStreams | undefined;
  private rpc: RpcClient | undefined;
  private context: PluginContext = { secrets: {}, callTimeoutMs: 60_000 };

  constructor(
    readonly manifest: PluginManifest,
    readonly dir: string,
  ) {}

  /** The child's pid while it runs. */
  get pid(): number | undefined {
    return this.child?.pid;
  }

  async init(context: PluginContext): Promise<void> {
    const runtime = this.manifest.runtime;
    if (runtime.kind !== "subprocess")
      throw new Error(`${this.manifest.id} is not a subprocess plugin`);
    this.context = context;
    const [command, ...args] = runtime.command;
    const child = spawn(command as string, args, {
      cwd: resolve(this.dir, runtime.cwd ?? "."),
      // Only what the plugin needs: a PATH and the secrets its manifest declares (D32).
      env: { PATH: process.env.PATH ?? "", ...context.secrets },
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stderr.on("data", () => {});
    hookExit();
    children.add(child);
    child.on("exit", () => children.delete(child));
    this.child = child;
    this.rpc = new RpcClient(child);
    try {
      await this.rpc.request("health", null, HEALTH_TIMEOUT_MS);
      await this.rpc.request(
        "initialize",
        { secrets: context.secrets, callTimeoutMs: context.callTimeoutMs },
        HEALTH_TIMEOUT_MS,
      );
    } catch (error) {
      child.kill("SIGKILL");
      throw new Error(`${this.manifest.id} did not start: ${(error as Error).message}`);
    }
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
        done(response);
      };
      const onAbort = () => rpc.notify("$/cancel", { id });
      signal.addEventListener("abort", onAbort);
      const timer = setTimeout(() => {
        timedOut = true;
        rpc.notify("$/cancel", { id });
        grace = setTimeout(() => {
          child.kill("SIGKILL");
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
    child.kill("SIGTERM");
    if (await wait(STOP_STEP_MS)) return;
    child.kill("SIGKILL");
    await exited;
  }
}

export function createSubprocessPlugin(manifest: PluginManifest, dir: string): SubprocessPlugin {
  return new SubprocessPlugin(manifest, dir);
}

setSubprocessFactory(createSubprocessPlugin);
