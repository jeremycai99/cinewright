import { describe, expect, it } from "vitest";
import { patch, setupProject } from "./helpers.js";

// biome-ignore lint/suspicious/noExplicitAny: test access into the inlined IR
type Loose = any;

const asset = (id: string, extra: object = {}) => ({
  id,
  hash: `sha256:${"a".repeat(64)}`,
  media_type: "audio/wav",
  bytes: 10,
  role: "take",
  provenance: { provider: "stub" },
  license: { terms: "test", commercial_use: true },
  ...extra,
});

describe("plain-data objects on inserted entities (M4)", () => {
  it("leaves an absent asset `audio` absent", async () => {
    const { store } = await setupProject();
    const result = await store.apply(
      patch(store, [{ op: "insert", entity: "demo", path: "/assets", value: asset("take_a") }]),
    );
    expect(result.status).toBe("applied");
    const stored = (store.ir() as Loose).assets.value.find((a: Loose) => a.id === "take_a");
    expect("audio" in stored).toBe(false);
  });

  it("keeps a given `audio`, interpolated words and aligned_by", async () => {
    const { store } = await setupProject();
    const value = asset("take_b", {
      audio: { sample_rate: 24000, channels: 1, samples: 48000 },
      aligned_by: "stt_whisperx@0.1.0",
      words: [{ text: "2014", start: 0, end: 100, interpolated: true }],
    });
    const result = await store.apply(
      patch(store, [{ op: "insert", entity: "demo", path: "/assets", value }]),
    );
    expect(result.status).toBe("applied");
    const stored = (store.ir() as Loose).assets.value.find((a: Loose) => a.id === "take_b");
    expect(stored.audio).toEqual({ sample_rate: 24000, channels: 1, samples: 48000 });
    expect(stored.words[0].interpolated).toBe(true);
  });

  it("rejects an incomplete `audio`", async () => {
    const { store } = await setupProject();
    const value = asset("take_c", { audio: { sample_rate: 24000 } });
    const result = await store.apply(
      patch(store, [{ op: "insert", entity: "demo", path: "/assets", value }]),
    );
    expect(result.status).toBe("rejected");
  });
});

describe("jobs append to the asset registry (D25 as amended in M4.2)", () => {
  const JOB = { kind: "job", name: "narration" } as const;
  const AGENT = { kind: "agent", role: "composer" } as const;

  it("lets a job append to a user-owned registry, which stays user", async () => {
    const { store } = await setupProject();
    await store.apply(
      patch(store, [{ op: "insert", entity: "demo", path: "/assets", value: asset("upload") }]),
    );
    expect((store.ir() as Loose).assets.state).toBe("user");
    const result = await store.apply(
      patch(
        store,
        [{ op: "insert", entity: "demo", path: "/assets", value: asset("take_job") }],
        JOB,
      ),
    );
    expect(result.status).toBe("applied");
    expect((store.ir() as Loose).assets.state).toBe("user");
    expect((store.ir() as Loose).assets.value.map((a: Loose) => a.id)).toEqual([
      "upload",
      "take_job",
    ]);
  });

  it("still blocks an agent's insert, and a job's removal of a user item", async () => {
    const { store } = await setupProject();
    await store.apply(
      patch(store, [{ op: "insert", entity: "demo", path: "/assets", value: asset("upload") }]),
    );
    const agent = await store.apply(
      patch(
        store,
        [{ op: "insert", entity: "demo", path: "/assets", value: asset("take_agent") }],
        AGENT,
      ),
    );
    expect(agent.status).toBe("pending");
    const removal = await store.apply(patch(store, [{ op: "remove", entity: "upload" }], JOB));
    expect(removal.status).toBe("pending");
  });
});
