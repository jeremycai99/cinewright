# Playful pack rules

A deliberately contrasting pack (D39). These rules describe how it meets the same craft bar as the neutral default in a warmer, more energetic way. Agents cite them as `pack:playful@<version>#<rule id>`.

## Color

### `color.warm_ground` Warm ground, bold accents

Lay content on the warm background or surface. Use the accent and data colours generously for shapes and highlights, but keep text on the pack's checked pairs.

### `color.one_focus` One focus per frame

However colourful the frame, one element leads: give the accent to the thing the narration is talking about.

## Type

### `type.big_and_round` Big, rounded type

Use the large type scale; headlines are short and set large. Fredoka's rounded forms carry the tone, so avoid extra decoration on text.

### `type.short_lines` Short lines for young readers

Keep headlines to a few words and bullets to one short line, so early readers can follow.

## Layout

### `layout.centred_focus` Centre the focus

Prefer centred compositions with one large element. Keep text inside the safe area in every deliverable.

### `layout.rounded_shapes` Rounded shapes

Panels and cards use `layout.radius`; strokes use `layout.stroke`. Hard corners are the exception.

## Density

### `density.fewer_items` Fewer items, longer holds

At most `density.max_bullets` items at a time, held longer (`density.min_hold`, `density.hold_per_word`) than in the neutral pack.

## Motion

### `motion.overshoot_for_emphasis` Overshoot for emphasis only

The `pop` preset and `motion.ease.emphasis` overshoot. Use them for headlines, icons and the key element of a frame. Never use overshoot on body text, captions or anything the viewer must read while it moves.

### `motion.word_by_word` Word-by-word titles

Headlines reveal word by word (`motion.text_reveal`), in step with the narration where it speaks them.

### `motion.lively_but_brief` Lively but brief

Movements are quick (the `s` and `m` durations), and stop fully before the viewer needs to read.

## Transition

### `transition.wipe_by_default` Wipe between shots

Wipe in the reading direction between shots and scenes. It reads as turning a page.

### `transition.dissolve_for_time` Dissolve for time passing

Use a cross-dissolve only when time passes or the place changes.

## Sound

### `sound.upbeat_bed` An upbeat bed

Music is bright and rhythmic, within the pack's tempo range, and ducks under the narration by `sound.duck.depth_db`.

### `sound.effects_mark_moments` Effects mark moments

Soft pops and chimes mark a key element's arrival. One effect per moment, never one per word.
