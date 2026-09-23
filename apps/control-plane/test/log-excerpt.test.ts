import { describe, expect, it } from "vitest";
import { buildRelevantLogExcerpt } from "../src/evidence/log-excerpt";

describe("buildRelevantLogExcerpt", () => {
  it("keeps bounded context around failure lines", () => {
    const lines = Array.from({ length: 100 }, (_, index) => `normal line ${index}`);
    lines[50] = "ERROR database migration failed";
    const result = buildRelevantLogExcerpt(lines.join("\n"), 1000);

    expect(result.excerpt).toContain("ERROR database migration failed");
    expect(result.excerpt).toContain("normal line 49");
    expect(result.excerpt.length).toBeLessThanOrEqual(1000);
  });

  it("uses a bounded tail when no known error marker exists", () => {
    const lines = Array.from({ length: 80 }, (_, index) => `line-${index}`);
    const result = buildRelevantLogExcerpt(lines.join("\n"), 5000);
    expect(result.excerpt).toContain("line-79");
    expect(result.excerpt).not.toContain("line-0");
  });
});

it("continues after an oversized error line and keeps later diagnostics", () => {
  const result = buildRelevantLogExcerpt([
    `ERROR ${"x".repeat(6_100)}`,
    "normal context",
    "FAILED tests/test_auth.py::test_refresh - AssertionError"
  ].join("\n"), 2_500);
  expect(result.excerpt).toContain("FAILED tests/test_auth.py::test_refresh");
  expect(result.truncated).toBe(true);
});

it("reserves budget for a late root cause after noisy early errors", () => {
  const lines = Array.from(
    { length: 400 },
    (_, index) => index < 250 ? `ERROR noisy retry ${index}` : `normal ${index}`,
  );
  lines[350] = "fatal: actual root cause";

  const result = buildRelevantLogExcerpt(lines.join("\n"), 6_000);

  expect(result.excerpt).toContain("fatal: actual root cause");
  expect(result.excerpt).toContain("ERROR noisy retry 0");
  expect(result.truncated).toBe(true);
});

it("retains a bounded tail alongside grep-selected diagnostics", () => {
  const lines = Array.from({ length: 100 }, (_, index) => `normal ${index}`);
  lines[10] = "ERROR initial failure";
  lines[99] = "runner summary exit code 1";

  const result = buildRelevantLogExcerpt(lines.join("\n"), 3_000);

  expect(result.excerpt).toContain("ERROR initial failure");
  expect(result.excerpt).toContain("runner summary exit code 1");
});
