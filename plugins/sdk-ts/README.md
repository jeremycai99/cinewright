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
- Subprocess plugins (`runtime.kind: "subprocess"`) speak JSON-RPC 2.0 on stdio (M1.8b).

## Conformance kit

`runConformance(loaded, golden)` checks that:
1. the manifest validates;
2. the reported capabilities equal the manifest's;
3. each golden request returns its expected result;
4. a failing request returns a typed error;
5. aborting a slow call returns `cancelled` within a second.

Golden cases (`GoldenCase[]`) must include at least one error case and one cancellable case. `test/fixtures/stub-plugin/` is a complete example.
