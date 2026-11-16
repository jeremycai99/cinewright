import { describe, expect, it } from "vitest";
import { dockerRunArgs } from "../src/docker.js";
import { DEFAULT_LIMITS, timeoutMs } from "../src/limits.js";

describe("dockerRunArgs (audit F17)", () => {
  const args = dockerRunArgs({
    image: "cinewright-render:test",
    name: "cw-render-1",
    mounts: [
      { source: "/a, b/in", target: "/job/in", readonly: true },
      { source: "/out", target: "/job/out", readonly: false },
    ],
    user: { uid: 501, gid: 20 },
    limits: DEFAULT_LIMITS,
    command: ["--in", "/job/in", "--out", "/job/out"],
  });
  const after = (flag: string) => args[args.indexOf(flag) + 1];

  it("turns the network off and runs as the host user on amd64", () => {
    expect(args.slice(0, 2)).toEqual(["run", "--rm"]);
    expect(after("--network")).toBe("none");
    expect(after("--platform")).toBe("linux/amd64");
    expect(after("--user")).toBe("501:20");
    expect(after("--name")).toBe("cw-render-1");
  });

  it("sets every limit", () => {
    expect(after("--memory")).toBe(`${DEFAULT_LIMITS.memoryMb}m`);
    expect(after("--memory-swap")).toBe(`${DEFAULT_LIMITS.memoryMb}m`);
    expect(after("--pids-limit")).toBe(String(DEFAULT_LIMITS.pids));
    expect(after("--cap-drop")).toBe("ALL");
    expect(after("--security-opt")).toBe("no-new-privileges");
    expect(args).toContain("--read-only");
    expect(after("--tmpfs")).toMatch(/^\/tmp:rw,exec,size=\d+m$/);
  });

  it("CSV-quotes bind mounts and puts the image before its command", () => {
    expect(args).toContain('type=bind,"source=/a, b/in",target=/job/in,readonly');
    expect(args).toContain('type=bind,"source=/out",target=/job/out');
    expect(args.slice(-5)).toEqual([
      "cinewright-render:test",
      "--in",
      "/job/in",
      "--out",
      "/job/out",
    ]);
  });
});

describe("timeoutMs", () => {
  it("grows with the frame count from a fixed base", () => {
    expect(timeoutMs(0)).toBe(DEFAULT_LIMITS.baseTimeoutMs);
    expect(timeoutMs(300) - timeoutMs(150)).toBe(150 * DEFAULT_LIMITS.perFrameMs);
  });
});
