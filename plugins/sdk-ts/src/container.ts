import { readFileSync } from "node:fs";
import { join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { dockerRunArgs } from "./docker.js";
import type { RunLimits } from "./limits.js";
import type { PluginManifest } from "./manifest.js";

/** Containerized plugins load models before they answer `health` (M4). */
export const CONTAINER_START_TIMEOUT_MS = 60_000;

/** Where a containerized plugin sees its files. */
export const CONTAINER_WORK_DIR = "/work";
export const CONTAINER_SDK_DIR = "/opt/cinewright/sdk-py";

/** The monorepo root, from this file (src/ or dist/ under plugins/sdk-ts). */
const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

/** The Python SDK the plugin host mounts into containers (plugins/sdk-py/src). */
export const DEFAULT_SDK_DIR = join(REPO_ROOT, "plugins", "sdk-py", "src");

export interface ContainerOptions {
  /** The resolved image reference (see `resolveContainerImage`). */
  image: string;
  /** The plugin's folder on the host, mounted read-only at /plugins/<id>. */
  pluginDir: string;
  /** The Python SDK's source folder on the host, mounted read-only. */
  sdkDir: string;
  user?: { uid: number; gid: number };
}

/**
 * The `docker` arguments that run a containerized subprocess plugin (M4, G14): stdin open, an
 * init process, a unique name the host can `docker kill`, the network off, every run limit,
 * the work folder read-write at /work, the plugin and the SDK read-only, and the offline
 * environment. Secrets are passed by name: docker copies their values from its own
 * environment, so no value is on a command line.
 */
export function containerCommand(
  manifest: PluginManifest,
  workDir: string,
  limits: RunLimits,
  name: string,
  options: ContainerOptions,
): string[] {
  const runtime = manifest.runtime;
  if (runtime.kind !== "subprocess" || !runtime.container) {
    throw new Error(`${manifest.id} is not a containerized subprocess plugin`);
  }
  const pluginTarget = `/plugins/${manifest.id}`;
  return dockerRunArgs({
    image: options.image,
    name,
    interactive: true,
    init: true,
    mounts: [
      { source: workDir, target: CONTAINER_WORK_DIR, readonly: false },
      { source: options.pluginDir, target: pluginTarget, readonly: true },
      { source: options.sdkDir, target: CONTAINER_SDK_DIR, readonly: true },
    ],
    ...(options.user ? { user: options.user } : {}),
    limits,
    env: [
      "HOME=/tmp",
      "XDG_CACHE_HOME=/tmp/cache",
      "HF_HOME=/opt/models/hf",
      "HF_HUB_OFFLINE=1",
      "TRANSFORMERS_OFFLINE=1",
      "TORCH_HOME=/opt/models/torch",
      "NLTK_DATA=/opt/models/nltk_data",
      `PYTHONPATH=${CONTAINER_SDK_DIR}`,
      `CINEWRIGHT_WORK_DIR=${CONTAINER_WORK_DIR}`,
      ...manifest.secrets,
    ],
    workdir: posix.join(pluginTarget, runtime.cwd ?? "."),
    entrypoint: "",
    command: runtime.command,
  });
}

/**
 * The image reference for a logical image name ("audio"): `CINEWRIGHT_<NAME>_IMAGE` if set
 * (a local dev build), else the digest locked in `container/<name>/image.lock.json`.
 */
export function resolveContainerImage(
  name: string,
  options: { env?: Readonly<Record<string, string | undefined>>; repoRoot?: string } = {},
): string {
  const env = options.env ?? process.env;
  const variable = `CINEWRIGHT_${name.toUpperCase().replace(/-/g, "_")}_IMAGE`;
  const override = env[variable];
  if (override) return override;
  const lockPath = join(options.repoRoot ?? REPO_ROOT, "container", name, "image.lock.json");
  let lock: { image?: string; digest?: string | null };
  try {
    lock = JSON.parse(readFileSync(lockPath, "utf8")) as typeof lock;
  } catch (error) {
    throw new Error(`no image lock for "${name}" at ${lockPath}: ${(error as Error).message}`);
  }
  if (!lock.image || !lock.digest) {
    throw new Error(
      `the ${name} image is unpublished: build it (cinewright-build-image --kind ${name} --tag cinewright-${name}:dev) and set ${variable}=cinewright-${name}:dev`,
    );
  }
  return `${lock.image}@${lock.digest}`;
}
