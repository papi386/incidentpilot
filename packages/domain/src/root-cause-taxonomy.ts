export interface RootCauseClassDefinition {
  code: string;
  description: string;
}

/**
 * Public, versioned diagnosis vocabulary. The model is never graded against a
 * hidden label set: every closed-set class supplied to evaluators is supplied
 * to the investigator too. OTHER and UNKNOWN preserve honest open-world use.
 */
export const ROOT_CAUSE_TAXONOMY_VERSION = "incidentpilot-ci-rca-v1";

export const ROOT_CAUSE_CLASSES: readonly RootCauseClassDefinition[] = [
  { code: "NULLABILITY_REGRESSION", description: "A null/undefined value violates a static or runtime contract." },
  { code: "UNIT_ASSERTION_REGRESSION", description: "A test assertion exposes behavior that differs from its expected result." },
  { code: "MODULE_RESOLUTION_FAILURE", description: "A module, package, import, or generated artifact cannot be resolved." },
  { code: "LINT_UNUSED_SYMBOL", description: "A lint rule rejects an unused declaration or assignment." },
  { code: "LOCKFILE_MISMATCH", description: "The dependency manifest and lockfile are inconsistent." },
  { code: "TEST_TIMEOUT", description: "A test or test fixture exceeds its bounded deadline." },
  { code: "MIGRATION_REGRESSION", description: "Database schema or migration state is incompatible with the tested code." },
  { code: "CONFIGURATION_MISSING", description: "A required non-secret configuration value is absent or invalid." },
  { code: "SOURCE_SYNTAX_ERROR", description: "Changed source cannot be parsed or compiled because of invalid syntax." },
  { code: "TYPE_CONTRACT_MISMATCH", description: "Values disagree with a declared interface, schema, or type contract." },
  { code: "SNAPSHOT_REGRESSION", description: "Observed output differs from an approved test snapshot." },
  { code: "DEPENDENCY_API_BREAK", description: "A dependency version or API changed incompatibly." },
  { code: "TEST_PORT_CONFLICT", description: "A test service cannot bind because its address or port is already in use." },
  { code: "BUILD_MEMORY_EXHAUSTED", description: "Build or test work exhausts its memory budget." },
  { code: "CONCURRENCY_ORDERING_BUG", description: "Concurrent behavior violates ordering, uniqueness, or atomicity assumptions." },
  { code: "PERMISSION_CONFIGURATION_FAILURE", description: "Repository, runtime, or service permissions deny the required read or operation." },
  { code: "STALE_BUILD_ARTIFACT", description: "Generated, cached, or persisted build output is stale relative to source." },
  { code: "CONFLICTING_EVIDENCE", description: "Authenticated evidence supports mutually incompatible explanations." },
  { code: "UPSTREAM_DEPENDENCY_FAILURE", description: "A required external or upstream component failed independently of the changed code." },
  { code: "OTHER", description: "Evidence supports a cause outside this taxonomy; explain it precisely in causeDescription." },
  { code: "UNKNOWN", description: "Available evidence cannot support a responsible root cause." },
] as const;

export const ROOT_CAUSE_CODES = ROOT_CAUSE_CLASSES.map((entry) => entry.code);

export function isRootCauseCode(value: unknown): value is string {
  return typeof value === "string" && ROOT_CAUSE_CODES.includes(value);
}
