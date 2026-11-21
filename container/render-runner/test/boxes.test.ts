import { describe, expect, it } from "vitest";
import { READ_BOXES, type TextBox } from "../src/boxes.js";

/** A minimal element: a tag, an id, child elements and text, and a fixed rect. */
function el(
  tag: string,
  opts: { id?: string; text?: string; fontSize?: string; children?: object[] },
) {
  const node: Record<string, unknown> = {
    tagName: tag.toUpperCase(),
    id: opts.id ?? "",
    children: opts.children ?? [],
    parentElement: null,
    fontSize: opts.fontSize ?? "16px",
    childNodes: [
      ...(opts.text ? [{ nodeType: 3, textContent: opts.text }] : []),
      ...((opts.children ?? []) as object[]),
    ],
    getBoundingClientRect: () => ({ x: 10, y: 20, width: 300.123, height: 40 }),
  };
  for (const child of opts.children ?? []) (child as Record<string, unknown>).parentElement = node;
  node.querySelectorAll = () => {
    const all: object[] = [];
    const walk = (n: Record<string, unknown>) => {
      for (const c of n.children as Record<string, unknown>[]) {
        all.push(c);
        walk(c);
      }
    };
    walk(node);
    return all;
  };
  return node;
}

describe("READ_BOXES (M6.1a)", () => {
  it("reports each text box's computed font size in px", () => {
    const title = el("h1", { text: "Hello", fontSize: "36.456px" });
    const layer = el("div", { id: "cw-s01.sh01.title", children: [title] });
    const globals = {
      document: { querySelectorAll: () => [layer] },
      getComputedStyle: (e: { fontSize: string }) => ({
        visibility: "visible",
        display: "block",
        fontSize: e.fontSize,
      }),
      CSS: { escape: (s: string) => s.replace(/\./g, "\\.") },
    };
    const run = new Function(...Object.keys(globals), `return ${READ_BOXES};`);
    const boxes = run(...Object.values(globals)) as TextBox[];
    expect(boxes).toEqual([
      {
        layer: "s01.sh01.title",
        selector: "#cw-s01\\.sh01\\.title > h1:nth-of-type(1)",
        text: "Hello",
        x: 10,
        y: 20,
        width: 300.12,
        height: 40,
        font_size: 36.46,
      },
    ]);
  });
});
