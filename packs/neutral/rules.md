# Neutral pack rules

These rules state general craft practice for the neutral default pack. Agents cite them as `pack:neutral@<version>#<rule id>`; critics grade against them together with the brief.

## Color

### `color.one_accent` One accent at a time

Use `palette.accent` for the single thing the viewer should look at first in a frame: a key word, the highlighted bar, a call to action. Two accented elements in one frame compete, so neither leads.

### `color.text_pairs` Text only on approved pairs

Draw text only on the pairs the pack checks: ink or muted ink on the background or surface, and on-accent on accent. Accent-coloured text sits on the background and only at large sizes.

### `color.data_order` Data colours in order

Assign `palette.data.1` to the first series, `data.2` to the second, and so on, so the same series keeps its colour across shots. Never use a data colour for decoration.

## Type

### `type.hierarchy` One clear hierarchy

A frame has at most three type levels in view: one title level, one supporting level and captions. Size steps come from the type scale only.

### `type.weight_for_emphasis` Weight before colour

Emphasise within body text with the bold weight first. Reserve the accent colour for the frame's single focal point.

### `type.no_shrink_to_fit` Cut words before shrinking

When text does not fit, shorten it rather than drop below the minimum text size. Overflowing text is a finding, not something to hide.

## Layout

### `layout.grid` Align to the grid

Place every element in a template region. Edges line up with grid columns and rows, so cuts between shots do not make elements jump.

### `layout.safe_area` Stay inside the safe area

Keep text and key graphics inside the title-safe rect for every deliverable. Portrait deliverables leave the lower rows clear of platform controls; captions use the `captions` template.

### `layout.breathing_room` Leave space around the subject

Prefer fewer, larger elements with generous space over filling every region.

## Density

### `density.one_idea` One idea per shot

A shot carries one idea: one title, one chart or one short list. Split anything denser into more shots.

### `density.hold_time` Hold text long enough to read

Hold text on screen for at least `density.min_hold`, plus `density.hold_per_word` for each word beyond the first few. Never cut away from a sentence the narration has not finished.

## Motion

### `motion.purpose` Motion that explains

Every animation reveals, connects or directs attention. Nothing loops or moves for decoration.

### `motion.no_overshoot` No overshoot or bounce

Easing decelerates into place and never overshoots. The `pop` preset is disabled in this pack.

### `motion.consistent_entrances` Consistent entrances and exits

Elements enter with `motion.entrance` and leave with `motion.exit` unless a shot gives a reason to differ. Related elements stagger by `motion.stagger`, in reading order.

### `motion.short_durations` Short, consistent durations

Use the duration scale: `s` for small elements, `m` for most entrances, `l` for full-frame changes. A title is readable before its entrance ends.

## Transition

### `transition.cut_by_default` Cut within a thought

Cut between shots that continue the same idea or follow the narration's rhythm. A cut is the default inside a scene.

### `transition.dissolve_between_ideas` Dissolve between ideas

Use a cross-dissolve between scenes, when the narration moves to a new idea or the time or place changes.

### `transition.wipe_for_sequence` Wipe for a step forward

Use a wipe, in the reading direction, to move to the next item of a sequence: the next step, the next option, the next chapter. Do not mix wipe directions within a sequence.

## Sound

### `sound.music_supports` Music stays underneath

Music supports the narration and never competes with it. Choose calm, steady beds within the pack's tempo range, and avoid prominent melodies under speech.

### `sound.duck_under_voice` Duck under the voice

Music ducks by `sound.duck.depth_db` whenever the narration speaks, with the pack's attack and release times.

### `sound.sparse_effects` Sound effects only with purpose

Sound effects are off by default. When a brief asks for them, they mark a meaningful change on screen, never every movement.
