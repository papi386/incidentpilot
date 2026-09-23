const HIGH_SIGNAL = /(?:\bFAIL(?:ED|URE)?\b|\bERROR\b|\bException\b|\bTraceback\b|\bpanic:|\bfatal:|assert(?:ion)?\s*(?:failed|error)|npm ERR!|error TS\d+|undefined reference|segmentation fault)/iu;
const MAX_LINE_CHARS = 1_200;

export interface LogExcerptResult {
  excerpt: string;
  selectedLineCount: number;
  truncated: boolean;
}

export function buildRelevantLogExcerpt(input: string, maxChars = 6_000): LogExcerptResult {
  const normalized = input.replace(/\r\n/gu, "\n").replace(/\r/gu, "\n");
  const lines = normalized.split("\n");
  const selected = new Set<number>();
  const signalLines: number[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    if (!HIGH_SIGNAL.test(lines[index] ?? "")) continue;
    signalLines.push(index);
    for (let cursor = Math.max(0, index - 2); cursor <= Math.min(lines.length - 1, index + 4); cursor += 1) {
      selected.add(cursor);
    }
  }

  if (signalLines.length === 0) {
    const start = Math.max(0, lines.length - 50);
    for (let index = start; index < lines.length; index += 1) selected.add(index);
  } else {
    // A small tail is retained even when grep-like markers exist. CI runners
    // commonly print the decisive summary only at the end of a noisy log.
    const start = Math.max(0, lines.length - 24);
    for (let index = start; index < lines.length; index += 1) selected.add(index);
  }

  const priority = new Set<number>();
  const addWindow = (center: number) => {
    for (
      let cursor = Math.max(0, center - 2);
      cursor <= Math.min(lines.length - 1, center + 4);
      cursor += 1
    ) priority.add(cursor);
  };

  // Reserve space for both ends of the diagnostic sequence before filling in
  // other matches. This prevents thousands of early retry errors from
  // consuming the entire budget before a late fatal/root-cause line.
  const firstSignal = signalLines[0];
  const lastSignal = signalLines.at(-1);
  if (lastSignal !== undefined) addWindow(lastSignal);
  if (firstSignal !== undefined) addWindow(firstSignal);
  const tailStart = Math.max(0, lines.length - 24);
  for (let index = tailStart; index < lines.length; index += 1) priority.add(index);
  for (const index of [...signalLines].reverse()) addWindow(index);
  for (const index of selected) priority.add(index);

  const retained: number[] = [];
  let length = 0;
  let truncated = false;

  for (const index of priority) {
    const raw = lines[index] ?? "";
    const clipped = raw.length > MAX_LINE_CHARS
      ? `${raw.slice(0, MAX_LINE_CHARS)}…[line truncated]`
      : raw;
    if (clipped.length !== raw.length) truncated = true;

    const line = `${index + 1}: ${clipped}`;
    const remaining = maxChars - length;
    if (remaining <= 1) {
      truncated = true;
      break;
    }

    if (line.length + 1 > remaining) {
      // Do not let one pathological line discard later short diagnostics.
      truncated = true;
      continue;
    }

    retained.push(index);
    length += line.length + 1;
  }

  const retainedSet = new Set(retained);
  const output = [...retainedSet]
    .sort((a, b) => a - b)
    .map((index) => {
      const raw = lines[index] ?? "";
      const clipped = raw.length > MAX_LINE_CHARS
        ? `${raw.slice(0, MAX_LINE_CHARS)}…[line truncated]`
        : raw;
      return `${index + 1}: ${clipped}`;
    });

  return {
    excerpt: output.join("\n"),
    selectedLineCount: output.length,
    truncated: truncated || retainedSet.size < selected.size
  };
}
