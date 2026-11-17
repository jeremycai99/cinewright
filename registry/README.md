# Registry

Shared data that projects copy, never code.

## Delivery profiles (`profiles/`)

A delivery profile states what a deliverable must be: frame size and rate, sample rate, safe zones, loudness target, caption rules, and optionally a maximum length and the final encode. Its schema is `core/schema/delivery-profile.schema.json`. `cinewright init --deliverable <id>=<name>` takes a name from this folder; a path (anything with a `/` or ending in `.json`) still works. `init` copies the profile into the project with its hash (convention 16), so editing a file here never changes an existing project.

The M1 profiles in `core/test/fixtures/profiles/` are test fixtures for core tests only.

### `landscape_web`: 1920×1080, 30 fps

| Field | Value | Norm |
| --- | --- | --- |
| Frame | 1920×1080, 30/1 fps, 48 kHz | 1080p, the common web upload size; 48 kHz is the broadcast and web video audio rate. |
| Safe zones | action 5%, title 10% per edge | The conventional action-safe and title-safe margins (90% and 80% boxes). |
| Loudness | −14 LUFS integrated, −1 dBTP, ±1 LU | The level the major streaming and web video platforms normalise to; −1 dBTP leaves headroom for lossy re-encoding. |
| Captions | 42 characters per line, 2 lines, at least 30 frames (1 s) per cue | Common subtitle guidance for landscape video: at most two lines of about 42 characters, and no cue shorter than about a second. |
| Encoding | `libx264`, CRF 18, `medium`, `yuv420p`, AAC 384 kbps | An upload master: H.264 with 4:2:0 chroma is what web platforms accept everywhere, and CRF 18 is visually lossless before they re-encode. 384 kbps is YouTube's recommended stereo AAC bitrate. |

### `vertical_social`: 1080×1920, 30 fps

| Field | Value | Norm |
| --- | --- | --- |
| Frame | 1080×1920, 30/1 fps, 48 kHz | 9:16 full HD, the vertical short-form size. |
| Safe zones | title: top 15%, right 28%, bottom 35%, left 12%; action: top 14%, right 18%, bottom 35%, left 6% | Vertical platforms draw their own controls over the video. The title-safe box is the area clear of all three in the platform guides HyperFrames records (`@hyperframes/core` `safeAreas.js`, checked 2026-10-13): TikTok's in-feed template (its action buttons need the 28% right edge in the lower band), Meta's Reels guide (bottom 35%), and YouTube Shorts (top 15%, bottom 35%). Platform UI varies by device and caption, so the box is conservative. |
| Loudness | −14 LUFS, −1 dBTP, ±1 LU | As `landscape_web`. |
| Captions | 32 characters per line, 2 lines, at least 30 frames | Shorter lines for the narrow frame. |
| Encoding | `libx264`, CRF 18, `medium`, `yuv420p`, AAC 256 kbps | As `landscape_web`. Social platforms re-encode to well below 256 kbps. |

These are general delivery norms, not a style. A project that needs other values uses its own profile file.
