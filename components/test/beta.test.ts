import { loadCatalog } from "@cinewright/core";
import { describe, expect, it } from "vitest";
import { catalogDir } from "../src/catalog-dir.js";
import { chartScale } from "../src/chart/scale.js";
import { focusOrigin } from "../src/plate/focus.js";

describe("chartScale", () => {
  it("maps the largest value to the box height minus the label band", () => {
    expect(chartScale([[2, 4]], 400, 40)).toEqual([[180, 360]]);
    expect(
      chartScale(
        [
          [1, 2],
          [4, 0],
        ],
        340,
        40,
      ),
    ).toEqual([
      [75, 150],
      [300, 0],
    ]);
  });

  it("draws nothing for an all-zero chart", () => {
    expect(chartScale([[0, 0]], 400, 40)).toEqual([[0, 0]]);
  });
});

describe("chart props", () => {
  const validate = loadCatalog(catalogDir).propValidator("chart", "series");
  const series = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ label: `s${i}`, values: [1] }));

  it("accepts up to six series (one per data colour) and rejects seven", () => {
    expect(validate?.(series(6))).toBe(true);
    expect(validate?.(series(7))).toBe(false);
  });
});

describe("focusOrigin", () => {
  it("centres Ken Burns by default and follows the focus point", () => {
    expect(focusOrigin(undefined)).toBe("50% 50%");
    expect(focusOrigin({ x: 0.25, y: 0.75 })).toBe("25% 75%");
  });
});
