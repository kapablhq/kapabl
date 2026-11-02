// SPDX-License-Identifier: Apache-2.0
// JSON Schema 2020-12 from observed JSON values. Deliberately simple and deterministic:
// types are unioned, object properties merged, a property is required only when every
// sample had it, and array items are inferred from all items together.

const MAX_DEPTH = 8;
const MAX_PROPERTIES = 200;

type Schema = Record<string, unknown>;

function typeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  return typeof value;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
/** RFC 3339 `date-time`: seconds and a zone are required. */
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

function stringFormat(values: string[]): string | undefined {
  if (values.length === 0) return undefined;
  if (values.every((v) => DATE_TIME.test(v))) return "date-time";
  if (values.every((v) => DATE.test(v))) return "date";
  return undefined;
}

export function inferSchema(samples: readonly unknown[], depth = 0): Schema {
  const values = samples.filter((v) => v !== undefined);
  if (values.length === 0 || depth > MAX_DEPTH) return {};
  const types = new Set(values.map(typeOf));
  // An integer seen next to a fractional number is just a number.
  if (types.has("integer") && types.has("number")) types.delete("integer");

  const schema: Schema = {};
  const sorted = [...types].sort();
  schema.type = sorted.length === 1 ? sorted[0] : sorted;

  if (types.has("object")) {
    const objects = values.filter((v) => typeOf(v) === "object") as Record<string, unknown>[];
    // `__proto__` cannot be a plain property, and the graph's canonical JSON refuses it.
    const keys = [...new Set(objects.flatMap((o) => Object.keys(o)))]
      .filter((k) => k !== "__proto__")
      .sort()
      .slice(0, MAX_PROPERTIES);
    const properties: Record<string, Schema> = {};
    for (const key of keys) {
      properties[key] = inferSchema(
        objects.map((o) => o[key]),
        depth + 1,
      );
    }
    schema.properties = properties;
    const required = keys.filter((k) => objects.every((o) => Object.hasOwn(o, k)));
    if (required.length > 0) schema.required = required;
  }
  if (types.has("array")) {
    const items = (values.filter(Array.isArray) as unknown[][]).flat();
    schema.items = items.length > 0 ? inferSchema(items, depth + 1) : {};
  }
  if (types.has("string")) {
    const format = stringFormat(values.filter((v): v is string => typeof v === "string"));
    if (format) schema.format = format;
  }
  return schema;
}

/**
 * Whether a query value is a number that survives a round trip: no leading zeros (a zip
 * code like 00501 is a string) and at most 15 significant digits.
 */
function numeric(value: string, integer: boolean): boolean {
  const pattern = integer ? /^-?(?:0|[1-9]\d*)$/ : /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/;
  return pattern.test(value) && value.replace(/\D/g, "").replace(/^0+/, "").length <= 15;
}

/** Infer a scalar parameter's schema from its observed string values (query strings). */
export function inferParamSchema(values: readonly string[]): Schema {
  if (values.length > 0 && values.every((v) => numeric(v, true))) return { type: "integer" };
  if (values.length > 0 && values.every((v) => numeric(v, false))) return { type: "number" };
  if (values.length > 0 && values.every((v) => v === "true" || v === "false"))
    return { type: "boolean" };
  const format = stringFormat([...values]);
  return format ? { type: "string", format } : { type: "string" };
}
