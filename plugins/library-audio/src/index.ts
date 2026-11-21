import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type {
  MusicRequest,
  Plugin,
  PluginContext,
  PluginRequest,
  PluginResponse,
  SfxRequest,
} from "@cinewright/plugin-sdk";
import {
  chooseMusic,
  chooseSfx,
  LibraryError,
  type LoadedItem,
  loadLibrary,
  sha256File,
} from "./library.js";

export { chooseMusic, chooseSfx, LibraryError, type LibraryItem, loadLibrary } from "./library.js";

function wavFormat(path: string): { sampleRate: number; channels: number } {
  const buf = readFileSync(path);
  if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") {
    throw new LibraryError(`${path} is not a WAV file`);
  }
  let at = 12;
  while (at + 8 <= buf.length) {
    const id = buf.toString("ascii", at, at + 4);
    const size = buf.readUInt32LE(at + 4);
    if (id === "fmt ")
      return { channels: buf.readUInt16LE(at + 10), sampleRate: buf.readUInt32LE(at + 12) };
    at += 8 + size + (size % 2);
  }
  throw new LibraryError(`${path} has no fmt chunk`);
}

const error = (
  code: "invalid_request" | "unsupported" | "provider_error",
  message: string,
  data?: unknown,
): PluginResponse => ({
  ok: false,
  error: { code, message, retryable: false, ...(data === undefined ? {} : { data }) },
});

/**
 * The local audio library (M4.3a): music beds and sound effects listed in `library.json`
 * files on CINEWRIGHT_AUDIO_LIBRARY_PATH, each with its file hash and licence. No network,
 * no generation; matching is deterministic.
 */
export function createPlugin(): Plugin {
  let workDir = "";
  let libraryPath: string | undefined;
  let items: LoadedItem[] | undefined;
  const library = () => {
    items ??= loadLibrary(libraryPath);
    return items;
  };
  const deliver = (
    item: LoadedItem,
    output: string,
    request: Record<string, unknown>,
  ): PluginResponse => {
    if (sha256File(item.path) !== item.sha256) {
      return error("provider_error", `library item ${item.id}: its file does not match its sha256`);
    }
    const target = join(workDir, output);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(item.path, target);
    const { sampleRate, channels } = wavFormat(item.path);
    return {
      ok: true,
      result: {
        file: output,
        sample_rate: sampleRate,
        channels,
        model: `library:${item.id}`,
        ...(item.loop ? { loop: true } : {}),
        request,
        license: item.license,
      },
    };
  };
  return {
    async init(context: PluginContext) {
      workDir = context.workDir ?? process.cwd();
      libraryPath = context.secrets.CINEWRIGHT_AUDIO_LIBRARY_PATH;
    },
    async capabilities() {
      return ["music.request", "sfx.request"];
    },
    async call(request: PluginRequest): Promise<PluginResponse> {
      try {
        if (request.method === "music.request") {
          const p = request.params as MusicRequest;
          const { output: _output, seed: _seed, ...asked } = p;
          const item = chooseMusic(library(), p);
          if (!item)
            return error("unsupported", "no library bed matches the request", {
              reason: "no_match",
              request: asked,
            });
          return deliver(item, p.output, asked);
        }
        if (request.method === "sfx.request") {
          const p = request.params as SfxRequest;
          const item = chooseSfx(library(), p.name);
          if (!item)
            return error("unsupported", `no library sound effect is named ${p.name}`, {
              reason: "no_match",
              name: p.name,
            });
          return deliver(item, p.output, { name: p.name });
        }
        return error("unsupported", `no method ${request.method}`);
      } catch (e) {
        if (e instanceof LibraryError) return error("invalid_request", e.message);
        throw e;
      }
    },
    async shutdown() {},
  };
}
