import { describe, expect, it } from "vitest";
import { narrate } from "../src/jobs/narration.js";
import { transcribeTake } from "../src/jobs/transcribe.js";
import { assetOf, narrationProject, plugins } from "./helpers.js";

describe("transcribeTake", () => {
  it("freezes a transcript asset, and the second call makes no plugin call", async () => {
    const { store } = await narrationProject();
    const p = await plugins();
    const { made } = await narrate(store, { ...p, env: {} });
    const takeId = made[0]?.take as string;
    const first = await transcribeTake(store, takeId, { stt: p.stt, env: {} });
    expect(first.made).toBe(true);
    expect(assetOf(store, first.asset.id)).toMatchObject({
      role: "transcript",
      take: takeId,
      media_type: "application/json",
      provenance: { provider: "stub_stt", model: "stub" },
    });
    const revision = store.revision();
    const second = await transcribeTake(store, takeId, { stt: p.stt, env: {} });
    expect(second).toEqual({ asset: first.asset, made: false });
    expect(store.revision()).toBe(revision);
  });

  it("names a missing take", async () => {
    const { store } = await narrationProject();
    await expect(
      transcribeTake(store, "take_nope", { stt: (await plugins()).stt }),
    ).rejects.toThrow(/no take take_nope/);
  });
});
