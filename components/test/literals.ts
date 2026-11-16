/** A literal design value found in component source (the M2 literal lint). */
export interface Finding {
  file: string;
  line: number;
  category: "color" | "font" | "easing" | "time" | "duration" | "length";
  text: string;
}

const NAMED_COLORS = new Set(
  (
    "aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet " +
    "brown burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue " +
    "darkcyan darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange " +
    "darkorchid darkred darksalmon darkseagreen darkslateblue darkslategray darkslategrey darkturquoise " +
    "darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia " +
    "gainsboro ghostwhite gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo " +
    "ivory khaki lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan " +
    "lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue " +
    "lightslategray lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon " +
    "mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue " +
    "mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin " +
    "navajowhite navy oldlace olive olivedrab orange orangered orchid palegoldenrod palegreen " +
    "paleturquoise palevioletred papayawhip peachpuff peru pink plum powderblue purple rebeccapurple red " +
    "rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue slateblue " +
    "slategray slategrey snow springgreen steelblue tan teal thistle tomato turquoise violet wheat white " +
    "whitesmoke yellow yellowgreen"
  ).split(" "),
);

const ALLOW = /\/\*\s*cw-allow-literal:\s*(\S[^*]*)\*\//;
/**
 * In CSS every rule reads the whole line. In TypeScript, value rules (`scope: "string"`) read only
 * string and template literal contents, and code rules read the code (`duration: 400`).
 */
const RULES: {
  category: Finding["category"];
  pattern: RegExp;
  scope: "any" | "string" | "code";
  css?: boolean;
}[] = [
  { category: "color", pattern: /#[0-9a-fA-F]{3,8}\b/, scope: "string" },
  {
    category: "color",
    pattern: /\b(rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(/,
    scope: "string",
  },
  { category: "font", pattern: /font-family\s*:(?!\s*var\()/, scope: "any", css: true },
  { category: "font", pattern: /fontFamily\s*[:=]\s*["'`](?!var\()/, scope: "code" },
  { category: "easing", pattern: /\b(cubic-bezier|steps|linear)\(/, scope: "string" },
  {
    category: "easing",
    pattern:
      /(timing-function|transition|animation)\s*:[^;]*\b(ease|ease-in|ease-out|ease-in-out|linear|step-start|step-end)\b/,
    scope: "any",
    css: true,
  },
  {
    category: "easing",
    pattern: /\beasing\s*:\s*["'`](ease|ease-in|ease-out|ease-in-out|linear)\b/,
    scope: "code",
  },
  { category: "time", pattern: /(?<![\w.-])(?!0+(\.0+)?m?s\b)\d*\.?\d+m?s\b/, scope: "string" },
  {
    category: "duration",
    pattern: /\b(duration|delay|endDelay)\s*:\s*(?!0\b)\d*\.?\d+\b/,
    scope: "code",
  },
  {
    category: "length",
    pattern:
      /(?<![\w.-])(?!0+(\.0+)?(px|rem|em|pt|vh|vw|vmin|vmax)\b)\d*\.?\d+(px|rem|em|pt|vh|vw|vmin|vmax)\b/,
    scope: "string",
  },
];

const STRINGS = /"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`[^`]*`/g;

/** Replace comments with spaces, keeping line breaks so line numbers stay right. */
function stripComments(text: string, ts: boolean): string {
  const blank = (s: string) => s.replace(/[^\n]/g, " ");
  let out = text.replace(/\/\*[\s\S]*?\*\//g, blank);
  if (ts)
    out = out.replace(
      /(^|[^:"'`\\])\/\/[^\n]*/g,
      (m, lead: string) => lead + blank(m.slice(lead.length)),
    );
  return out;
}

/** Literal design values in one component source file; `allowed` lists exempted lines. */
export function scanLiterals(
  text: string,
  file: string,
): { findings: Finding[]; allowed: { line: number; reason: string }[] } {
  const ts = file.endsWith(".ts");
  const allowed: { line: number; reason: string }[] = [];
  const original = text.split("\n");
  const lines = stripComments(text, ts).split("\n");
  const findings: Finding[] = [];
  lines.forEach((line, i) => {
    const allow = ALLOW.exec(original[i] ?? "");
    if (allow?.[1]?.trim()) {
      allowed.push({ line: i + 1, reason: allow[1].trim() });
      return;
    }
    const strings = ts ? (line.match(STRINGS) ?? []).join(" ") : line;
    for (const rule of RULES) {
      if (rule.css && ts) continue;
      if (!ts && rule.scope === "code") continue;
      const target = ts && rule.scope === "string" ? strings : line;
      const match = rule.pattern.exec(target);
      if (match) findings.push({ file, line: i + 1, category: rule.category, text: match[0] });
    }
    const named = ts
      ? [...line.matchAll(/["'`]([a-z]+)["'`]/g)].map((m) => m[1])
      : [...(line.match(/:\s*([^;]*)/)?.[1]?.matchAll(/\b([a-z]+)\b/g) ?? [])].map((m) => m[1]);
    for (const word of named) {
      if (word && NAMED_COLORS.has(word)) {
        findings.push({ file, line: i + 1, category: "color", text: word });
        break;
      }
    }
  });
  return { findings, allowed };
}
