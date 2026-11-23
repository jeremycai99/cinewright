import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { FoundPlugin } from "./plugins/registry.js";

/** One thing `cinewright doctor` looked at. `required` checks decide whether a keyless Manual
 * render can work; the others are reported by name and never fail the run. */
export interface DoctorCheck {
  id: string;
  ok: boolean;
  required: boolean;
  detail: string;
  fix?: string;
}

export interface DoctorReport {
  /** Every required check passed: a keyless Manual render can work here. */
  ok: boolean;
  checks: DoctorCheck[];
}

/** How doctor looks at the machine; tests pass fakes. */
export interface DoctorProbes {
  /** The Docker server version, or null when Docker is not reachable. */
  docker(): Promise<string | null>;
  /** The image is present locally. */
  image(ref: string): Promise<boolean>;
  /** The `python3` version, or null. */
  python(): Promise<string | null>;
  /** The CAS remote answers (any HTTP status counts) or, for `file:`, its folder exists. */
  remote(template: string): Promise<boolean>;
}

export interface DoctorOptions {
  /** The images a render needs, by logical name ("render", "audio"), as locked references. */
  images: { name: string; ref: string }[];
  node: { found: string; wanted: string };
  plugins: FoundPlugin[];
  env: Readonly<Record<string, string | undefined>>;
  /** `CINEWRIGHT_CAS_REMOTE` (comma-separated templates), if set. */
  remote?: string;
  probes?: DoctorProbes;
}

const major = (v: string) => v.replace(/^v/, "").split(".")[0];

/**
 * `cinewright doctor` (M8.5): Docker, the locked images, Node and Python, each plugin's secrets
 * by name, and the CAS remote. `ok` when a keyless Manual render can work: Docker reachable,
 * both images present and Node on the supported major version. Keys and the remote are needed
 * only by agents and tier A fixtures, so they are named but never fail the check.
 */
export async function doctor(options: DoctorOptions): Promise<DoctorReport> {
  const probes = options.probes ?? systemProbes();
  const checks: DoctorCheck[] = [];
  const docker = await probes.docker();
  checks.push(
    docker
      ? { id: "docker", ok: true, required: true, detail: `Docker ${docker}` }
      : {
          id: "docker",
          ok: false,
          required: true,
          detail: "Docker is not reachable",
          fix: "install Docker and start it (docker info must succeed)",
        },
  );
  for (const { name, ref } of options.images) {
    const fix = `docker pull --platform linux/amd64 ${ref}`;
    if (!docker) {
      checks.push({
        id: `image.${name}`,
        ok: false,
        required: true,
        detail: "not checked: no Docker",
        fix,
      });
      continue;
    }
    const present = await probes.image(ref);
    checks.push(
      present
        ? { id: `image.${name}`, ok: true, required: true, detail: ref }
        : { id: `image.${name}`, ok: false, required: true, detail: `${ref} is not pulled`, fix },
    );
  }
  const { found, wanted } = options.node;
  const sameMajor = major(found) === major(wanted);
  checks.push({
    id: "node",
    ok: sameMajor,
    required: true,
    detail:
      found === wanted
        ? `Node ${found}`
        : `Node ${found}; the supported version is ${wanted}${sameMajor ? " (same major version: it should work)" : ""}`,
    ...(sameMajor ? {} : { fix: `install Node ${wanted} (.node-version)` }),
  });
  const python = await probes.python();
  checks.push(
    python
      ? { id: "python", ok: true, required: false, detail: `Python ${python}` }
      : {
          id: "python",
          ok: false,
          required: false,
          detail: "python3 not found: needed only for the eval harness and repository tools",
          fix: "install uv; it fetches Python 3.13 (.python-version)",
        },
  );
  for (const p of [...options.plugins].sort((a, b) => a.manifest.id.localeCompare(b.manifest.id))) {
    const secrets = p.manifest.secrets ?? [];
    const missing = secrets.filter((s) => !options.env[s]);
    checks.push(
      missing.length === 0
        ? {
            id: `plugin.${p.manifest.id}`,
            ok: true,
            required: false,
            detail: secrets.length ? `secrets set: ${secrets.join(", ")}` : "needs no secret",
          }
        : {
            id: `plugin.${p.manifest.id}`,
            ok: false,
            required: false,
            detail: `missing ${missing.join(", ")}`,
            fix: `set ${missing.join(", ")} in the environment to use ${p.manifest.id}`,
          },
    );
  }
  const remotes = (options.remote ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (remotes.length === 0)
    checks.push({
      id: "cas_remote",
      ok: false,
      required: false,
      detail: "CINEWRIGHT_CAS_REMOTE is not set: tier A fixtures cannot fetch their assets",
      fix: "set CINEWRIGHT_CAS_REMOTE to the fixture asset remote (an https: or file: template with {hex})",
    });
  else {
    const down: string[] = [];
    for (const r of remotes) if (!(await probes.remote(r))) down.push(r);
    checks.push(
      down.length === 0
        ? { id: "cas_remote", ok: true, required: false, detail: remotes.join(", ") }
        : {
            id: "cas_remote",
            ok: false,
            required: false,
            detail: `not reachable: ${down.join(", ")}`,
            fix: "check the network and the template in CINEWRIGHT_CAS_REMOTE",
          },
    );
  }
  return { ok: checks.every((c) => c.ok || !c.required), checks };
}

const run = promisify(execFile);

/** The real probes: `docker`, `python3` and the network. */
export function systemProbes(): DoctorProbes {
  return {
    docker: async () => {
      try {
        const { stdout } = await run("docker", ["version", "--format", "{{.Server.Version}}"], {
          timeout: 15_000,
        });
        return stdout.trim() || null;
      } catch {
        return null;
      }
    },
    image: async (ref) => {
      try {
        await run("docker", ["image", "inspect", "--format", "{{.Id}}", ref], { timeout: 15_000 });
        return true;
      } catch {
        return false;
      }
    },
    python: async () => {
      try {
        const { stdout, stderr } = await run("python3", ["--version"], { timeout: 15_000 });
        return /\d+\.\d+\.\d+/.exec(stdout || stderr)?.[0] ?? null;
      } catch {
        return null;
      }
    },
    remote: async (template) => {
      const url = template.replace("{hex}", "0".repeat(64));
      if (url.startsWith("file:")) return existsSync(dirname(fileURLToPath(url)));
      try {
        await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(10_000) });
        return true;
      } catch {
        return false;
      }
    },
  };
}
