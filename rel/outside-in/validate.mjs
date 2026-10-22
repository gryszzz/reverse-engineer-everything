import { readFileSync } from "node:fs";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const schema = JSON.parse(
  readFileSync(new URL("./behavior-spec.schema.json", import.meta.url), "utf8"),
);

export function validateBehaviorSpec(spec) {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  const validate = ajv.compile(schema);
  if (validate(spec)) return { ok: true, errors: [] };
  return {
    ok: false,
    errors: (validate.errors ?? []).map((error) => ({
      path: error.instancePath || "/",
      message: error.message ?? "invalid",
    })),
  };
}

export function assertValidBehaviorSpec(spec) {
  const result = validateBehaviorSpec(spec);
  if (result.ok) return spec;
  throw new Error(
    "Behavior spec failed schema validation: " +
      result.errors.map((error) => `${error.path} ${error.message}`).join("; "),
  );
}
