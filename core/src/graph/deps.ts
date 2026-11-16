import { sha256Hash } from "../canonical/hash.js";
import type { InlinedIr } from "../ir/inlined.js";
import { indexIr, isObject } from "../ir/paths.js";
import type { JsonObject } from "../schema/load.js";
import { type RenderInputs, renderKey, unwrap } from "./render-key.js";

export { type RenderInputs, renderKey } from "./render-key.js";

/** Nodes and edges (dependency → dependents). */
export interface Graph {
  nodes: Set<string>;
  edges: Map<string, Set<string>>;
}

/** Transitions that render as their own segment (D34); a cut has none. */
const SEGMENT_TRANSITIONS = new Set(["cross_dissolve", "wipe"]);

interface Layout {
  deliverables: string[];
  scenes: { id: string; shots: string[]; transition: string | null }[];
  lineShots: Map<string, Set<string>>;
  takes: { id: string; line: string }[];
  lines: string[];
}

function value(wrapper: unknown): unknown {
  return isObject(wrapper) ? wrapper.value : undefined;
}

function anchorLines(node: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(node)) for (const v of node) anchorLines(v, out);
  else if (isObject(node)) {
    if (typeof node.line === "string" && typeof node.point === "string") out.add(node.line);
    for (const v of Object.values(node)) anchorLines(v, out);
  }
  return out;
}

function layout(ir: InlinedIr): Layout {
  const scenes: Layout["scenes"] = [];
  const lineShots = new Map<string, Set<string>>();
  for (const sequence of ir.sequences.value ?? []) {
    for (const scene of (value(sequence.scenes) as JsonObject[] | undefined) ?? []) {
      const shots = ((value(scene.shots) as JsonObject[] | undefined) ?? []).map(
        (s) => s.id as string,
      );
      const transition = value(scene.transition_out) as JsonObject | undefined;
      scenes.push({
        id: scene.id as string,
        shots,
        transition:
          transition && SEGMENT_TRANSITIONS.has(transition.type as string)
            ? (scene.id as string)
            : null,
      });
      for (const shot of (value(scene.shots) as JsonObject[] | undefined) ?? []) {
        const lines = anchorLines([shot.anchors, value(shot.layers)]);
        for (const line of lines) {
          if (!lineShots.has(line)) lineShots.set(line, new Set());
          lineShots.get(line)?.add(shot.id as string);
        }
      }
    }
  }
  const lines: string[] = [];
  for (const beat of (ir.script.beats.value ?? []) as unknown as JsonObject[]) {
    for (const line of (value(beat.lines) as JsonObject[] | undefined) ?? [])
      lines.push(line.id as string);
  }
  const takes = (ir.assets.value ?? []).flatMap((a) =>
    a.role === "take" && a.line ? [{ id: a.id, line: a.line }] : [],
  );
  return {
    deliverables: (ir.deliverables.value ?? []).map((d) => d.id),
    scenes,
    lineShots,
    takes,
    lines,
  };
}

/**
 * The dependency graph (M1.5): script line → take → timing anchors → shot durations → renders
 * and adjacent transition segments → mix → captions → assembly, per deliverable. Planning nodes
 * (`script`, `plan:<scene>`) sit beside the chain: what changes a shot's render is its resolved
 * spec, not the plan that produced it.
 */
export function dependencyGraph(ir: InlinedIr, _inputs?: RenderInputs): Graph {
  const g: Graph = { nodes: new Set(), edges: new Map() };
  const edge = (from: string, to: string) => {
    g.nodes.add(from);
    g.nodes.add(to);
    if (!g.edges.has(from)) g.edges.set(from, new Set());
    g.edges.get(from)?.add(to);
  };
  const l = layout(ir);
  g.nodes.add("script");
  for (const scene of l.scenes) edge("script", `plan:${scene.id}`);
  for (const line of l.lines) g.nodes.add(`line:${line}`);
  for (const take of l.takes) edge(`line:${take.line}`, `take:${take.id}`);
  for (const [line, shots] of l.lineShots) {
    for (const shot of shots) {
      edge(`line:${line}`, `anchors:${shot}`);
      for (const take of l.takes.filter((t) => t.line === line))
        edge(`take:${take.id}`, `anchors:${shot}`);
    }
  }
  const allShots = l.scenes.flatMap((s) => s.shots);
  for (const d of l.deliverables) {
    for (const line of l.lines) edge(`line:${line}`, `captions@${d}`);
    for (const take of l.takes) edge(`take:${take.id}`, `mix@${d}`);
    edge(`mix@${d}`, `captions@${d}`);
    edge(`mix@${d}`, `assembly@${d}`);
    edge(`captions@${d}`, `assembly@${d}`);
    for (const shot of allShots) {
      edge(`anchors:${shot}`, `duration:${shot}`);
      edge(`duration:${shot}`, `render:${shot}@${d}`);
      edge(`duration:${shot}`, `mix@${d}`);
      edge(`render:${shot}@${d}`, `assembly@${d}`);
    }
    // A segment between scene i and i+1 is rendered from i's last shot and i+1's first (D34).
    l.scenes.forEach((scene, i) => {
      if (!scene.transition) return;
      const node = `transition:${scene.transition}@${d}`;
      edge(node, `assembly@${d}`);
      const last = scene.shots.at(-1);
      const next = l.scenes[i + 1]?.shots[0];
      for (const shot of [last, next]) {
        if (!shot) continue;
        edge(`render:${shot}@${d}`, node);
        edge(`duration:${shot}`, node);
      }
    });
  }
  return g;
}

/** What each node depends on directly, as a hash; a node whose hash changes is dirty itself. */
function contents(ir: InlinedIr, graph: Graph, inputs: RenderInputs): Map<string, string> {
  const index = indexIr(ir);
  const out = new Map<string, string>();
  const node = (id: string) => index.get(id)?.node;
  const profileHash = (d: string) => {
    const deliverable = (ir.deliverables.value ?? []).find((x) => x.id === d);
    const profile = deliverable?.profile.value;
    return profile ? (ir.profiles[profile]?.hash ?? "") : "";
  };
  for (const id of graph.nodes) {
    const [kind = "", rest = ""] = id.split(/[:@]/, 2);
    const d = id.includes("@") ? (id.split("@")[1] ?? "") : "";
    let content: unknown;
    if (id === "script")
      content = ((ir.script.beats.value ?? []) as unknown as JsonObject[]).map((b) => [
        b.id,
        unwrap(b.summary),
      ]);
    else if (kind === "plan") {
      const { shots: _s, transition_out: _t, ...scene } = node(rest) ?? {};
      content = unwrap(scene);
    } else if (kind === "line" || kind === "take") content = unwrap(node(rest));
    else if (kind === "anchors")
      content = [unwrap(node(rest)?.anchors), anchorLines(unwrap(node(rest)?.layers)).size];
    else if (kind === "duration") content = unwrap(node(rest)?.duration);
    else if (kind === "render") content = renderKey(ir, rest, d, inputs);
    else if (kind === "transition") content = [unwrap(node(rest)?.transition_out), profileHash(d)];
    else if (id.startsWith("mix@")) {
      content = [
        (ir.sequences.value ?? []).map((s) => [
          unwrap(s.music_bed),
          ((s.scenes.value ?? []) as unknown as JsonObject[]).map((sc) => unwrap(sc.sound)),
        ]),
        profileHash(d),
      ];
    } else if (id.startsWith("captions@")) {
      const deliverable = (ir.deliverables.value ?? []).find((x) => x.id === d);
      content = [unwrap(deliverable?.burn_in_captions), profileHash(d)];
    } else if (id.startsWith("assembly@")) content = profileHash(d);
    out.set(id, sha256Hash(content ?? null));
  }
  return out;
}

/** Nodes whose own inputs changed, plus everything downstream of them (M1.5). */
export function dirtyNodes(before: InlinedIr, after: InlinedIr, inputs: RenderInputs): Set<string> {
  const g0 = dependencyGraph(before, inputs);
  const g1 = dependencyGraph(after, inputs);
  const c0 = contents(before, g0, inputs);
  const c1 = contents(after, g1, inputs);
  const dirty = new Set<string>();
  for (const id of new Set([...g0.nodes, ...g1.nodes]))
    if (c0.get(id) !== c1.get(id)) dirty.add(id);
  const queue = [...dirty];
  while (queue.length > 0) {
    const id = queue.pop() as string;
    for (const next of [...(g0.edges.get(id) ?? []), ...(g1.edges.get(id) ?? [])]) {
      if (!dirty.has(next)) {
        dirty.add(next);
        queue.push(next);
      }
    }
  }
  return dirty;
}
