# @cinewright/engine

Jobs and the plugin registry (M4). The workflow runtime arrives in M7.1a.

- `findPlugins(kind, searchPath)`: the installed plugins of a kind. Each folder on the search path is a plugin (it holds `manifest.json`) or a folder of plugins. Invalid manifests and duplicate ids are errors.
- `route(kind, ir, speaker, options)`: the plugins to try, best first (D29). `--provider` names one; else `settings.providers.<kind>` in order; else plugins the speaker has a voice binding for: free first, then paid ones whose secrets are present, then by id. No provider is a default in code (invariant 11).
