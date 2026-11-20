# Neutral (the neutral default pack)

The neutral default pack. Projects use it until they choose another pack. It is deliberately restrained, legible and broadly professional (`AGENTS.md` §2.2). It should be a reasonable choice for any brief: a corporate explainer, a children's lesson, a documentary, a product ad or a narrative short. It is not a house style: anything here can be overridden per project, sequence, scene, shot or layer, or replaced by choosing another pack.

| Domain | Choice |
| --- | --- |
| Color | A near-white background, near-black ink and one blue accent. Six data colours, each at least 4.3:1 on both backgrounds. Every text pair is at least 7:1, well above the WCAG AA floors. |
| Type | Inter (variable, OFL-1.1) in regular, semibold and bold. A modular scale from caption (2.6% of the frame's shorter side) to display. Minimum text size 2.4%. |
| Layout | A 12 × 6 grid in landscape and 4 × 8 in portrait, with every core template. Portrait captions sit above the bottom rows, clear of platform controls. |
| Motion | Decelerating easing with no overshoot; `pop` is disabled. Durations from 120 ms to 800 ms. Rise in, fade out; lines reveal in order. |
| Transitions | Cross-dissolve by default between scenes, cut within a scene, and wipe for stepping through a sequence (see `rules.md`). |
| Sound | An unobtrusive ambient bed at 70–110 BPM, ducked 12 dB under the voice. Sound effects are off by default. |
| Pacing | 400 ms before a scene's first line, 300 ms between lines, 600 ms after the last (`sound.voice`, 1.1.0). |

Loudness targets come from delivery profiles, not from this pack.

## Fonts

`fonts/inter-latin-wght-normal.woff2` and `fonts/inter-latin-ext-wght-normal.woff2` were copied from `@fontsource-variable/inter@5.3.0`. Each covers the `unicode_range` recorded in `pack.json`, and their hashes are checked on load. Inter is licensed under the SIL Open Font License 1.1 (`fonts/OFL.txt`). Scripts these files do not cover fall back to the render image's Noto fonts.

## Example frames

The pack's example frames are its component specimens, rendered on demand with `pnpm specimens --pack neutral` (M2.4b). They are never committed.
