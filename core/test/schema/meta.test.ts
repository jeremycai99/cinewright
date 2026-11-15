import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import { loadSchemas } from "../../src/schema/load.js";

describe("schema files", () => {
  const schemas = loadSchemas();

  it("include at least the common, project and delivery profile schemas", () => {
    const names = [...schemas.byName.keys()];
    expect(names).toEqual(
      expect.arrayContaining([
        "common.schema.json",
        "project.schema.json",
        "delivery-profile.schema.json",
      ]),
    );
  });

  it("every schema validates against the 2020-12 meta-schema", () => {
    const ajv = new Ajv2020({ strict: false });
    for (const [name, schema] of schemas.byName) {
      const ok = ajv.validateSchema(schema);
      expect({ name, ok, errors: ajv.errors ?? null }).toEqual({ name, ok: true, errors: null });
    }
  });
});
