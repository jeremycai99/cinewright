# @cinewright/plugin-sdk

The plugin contract v0 (D32, M1.8): the generic envelope every plugin shares. Kind-specific interfaces build on it in their own milestones: backend (M3.2), TTS (M4.1), music (M4.3), STT (M4.5), critics (M6) and LLM (M7.3).

## Manifest

`schema/manifest.schema.json` declares what a plugin is and what it costs:
- `kind`, `capabilities`, `cost_model`, `latency_class`;
- **`output_license`**, which is required: the render gate needs the license terms of everything a plugin produces (AGENTS.md §6);
- the `secrets` it reads, its `runtime`, `concurrency` and `rate_limits`.

`validateManifest(json)` checks a manifest.

## Interface

```ts
interface Plugin {
  init(context: PluginContext): Promise<void>;
  capabilities(): Promise<string[]>;          // must equal the manifest's
  call(request: PluginRequest, signal: AbortSignal): Promise<PluginResponse>;
  shutdown(): Promise<void>;
}
```

- `call` never throws across the boundary. A failure is a typed `PluginError`: `invalid_request`, `unsupported`, `timeout`, `cancelled`, `rate_limited`, `provider_error` or `internal`, with `retryable`.
- Aborting the signal must stop the work.
- An in-process plugin (`runtime.kind: "in_process"`) exports `createPlugin()` from its entry, and `loadPlugin(manifestPath)` loads it.
- Subprocess plugins (`runtime.kind: "subprocess"`) speak JSON-RPC 2.0 on stdio, one message per line (M1.8b). `createSubprocessPlugin(manifest, dir)` wraps one, and `loadPlugin` uses it for subprocess manifests.
  - **Start:** the host answers `health` within 5 s, or the start fails.
  - **Cancel:** an aborted call is sent `$/cancel`.
  - **Timeout:** a call that outlives `callTimeoutMs` is cancelled, given a second, and then the process is killed and the call reports `timeout`.
  - **Shutdown:** `shutdown`, then `exit`, then SIGTERM, then SIGKILL.
  - **Cleanup:** the host kills its children when it exits or on SIGINT and SIGTERM. A plugin exits on stdin EOF, which covers a host killed with SIGKILL.
  - **Python:** the SDK is `plugins/sdk-py` (`cinewright-plugin-sdk`), which runs on Python 3.12 and later.
  - **Work folder:** `PluginContext.workDir` is where requests and results name files, by relative path. The host creates one per plugin instance when none is given and deletes it at shutdown. Python plugins read it as `self.work_dir`.
  - **stderr (F18):** the host keeps the last 64 KiB, with every declared secret value replaced by `[secret:NAME]`. A failed call's `error.data.stderr` holds that tail, and `PluginContext.onLog` gets each line.
- **Containerized plugins (M4):** a subprocess runtime with `container: { image: "audio" }` runs its command in a pinned image (`containerCommand`):
  - `docker run -i --init --name cinewright-plugin-<uuid> --network none`, with the run limits (`DEFAULT_LIMITS`), as the host user;
  - the work folder at `/work`, the plugin read-only at `/plugins/<id>`, and the Python SDK read-only on `PYTHONPATH`;
  - the offline environment (`HF_HUB_OFFLINE=1` and the model folders), and declared secrets passed by name only;
  - a 60 s start timeout (`CONTAINER_START_TIMEOUT_MS`), since models load before `health`.

  The image is `CINEWRIGHT_<IMAGE>_IMAGE` if set, else the digest in `container/<image>/image.lock.json` (`resolveContainerImage`). Every stop (timeout, shutdown, host exit) is a `docker kill` of the container's name, so none outlives the host.
- **Containers:** `dockerRunArgs`, `runDocker` and `DEFAULT_LIMITS` (moved here from the HyperFrames backend) build and run every container the host starts.

## Conformance kit

`runConformance(loaded, golden)` checks that:
1. the manifest validates;
2. the reported capabilities equal the manifest's;
3. each golden request returns its expected result;
4. a failing request returns a typed error;
5. aborting a slow call returns `cancelled` within a second.

Golden cases (`GoldenCase[]`) must include at least one error case and one cancellable case. `test/fixtures/stub-plugin/` is a complete example.

`runConformance(loaded, golden, kind)` also checks each successful golden request and result against the kind's schemas in `schema/kinds/` and its extra checks. `STT_KIND` is the first (`stt.align`, `stt.transcribe`); `test/fixtures/stub-stt/` passes it.
