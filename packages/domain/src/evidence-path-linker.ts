export type PathLinkEvidenceKind =
  | "FAILING_TEST"
  | "ERROR_SIGNAL"
  | "STACK_FRAME";

export interface PathLinkSource {
  id: string;
  kind: PathLinkEvidenceKind;
  referencedPaths: readonly string[];
}

export interface PathLinkChangedFile {
  id: string;
  path: string;
}

export interface EvidencePathLink {
  fromEvidenceId: string;
  toEvidenceId: string;
  relation: "POINTS_TO_FILE";
}

export function normalizeRepoRelativePath(value: string): string | null {
  if (!value || value !== value.trim()) return null;
  if (/[\u0000-\u001f\u007f]/u.test(value)) return null;

  let path = value.replace(/\\/gu, "/");

  // Reject schemes, drive paths, drive-relative paths and alternate streams.
  if (path.includes(":") || path.startsWith("/")) return null;

  while (path.startsWith("./")) path = path.slice(2);

  const segments = path.split("/");
  if (segments.some((segment) => segment === "..")) return null;

  path = segments
    .filter((segment) => segment !== "" && segment !== ".")
    .join("/");

  return path || null;
}

export function buildExplicitPathLinks(
  sources: readonly PathLinkSource[],
  changedFiles: readonly PathLinkChangedFile[],
): EvidencePathLink[] {
  const byPath = new Map<string, PathLinkChangedFile>();
  const ambiguous = new Set<string>();

  for (const file of changedFiles) {
    const path = normalizeRepoRelativePath(file.path);
    if (!path || ambiguous.has(path)) continue;

    if (byPath.has(path)) {
      byPath.delete(path);
      ambiguous.add(path);
      continue;
    }

    byPath.set(path, file);
  }

  const links = new Map<string, EvidencePathLink>();

  for (const source of sources) {
    for (const reference of source.referencedPaths) {
      const path = normalizeRepoRelativePath(reference);
      if (!path) continue;

      const target = byPath.get(path);
      if (!target || target.id === source.id) continue;

      const key = JSON.stringify([source.id, target.id]);

      links.set(key, {
        fromEvidenceId: source.id,
        toEvidenceId: target.id,
        relation: "POINTS_TO_FILE",
      });
    }
  }

  return [...links.values()];
}

export const evidencePathLinkerInternals = {
  normalizeRepoRelativePath,
};