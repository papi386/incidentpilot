import type {
  OutputEnvelope,
  OutputStructureDiagnostics,
} from "./types";

const EXPECTED_FIELDS = [
  "outcome",
  "summary",
  "hypotheses",
  "recommendedChecks",
  "limitations",
] as const;

function valueType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function parseEnvelope(output: unknown): {
  envelope: OutputEnvelope;
  value: unknown;
} {
  if (output === null || output === undefined) {
    return { envelope: "NO_OUTPUT", value: output };
  }

  if (typeof output === "string") {
    if (output.length > 64 * 1024) {
      return { envelope: "NON_JSON_STRING", value: null };
    }

    try {
      const parsed: unknown = JSON.parse(output);
      if (parsed !== null && typeof parsed === "object") {
        return {
          envelope: Array.isArray(parsed) ? "JSON_ARRAY" : "JSON_OBJECT",
          value: parsed,
        };
      }
      return { envelope: "JSON_PRIMITIVE", value: parsed };
    } catch {
      return { envelope: "NON_JSON_STRING", value: null };
    }
  }

  if (typeof output === "object") {
    return {
      envelope: Array.isArray(output) ? "JSON_ARRAY" : "JSON_OBJECT",
      value: output,
    };
  }

  return { envelope: "NON_JSON_VALUE", value: output };
}

/**
 * Reports only contract field presence and value types. Unknown field names
 * and all model-provided values are deliberately excluded.
 */
export function diagnoseOutputStructure(
  output: unknown,
): OutputStructureDiagnostics {
  const parsed = parseEnvelope(output);
  const record = parsed.envelope === "JSON_OBJECT"
    ? parsed.value as Record<string, unknown>
    : null;
  const recognizedFields = record
    ? EXPECTED_FIELDS.filter((field) =>
        Object.prototype.hasOwnProperty.call(record, field)
      )
    : [];
  const recognized = new Set<string>(recognizedFields);

  return {
    envelope: parsed.envelope,
    recognizedFields: [...recognizedFields],
    missingRequiredFields: EXPECTED_FIELDS.filter(
      (field) => !recognized.has(field),
    ),
    unexpectedFieldCount: record
      ? Object.keys(record).filter(
          (field) => !(EXPECTED_FIELDS as readonly string[]).includes(field),
        ).length
      : 0,
    fieldTypes: record
      ? Object.fromEntries(
          recognizedFields.map((field) => [field, valueType(record[field])]),
        )
      : {},
  };
}
