// A narrated, composed project for the mixer's tests: the stub TTS speaks tones, the music bed
// comes from a library synthesized at test time.
import { fileURLToPath } from "node:url";
import { loadCatalog, loadPack, type Store, solveTiming } from "@cinewright/core";
import { compose } from "../../../engine/src/jobs/composer.js";
import { narrate } from "../../../engine/src/jobs/narration.js";
import { findPlugins } from "../../../engine/src/plugins/registry.js";
import { apply, narrationProject, type Op, plugins } from "../../../engine/test/helpers.js";
import { library } from "../../library-audio/test/helpers.js";

export const PACKS = fileURLToPath(new URL("../../../packs/", import.meta.url));
export const CATALOG = loadCatalog(
  fileURLToPath(new URL("../../../components/src/", import.meta.url)),
);
export const NEUTRAL = loadPack("neutral", [PACKS]);
const LIBRARY_PLUGIN = fileURLToPath(new URL("../../library-audio/", import.meta.url));

const LINES = [
  { id: "b01.l01", text: "One two three four five six.", speaker: "narrator" },
  { id: "b01.l02", text: "Seven eight nine ten.", speaker: "narrator" },
  { id: "b01.l03", text: "Eleven twelve thirteen.", speaker: "narrator" },
];

const scene = (id: string, lines: string[], extra: Op = {}) => ({
  id,
  intent: "Test",
  lines,
  shots: [{ id: `${id}.sh01`, type: "motion_graphics", framing: "full_frame" }],
  ...extra,
});

/** Two sequences; the first has music, the second only narration. */
export async function mixProject(options: { music?: boolean } = {}): Promise<Store> {
  const { store } = await narrationProject(LINES);
  await apply(store, [
    {
      op: "insert",
      entity: "demo",
      path: "/sequences",
      value: { id: "seq_a", title: "A", scenes: [scene("s01", ["b01.l01", "b01.l02"])] },
    },
    {
      op: "insert",
      entity: "demo",
      path: "/sequences",
      value: { id: "seq_b", title: "B", scenes: [scene("s02", ["b01.l03"])] },
    },
  ]);
  await narrate(store, { ...(await plugins()), env: {} });
  if (options.music !== false) {
    const dir = library([
      {
        id: "ambient_calm",
        tags: ["ambient", "unobtrusive"],
        mood: ["calm"],
        bpm: 90,
        seconds: 30,
      },
    ]);
    await compose(store, {
      sequence: "seq_a",
      music: await findPlugins("music", [LIBRARY_PLUGIN]),
      pack: NEUTRAL,
      catalog: CATALOG,
      env: { CINEWRIGHT_AUDIO_LIBRARY_PATH: dir },
    });
  }
  return store;
}

export const solve = (store: Store) => solveTiming(store.ir(), NEUTRAL, CATALOG);
