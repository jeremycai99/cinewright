# M1 reference project

The spec's scene and cast examples (`docs/DESIGN_SPEC.md`, "What a scene spec holds" and "Cast bible entry") built as a project using only `cinewright init`, `patch` and `show` (M1.9). `build.sh <dir>` rebuilds it, and `cli/test/reference.test.ts` checks that the result is byte-identical to `project/`, logs included. The build pins `CINEWRIGHT_SESSION_ID` and `CINEWRIGHT_FIXED_TIME`, so the logs are reproducible.

## Patches

| Patch | Author | What |
| --- | --- | --- |
| `01-assets` | user | Dr Lin's character sheet (assets come first: the cast refers to them) |
| `02-cast` | user | Narrator and Dr Lin, from the cast example |
| `03-script` | user | The two dialogue lines |
| `04-sequence` | user | Scene 3 as the user scoped it: intent, mood, cast, lines, gates, style accent; scene 4 |
| `05-shots` | agent (scene planner) | Duration, transition, sound, and the two shots, with a decision-log entry |
| `06-subject` | user | Dr Lin is the subject of shot 2 |
| `07-project` | user | Brief and autonomy (the style pack is pinned by `init --pack neutral`, M3.1a) |
| `08-proposal` | session, proposed | "Make scene 3 tenser" (the user approves it as `p1`) |

## Prose description, for the agent trial

> Create a Cinewright project "demo" titled "Why pipelines break" with a landscape and a portrait 1080p 30 fps deliverable. Cast a narrator (English, warm mid-low timbre, neutral accent, baseline "warm, confident, unhurried", 150 wpm, pronounces Kubernetes "KOO-ber-NET-eez") and Dr Lin (a character on screen: a woman in her 40s with dry wit and a slight rasp; wry and precise; half-laughs before admissions; navy blazer, photoreal, synthetic voice). Write two lines: the narrator says "Every team hits the same wall." (measured, low, deliberate) and Dr Lin says "We rebuilt it three times." (wry, half-laugh, on screen with lip sync). Scene 3 shows why legacy pipelines break at scale, is tense and building, runs about 18 seconds synced to the voiceover, uses an orange-red accent, and has a kinetic title over data bars, then a medium close-up of Dr Lin.
