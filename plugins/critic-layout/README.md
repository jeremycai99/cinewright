# critic-layout

The layout critic (M6.1a): a `critic` plugin, in process, Apache-2.0. One method, `critic.run`.

For each shot in scope it reads `check/check.json` from the shot's render cache entry. The HyperFrames backend's `render.check` writes that file: HyperFrames `check` (through `render-job check`, network off) and the text boxes `render-job boxes` reads, both at the shot's keyframe times (`sampleFrames`, M3.5). The critic grades them against the delivery profile, the resolved pack and `settings.json`. It never renders, never writes the IR, and calls no network or clock.

## Rules

| Rule | Source | Entity · pointer | Limit |
| --- | --- | --- | --- |
| `layout.overflow` | component marker `cinewright.overflow` (M2.5b) | layer · `/props` | the component's fit at `density.min_text_size` |
| `layout.density` | component marker `cinewright.density` | layer · `/props` | the pack's density tokens |
| `layout.collision` | text boxes of two layers intersect | the later layer · `/layout/<aspect>` | more than `collision.min_overlap_px` in both directions |
| `layout.safe_area` | a text box leaves `safeRect(pack, profile)` | layer · `/layout/<aspect>` | more than `safe_area.tolerance_px` |
| `layout.min_text_size` | computed font size (`font_size` in each box) | layer · `/props` | the layer's resolved `density.min_text_size`, less `min_text_size.tolerance_px` |
| `contrast.text` | HyperFrames `contrast_aa_failure` | layer (from the selector) | WCAG AA, as HyperFrames measures it |
| `contrast.pack_pair` | `contrastPairs` of the pack's tokens for the aspect class | pack · `/tokens/<fg>` | the pack's own `contrast.*_min` |
| `layout.check` | any other failure of HyperFrames `check` | layer, or the shot | its code is in `evidence.code` |

A finding's `key` (what its signature keeps while the defect persists) is the check code and element for check failures, the selector for geometry, and the pair for pack pairs: never a measured number.

## HyperFrames `check` codes at 0.9.58

Read from the pinned package (`hyperframes/dist`, 2026-11-21).

| Section | Codes | Rule |
| --- | --- | --- |
| runtime | console warnings `cinewright.overflow`, `cinewright.density` (kept as the code by `render-job check`) | `layout.overflow`, `layout.density` |
| contrast | `contrast_aa_failure` (an error when held across two samples, else a warning; both fail) | `contrast.text` |
| layout | `text_box_overflow`, `clipped_text`, `canvas_overflow`, `container_overflow`, `content_overlap`, `visibility_escapes_segment`, `text_occluded`, `canvas_covered`, `video_alpha_unread`, `text_not_painted`, `caption_zone_collision`, `outside_safe_zone`, `frame_out_of_frame`, `escaped_container`, `panel_out_of_canvas`, `canvas_content_at_edge`, `connector_detached`, `connector_orphan`, `rotation_pivot_drift`, `off_pivot_rotation`, `motion_*` | `layout.check` |

HyperFrames' own safe-zone check stays off (`--safe-zone off`): safe areas come from the delivery profile. Craft checks such as `text_below_floor` stay off (`--no-craft`); the pack's minimum text size is checked here instead.

## Limits

- Only the keyframe samples are graded. A defect that appears between samples is not seen.
- Thresholds come from the profile, the pack or `settings.json`; the plugin version and the settings hash are recorded in every report (D36). A test fails on a numeric literal compared in `src/`.
