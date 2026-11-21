// A stub backend for the critique step's tests: `render.check` writes a check document into a
// cache entry of its own under the project, once. Shot s01.sh01's title overflows; every other
// shot is clean. A shot named in the project file's `stub_check_fail` fails the check.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Plugin, PluginRequest, PluginResponse } from "@cinewright/plugin-sdk";

export function createPlugin(): Plugin {
  return {
    async init() {},
    async capabilities() {
      return ["backend.html", "render.plan", "render.shot", "render.check"];
    },
    async call(request: PluginRequest): Promise<PluginResponse> {
      if (request.method !== "render.check")
        return {
          ok: false,
          error: { code: "unsupported", message: request.method, retryable: false },
        };
      const { project, deliverable, shot } = request.params as {
        project: string;
        deliverable: string;
        shot: string;
      };
      const dir = join(project, ".cinewright", "cache", "renders", `stub-${shot}-${deliverable}`);
      const file = join(dir, "check", "check.json");
      const hit = existsSync(file);
      const layer = `${shot}.title`;
      const failures =
        shot === "s01.sh01"
          ? [
              {
                section: "runtime",
                code: "cinewright.overflow",
                severity: "warning",
                message: `cinewright.overflow layer=${layer} element=h1.cw-title`,
                time: 0.5,
              },
            ]
          : [];
      if (!hit) {
        mkdirSync(join(dir, "check"), { recursive: true });
        writeFileSync(
          file,
          JSON.stringify({
            check: 1,
            hyperframes: "0.9.58",
            width: 1920,
            height: 1080,
            fps: { num: 30, den: 1 },
            frames: 60,
            body: { start: 0, end: 60 },
            layers: [
              {
                id: layer,
                component: "kinetic_title",
                box: { x: 400, y: 300, width: 1000, height: 300 },
                enter: 0,
                end: 60,
                min_text_size: 24,
              },
            ],
            samples: [
              {
                frame: 15,
                time: 0.5,
                still: "keyframes/000016.png",
                boxes: [
                  {
                    layer,
                    selector: `#cw-${layer}`,
                    text: "T",
                    x: 500,
                    y: 400,
                    width: 600,
                    height: 100,
                    font_size: 64,
                  },
                ],
              },
            ],
            failures,
          }),
        );
      }
      return { ok: true, result: { file, failures, boxes: [], hit } };
    },
    async shutdown() {},
  };
}
