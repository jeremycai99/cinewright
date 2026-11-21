import { type Asset, type Store, stateHash } from "@cinewright/core";
import type { DeliverableReport } from "./run.js";

/**
 * The provenance manifest of one delivered file (M5.4b, P12): the project, revision and state
 * hash; the deliverable and its profile; every asset the film uses with provider, model, plan
 * tier and licence; every shot with its backend and render key; the mix and assembly keys; the
 * render image; and `synthetic_voice` for each take whose speaker is a synthetic voice. Derived
 * data: never part of a cache key, and no secret enters it.
 */
export function manifestFor(
  store: Store,
  deliverableId: string,
  entry: DeliverableReport,
  image: string,
) {
  const ir = store.ir();
  const deliverable = (ir.deliverables.value ?? []).find((d) => d.id === deliverableId);
  const profileId = deliverable?.profile.value as string;
  const assets = new Map((ir.assets.value ?? []).map((a) => [a.id, a]));
  const lines = (ir.script.beats.value ?? []).flatMap((b) => b.lines.value ?? []);
  const used = new Set<string>();
  const synthetic = new Set<string>();
  for (const sequence of ir.sequences.value ?? []) {
    if (sequence.music?.value) used.add(sequence.music.value);
    for (const scene of sequence.scenes?.value ?? []) {
      for (const lineId of scene.lines?.value ?? []) {
        const line = lines.find((l) => l.id === lineId);
        const take = line?.take?.value;
        if (!take) continue;
        used.add(take);
        const speaker = (ir.cast.value ?? []).find((c) => c.id === line?.speaker.value);
        if (speaker?.consent.value?.synthetic !== false) synthetic.add(take);
      }
      for (const asset of assets.values())
        if (asset.role === "sfx" && asset.scene === scene.id) used.add(asset.id);
      for (const shot of scene.shots?.value ?? [])
        for (const layer of shot.layers?.value ?? []) {
          const props = JSON.stringify(layer.props ?? {});
          for (const id of assets.keys()) if (props.includes(`"${id}"`)) used.add(id);
        }
    }
  }
  const describe = (a: Asset) => ({
    id: a.id,
    role: a.role,
    hash: a.hash,
    provider: a.provenance.provider,
    ...(a.provenance.model ? { model: a.provenance.model } : {}),
    ...(a.provenance.plan_tier ? { plan_tier: a.provenance.plan_tier } : {}),
    license: a.license,
    ...(a.role === "take" ? { synthetic_voice: synthetic.has(a.id) } : {}),
  });
  return {
    project: ir.id,
    revision: store.revision(),
    state_hash: stateHash(ir),
    deliverable: deliverableId,
    profile: { id: profileId, hash: ir.profiles[profileId]?.hash },
    frames: entry.frames,
    file: { sha256: entry.sha256, framemd5: entry.framemd5 },
    assets: [...used].sort().flatMap((id) => {
      const a = assets.get(id);
      return a ? [describe(a)] : [];
    }),
    shots: entry.shots,
    mix: { key: entry.mix_key, pcm_sha256: entry.pcm_sha256 },
    assembly: { key: entry.assembly_key },
    images: { render: image },
  };
}
