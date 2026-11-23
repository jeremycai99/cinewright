import { describe, expect, it } from "vitest";
import { type DoctorProbes, doctor } from "../src/doctor.js";
import type { FoundPlugin } from "../src/plugins/registry.js";

const plugin = (id: string, secrets: string[]) =>
  ({ dir: `/p/${id}`, manifest: { id, kind: "llm", secrets } }) as unknown as FoundPlugin;

const IMAGES = [
  { name: "render", ref: "ghcr.io/o/cinewright-render@sha256:1" },
  { name: "audio", ref: "ghcr.io/o/cinewright-audio@sha256:2" },
];

function probes(over: Partial<DoctorProbes> = {}): DoctorProbes {
  return {
    docker: async () => "28.0.0",
    image: async () => true,
    python: async () => "3.13.5",
    remote: async () => true,
    ...over,
  };
}

const base = {
  images: IMAGES,
  node: { found: "24.22.3", wanted: "24.22.3" },
  plugins: [plugin("tts_kokoro", []), plugin("llm_anthropic", ["ANTHROPIC_API_KEY"])],
  env: { ANTHROPIC_API_KEY: "k" },
  remote: "https://cas.example/{hex}",
};
const check = (r: Awaited<ReturnType<typeof doctor>>, id: string) =>
  r.checks.find((c) => c.id === id);

describe("doctor (M8.5)", () => {
  it("passes when Docker, both images and Node are there", async () => {
    const r = await doctor({ ...base, probes: probes() });
    expect(r.ok).toBe(true);
    expect(r.checks.every((c) => c.ok)).toBe(true);
  });

  it("names a missing image, says how to pull it, and fails", async () => {
    const r = await doctor({
      ...base,
      probes: probes({ image: async (ref) => !ref.includes("audio") }),
    });
    expect(r.ok).toBe(false);
    expect(check(r, "image.audio")).toMatchObject({ ok: false, required: true });
    expect(check(r, "image.audio")?.fix).toContain(
      `docker pull --platform linux/amd64 ${IMAGES[1]?.ref}`,
    );
    expect(check(r, "image.render")?.ok).toBe(true);
  });

  it("names a missing key by name without failing: a Manual render needs none", async () => {
    const r = await doctor({ ...base, env: {}, probes: probes() });
    expect(r.ok).toBe(true);
    expect(check(r, "plugin.llm_anthropic")).toMatchObject({ ok: false, required: false });
    expect(check(r, "plugin.llm_anthropic")?.detail).toContain("ANTHROPIC_API_KEY");
    expect(check(r, "plugin.tts_kokoro")?.ok).toBe(true);
  });

  it("names an unreachable CAS remote separately, without failing", async () => {
    const r = await doctor({ ...base, probes: probes({ remote: async () => false }) });
    expect(r.ok).toBe(true);
    expect(check(r, "cas_remote")).toMatchObject({ ok: false, required: false });
    expect(check(r, "cas_remote")?.detail).toContain("cas.example");
  });

  it("reports an unset CAS remote as not set", async () => {
    const { remote: _, ...rest } = base;
    const r = await doctor({ ...rest, probes: probes() });
    expect(check(r, "cas_remote")).toMatchObject({ ok: false, required: false });
    expect(check(r, "cas_remote")?.detail).toMatch(/CINEWRIGHT_CAS_REMOTE is not set/);
  });

  it("fails without Docker and does not probe images", async () => {
    let probed = false;
    const r = await doctor({
      ...base,
      probes: probes({
        docker: async () => null,
        image: async () => {
          probed = true;
          return true;
        },
      }),
    });
    expect(r.ok).toBe(false);
    expect(check(r, "docker")).toMatchObject({ ok: false, required: true });
    expect(check(r, "image.render")?.ok).toBe(false);
    expect(probed).toBe(false);
  });

  it("fails on another Node major version and warns on another patch", async () => {
    const major = await doctor({
      ...base,
      node: { found: "22.1.0", wanted: "24.22.3" },
      probes: probes(),
    });
    expect(major.ok).toBe(false);
    expect(check(major, "node")?.ok).toBe(false);
    const patch = await doctor({
      ...base,
      node: { found: "24.1.0", wanted: "24.22.3" },
      probes: probes(),
    });
    expect(patch.ok).toBe(true);
    expect(check(patch, "node")?.detail).toContain("24.22.3");
  });

  it("reports Python as optional", async () => {
    const r = await doctor({ ...base, probes: probes({ python: async () => null }) });
    expect(r.ok).toBe(true);
    expect(check(r, "python")).toMatchObject({ ok: false, required: false });
  });
});
