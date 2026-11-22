// A scripted LLM for the engine's tests (M7.5a–b): answers as the Producer, Writer, Director, Shot Builder or Editor, chosen by
// the system prompt, with outputs that pass their checks. Every call is counted in `CALLS`.
import type { GenerateRequest } from "../../../../../plugins/sdk-ts/src/kinds/llm.js";
import type {
  Plugin,
  PluginRequest,
  PluginResponse,
} from "../../../../../plugins/sdk-ts/src/plugin.js";

export const CALLS = { count: 0 };

const PRODUCER = {
  output: {
    plan: {
      summary: "How a heat pump warms a house with heat from outdoor air",
      target_seconds: 14,
      beats: ["Heat is moved, not made"],
    },
  },
  decisions: [{ about: ["brief_01"], choice: "a short plan with one beat", citations: ["brief"] }],
};

const WRITER = {
  output: {
    beats: [
      {
        id: "b01",
        summary: "Heat is moved, not made",
        lines: [
          { id: "b01.l01", text: "A heat pump does not burn fuel to make heat." },
          { id: "b01.l02", text: "It gathers heat from the outdoor air and moves it inside." },
          { id: "b01.l03", text: "That is why it can give more heat than the power it uses." },
        ],
      },
    ],
  },
  decisions: [{ about: ["b01"], choice: "one beat in three lines", citations: ["brief"] }],
};

const shot = (id: string, line: string) => ({
  id,
  type: "motion_graphics",
  anchors: { start: { line, point: "start", offset: 0 } },
  layout: { landscape: { template: "title" } },
  components: ["kinetic_title"],
});

const DIRECTOR = {
  output: {
    sequences: [
      {
        id: "seq_a",
        title: "Heat is moved",
        mood: ["calm"],
        scenes: [
          {
            id: "s01",
            intent: "A heat pump moves heat rather than making it",
            mood: ["calm"],
            lines: ["b01.l01", "b01.l02", "b01.l03"],
            transition_out: { type: "cut" },
            shots: [shot("s01.sh01", "b01.l01"), shot("s01.sh02", "b01.l03")],
          },
        ],
      },
    ],
  },
  decisions: [
    {
      about: ["seq_a"],
      choice: "one scene, cut on the last line",
      citations: ["craft_rule:rhythm.cut_on_sense"],
    },
  ],
};

const EDITOR = {
  output: {
    scenes: [{ id: "s01", duration: { target_seconds: 16, flex: 0.25, sync: "voiceover" } }],
  },
  decisions: [
    {
      about: ["s01"],
      choice: "time the scene to its narration",
      citations: ["craft_rule:rhythm.hold_to_read"],
    },
  ],
};

/** The Shot Builder's answer for the shot its context names. */
function shotBuilder(text: string) {
  const shot = /"id":"(s\d+\.sh\d+)"/.exec(text)?.[1] ?? "s01.sh01";
  const line = shot === "s01.sh01" ? "b01.l01" : "b01.l03";
  return {
    output: {
      layers: [
        {
          id: `${shot}.l1`,
          component: "kinetic_title",
          props: { text: shot === "s01.sh01" ? "Heat is moved" : "More heat than power" },
          timing: { enter: { line, point: "start", offset: 0 } },
          layout: { landscape: { region: "title" } },
        },
      ],
    },
    decisions: [
      {
        about: [`${shot}.l1`],
        choice: "title the claim",
        citations: ["craft_rule:hierarchy.supports_line"],
      },
    ],
  };
}

export function createPlugin(): Plugin {
  return {
    async init() {},
    async capabilities() {
      return ["llm.generate", "llm.estimate"];
    },
    async call(request: PluginRequest): Promise<PluginResponse> {
      if (request.method === "llm.estimate") return { ok: true, result: { usd_max: 0 } };
      const p = request.params as GenerateRequest;
      CALLS.count += 1;
      const said = p.messages
        .flatMap((m) => m.content)
        .map((c) => (c.type === "text" ? c.text : ""))
        .join("\n");
      const output = p.system.includes("You are the Producer")
        ? PRODUCER
        : p.system.includes("You are the Director")
          ? DIRECTOR
          : p.system.includes("You are the Shot Builder")
            ? shotBuilder(said)
            : p.system.includes("You are the Editor")
              ? EDITOR
              : WRITER;
      return {
        ok: true,
        result: {
          output,
          model: `stub-${p.tier}`,
          usage: { input_tokens: 100, output_tokens: 50 },
          cost_usd: 0,
          stop: "end",
        },
      };
    },
    async shutdown() {},
  };
}
