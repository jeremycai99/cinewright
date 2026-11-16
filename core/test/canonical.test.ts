import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { sha256Hash, toHashForm } from "../src/canonical/hash.js";
import { toStoredForm } from "../src/canonical/stored.js";

interface Vectors {
  numbers: { hex: string; expected: string }[];
  documents: { name: string; input: string; expected: string }[];
  errors: { name: string; input: string }[];
}

const vectors = JSON.parse(
  readFileSync(fileURLToPath(new URL("./fixtures/jcs/vectors.json", import.meta.url)), "utf8"),
) as Vectors;

function double(hex: string): number {
  const view = new DataView(new ArrayBuffer(8));
  view.setBigUint64(0, BigInt(`0x${hex}`));
  return view.getFloat64(0);
}

/** Every object's keys, in the order a serialization lists them. */
function keyOrder(text: string): string[][] {
  const orders: string[][] = [];
  JSON.parse(text, function (this: unknown, _key, value) {
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      orders.push(Object.keys(value));
    }
    return value;
  });
  return orders;
}

describe("hash form (RFC 8785)", () => {
  for (const { hex, expected } of vectors.numbers) {
    it(`formats 0x${hex} as ${expected}`, () => {
      expect(toHashForm(double(hex))).toBe(expected);
    });
  }

  for (const { name, input, expected } of vectors.documents) {
    it(`reproduces vector: ${name}`, () => {
      expect(toHashForm(JSON.parse(input))).toBe(expected);
    });
  }

  for (const { name, input } of vectors.errors) {
    it(`rejects ${name}`, () => {
      expect(() => toHashForm(JSON.parse(input))).toThrow();
    });
  }

  it("rejects NaN and Infinity", () => {
    expect(() => toHashForm({ a: Number.NaN })).toThrow();
    expect(() => toHashForm([Number.POSITIVE_INFINITY])).toThrow();
  });

  it("hashes the hash form with SHA-256, whatever the key order", () => {
    const expected = `sha256:${createHash("sha256").update('{"a":[true],"b":1}').digest("hex")}`;
    expect(sha256Hash({ b: 1, a: [true] })).toBe(expected);
    expect(sha256Hash({ a: [true], b: 1 })).toBe(expected);
  });
});

describe("stored form", () => {
  it("is pretty-printed with sorted keys and one trailing newline", () => {
    expect(toStoredForm({ b: [1, { d: null, c: "x" }], a: {}, e: [] })).toBe(
      '{\n  "a": {},\n  "b": [\n    1,\n    {\n      "c": "x",\n      "d": null\n    }\n  ],\n  "e": []\n}\n',
    );
  });

  it("sorts keys in the same order as the hash form, including non-ASCII and emoji keys", () => {
    const value = {
      東京: { z: 1, Z: 2, Zoë: 3 },
      "🚀 launch": [{ ö: 1, "€": 2, "\r": 3, "1": 4, "😀": 5, דּ: 6 }],
      zoe: true,
      Zoë: false,
      "\u0080": null,
    };
    expect(keyOrder(toStoredForm(value))).toEqual(keyOrder(toHashForm(value)));
  });

  it("formats numbers and strings exactly as the hash form does", () => {
    for (const { input } of vectors.documents) {
      const value = JSON.parse(input);
      expect(toHashForm(JSON.parse(toStoredForm(value)))).toBe(toHashForm(value));
    }
    expect(toStoredForm([1e21, -0, 0.1, "a b"])).toBe('[\n  1e+21,\n  0,\n  0.1,\n  "a b"\n]\n');
  });

  it("rejects values the hash form rejects", () => {
    expect(() => toStoredForm({ a: Number.NaN })).toThrow();
    expect(() => toStoredForm("\ud800")).toThrow();
    expect(() => toStoredForm({ a: undefined })).toThrow();
  });
});
