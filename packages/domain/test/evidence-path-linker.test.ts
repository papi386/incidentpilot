import {
  describe,
  expect,
  it,
} from "vitest";

import {
  buildExplicitPathLinks,
  evidencePathLinkerInternals,
} from "../src/evidence-path-linker";

describe("evidence path linker", () => {
  it("links an explicit normalized repository-relative path", () => {
    const links =
      buildExplicitPathLinks(
        [
          {
            id: "failure-1",
            kind: "STACK_FRAME",
            referencedPaths: [
              "./src/calculator.py",
            ],
          },
        ],
        [
          {
            id: "file-1",
            path: "src/calculator.py",
          },
        ],
      );

    expect(links).toEqual([
      {
        fromEvidenceId:
          "failure-1",

        toEvidenceId:
          "file-1",

        relation:
          "POINTS_TO_FILE",
      },
    ]);
  });

  it("normalizes Windows separators without accepting absolute drive paths", () => {
    const links =
      buildExplicitPathLinks(
        [
          {
            id: "failure-1",
            kind: "ERROR_SIGNAL",
            referencedPaths: [
              "src\\calculator.py",
            ],
          },
        ],
        [
          {
            id: "file-1",
            path: "src/calculator.py",
          },
        ],
      );

    expect(links).toHaveLength(1);

    expect(
      evidencePathLinkerInternals
        .normalizeRepoRelativePath(
          "C:\\repo\\src\\calculator.py",
        ),
    ).toBeNull();
  });

  it("does not link unrelated files", () => {
    const links =
      buildExplicitPathLinks(
        [
          {
            id: "failure-1",
            kind: "FAILING_TEST",
            referencedPaths: [
              "tests/test_calculator.py",
            ],
          },
        ],
        [
          {
            id: "file-1",
            path: "calculator.py",
          },
        ],
      );

    expect(links).toEqual([]);
  });

  it("does not infer by basename", () => {
    const links =
      buildExplicitPathLinks(
        [
          {
            id: "failure-1",
            kind: "STACK_FRAME",
            referencedPaths: [
              "index.ts",
            ],
          },
        ],
        [
          {
            id: "file-a",
            path: "src/index.ts",
          },
          {
            id: "file-b",
            path: "test/index.ts",
          },
        ],
      );

    expect(links).toEqual([]);
  });

  it("rejects path traversal", () => {
    const links =
      buildExplicitPathLinks(
        [
          {
            id: "failure-1",
            kind: "STACK_FRAME",
            referencedPaths: [
              "../calculator.py",
            ],
          },
        ],
        [
          {
            id: "file-1",
            path: "calculator.py",
          },
        ],
      );

    expect(links).toEqual([]);
  });

  it("rejects absolute and URL paths", () => {
    const normalize =
      evidencePathLinkerInternals
        .normalizeRepoRelativePath;

    expect(
      normalize("/etc/passwd"),
    ).toBeNull();

    expect(
      normalize(
        "C:\\repo\\calculator.py",
      ),
    ).toBeNull();

    expect(
      normalize(
        "https://example.com/calculator.py",
      ),
    ).toBeNull();
  });

  it("deduplicates identical links", () => {
    const links =
      buildExplicitPathLinks(
        [
          {
            id: "failure-1",
            kind: "STACK_FRAME",
            referencedPaths: [
              "src/calculator.py",
              "./src/calculator.py",
            ],
          },
        ],
        [
          {
            id: "file-1",
            path: "src/calculator.py",
          },
        ],
      );

    expect(links).toEqual([
      {
        fromEvidenceId:
          "failure-1",

        toEvidenceId:
          "file-1",

        relation:
          "POINTS_TO_FILE",
      },
    ]);
  });
});