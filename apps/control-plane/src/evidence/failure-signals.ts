export interface FailureSignal {
  kind: "ERROR_SIGNAL" | "FAILING_TEST" | "STACK_FRAME";
  key: string;
  value: Record<string, string | number>;
}

const MAX_INPUT_CHARS = 64_000;
const MAX_LINES = 1_000;
const MAX_LINE_CHARS = 1_200;
const MAX_SIGNALS = 12;
const MAX_BLOCK_LINES = 12;
const MAX_FIELD_CHARS = 400;

interface LogLine {
  text: string;
  sourceLine: number;
}

function cleanLine(text: string): string {
  return text
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, "")
    .replace(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\s+/u,
      "",
    );
}

function location(
  path: string,
  line: string,
  column?: string,
): Record<string, string | number> {
  const lineNumber = Number(line);
  const columnNumber = column === undefined ? undefined : Number(column);

  if (!Number.isSafeInteger(lineNumber) || lineNumber <= 0) return {};

  return {
    // Preserve the provider's spelling here. The path linker decides
    // whether this is a safe, exact repository-relative reference.
    path,
    line: lineNumber,
    ...(columnNumber !== undefined &&
    Number.isSafeInteger(columnNumber) &&
    columnNumber > 0
      ? { column: columnNumber }
      : {}),
  };
}

function testHeader(
  text: string,
): Record<string, string | number> | undefined {
  const line = text.trim();

  const pytest = line.match(/^FAILED\s+(\S+::\S+)(?:\s+-|$)/u);
  if (pytest?.[1]) {
    return {
      framework: "pytest",
      test: pytest[1],
      path: pytest[1].split("::")[0]!,
    };
  }

  const go = line.match(/^--- FAIL:\s+([^\s(]+)/u);
  if (go?.[1]) {
    return { framework: "go-test", test: go[1] };
  }

  const node = line.match(/^not ok\s+\d+\s+-\s+(.+)$/u);
  if (node?.[1]) {
    return { framework: "node-test", test: node[1] };
  }

  const vitest = line.match(/^FAIL\s+(\S+\.[cm]?[jt]sx?)\s+>\s+(.+)$/u);
  if (vitest?.[1] && vitest[2]) {
    return {
      framework: "vitest",
      path: vitest[1],
      test: vitest[2],
    };
  }

  const rust = line.match(/^test\s+(\S+)\s+\.\.\.\s+FAILED$/u);
  if (rust?.[1]) {
    return { framework: "cargo-test", test: rust[1] };
  }

  return undefined;
}

function diagnostic(
  text: string,
): Record<string, string | number> | undefined {
  const line = text.trim();

  const compiler = line.match(
    /^(.+?\.(?:[cm]?[jt]sx?|go|rs|java|c|cc|cpp|h|hpp))(?::(\d+)(?::(\d+))?|\((\d+),(\d+)\)):\s*(?:fatal\s+)?error(?:\s+([A-Z]+\d+))?:\s*(.+)$/u,
  );

  if (compiler?.[1] && compiler[7]) {
    return {
      diagnosticKind: "compiler",
      message: compiler[7],
      ...location(
        compiler[1],
        compiler[2] ?? compiler[4]!,
        compiler[3] ?? compiler[5],
      ),
      ...(compiler[6] ? { errorCode: compiler[6] } : {}),
    };
  }

  const python = line.match(
    /^(?:E\s+)?((?:[A-Za-z_]\w*\.)*(?:[A-Za-z_]\w*)?(?:Error|Exception)|KeyboardInterrupt|SystemExit):\s*(.*)$/u,
  );

  if (python?.[1]) {
    return {
      exception: python[1],
      message: python[2] || python[1],
    };
  }

  const panic = line.match(/^(panic|fatal):\s*(.+)$/u);
  if (panic?.[1] && panic[2]) {
    return { exception: panic[1], message: panic[2] };
  }

  const rust = line.match(
    /^thread\s+'[^']+'\s+panicked at\s+(.+):(\d+):(\d+):?$/u,
  );
  if (rust?.[1] && rust[2] && rust[3]) {
    return {
      exception: "panic",
      message: line,
      ...location(rust[1], rust[2], rust[3]),
    };
  }

  const goAssertion = line.match(
    /^([^:\s]+\.go):(\d+):\s*(.+)$/u,
  );
  if (goAssertion?.[1] && goAssertion[2] && goAssertion[3]) {
    return {
      diagnosticKind: "go-test-output",
      message: goAssertion[3],
      ...location(goAssertion[1], goAssertion[2]),
    };
  }

  const generic = line.match(
    /^(?:ERROR|Error|Exception|npm ERR!)(?::|\s)\s*(.+)$/u,
  );
  if (generic?.[1]) return { message: generic[1] };

  return undefined;
}

function frames(text: string): Record<string, string | number>[] {
  const result: Record<string, string | number>[] = [];

  const python = text.match(
    /^\s*File\s+"([^"]+)",\s+line\s+(\d+),\s+in\s+(\S+)/u,
  );
  if (python?.[1] && python[2] && python[3]) {
    result.push({
      language: "python",
      ...location(python[1], python[2]),
      symbol: python[3],
    });
  }

  const js = text.match(
    /^\s*at\s+(?:(.*?)\s+\()?([^\s()]+\.[cm]?[jt]sx?):(\d+):(\d+)\)?\s*$/u,
  );
  if (js?.[2] && js[3] && js[4]) {
    result.push({
      language: "javascript-typescript",
      ...location(js[2], js[3], js[4]),
      ...(js[1] ? { symbol: js[1].trim() } : {}),
    });
  }

  const go = text.match(/^\s*([^\s:]+\.go):(\d+)(?::(\d+))?/u);
  if (go?.[1] && go[2]) {
    result.push({
      language: "go",
      ...location(go[1], go[2], go[3]),
    });
  }

  return result.filter((frame) => typeof frame.path === "string");
}

export function extractFailureSignals(text: string): FailureSignal[] {
  let truncated = text.length > MAX_INPUT_CHARS;
  const rawLines = text
    .slice(0, MAX_INPUT_CHARS)
    .replace(/\r\n?/gu, "\n")
    .split("\n");

  truncated ||= rawLines.length > MAX_LINES;

  const lines: LogLine[] = rawLines.slice(0, MAX_LINES).map((raw, index) => {
    truncated ||= raw.length > MAX_LINE_CHARS;

    const clipped = raw.slice(0, MAX_LINE_CHARS);

    // buildRelevantLogExcerpt() prefixes lines with their original numbers.
    const numbered = clipped.match(/^(\d+): (.*)$/u);

    return {
      sourceLine: numbered ? Number(numbered[1]) : index + 1,
      text: cleanLine(numbered ? numbered[2]! : clipped),
    };
  });

  const signals: FailureSignal[] = [];
  const seen = new Set<string>();

  function add(
    kind: FailureSignal["kind"],
    value: Record<string, string | number>,
    start: number,
    end = start,
  ) {
    const bounded: Record<string, string | number> = {};

    for (const [name, field] of Object.entries(value)) {
      if (typeof field === "string") {
        truncated ||= field.length > MAX_FIELD_CHARS;
        bounded[name] = field.slice(0, MAX_FIELD_CHARS);
      } else {
        bounded[name] = field;
      }
    }

    bounded.parserVersion = 2;
    bounded.sourceLineStart = start;
    bounded.sourceLineEnd = end;

    const key = `${kind}:${JSON.stringify(bounded)}`;
    if (seen.has(key)) return;
    seen.add(key);

    if (signals.length >= MAX_SIGNALS) {
      truncated = true;
      return;
    }

    signals.push({ kind, key, value: bounded });
  }

  for (let index = 0; index < lines.length; index += 1) {
    const current = lines[index]!;
    const header = testHeader(current.text);

    if (header) {
      add("FAILING_TEST", header, current.sourceLine);
    }

    for (const frame of frames(current.text)) {
      add("STACK_FRAME", frame, current.sourceLine);
    }

    const error = diagnostic(current.text);
    if (!error) continue;

    let end = current.sourceLine;
    const values: Record<string, string | number> = { ...error };

    // Capture only explicit Expected/Actual/Received fields in the
    // contiguous diagnostic block. Never bridge omitted excerpt lines.
    for (
      let nextIndex = index + 1;
      nextIndex < Math.min(lines.length, index + MAX_BLOCK_LINES);
      nextIndex += 1
    ) {
      const previous = lines[nextIndex - 1]!;
      const next = lines[nextIndex]!;

      if (next.sourceLine !== previous.sourceLine + 1) break;
      if (!next.text.trim()) break;
      if (testHeader(next.text) || diagnostic(next.text)) break;

      const field = next.text.match(
        /^\s*(Expected|Actual|Received):\s*(.+)$/iu,
      );

      if (field?.[1] && field[2]) {
        const name =
          field[1].toLowerCase() === "expected" ? "expected" : "actual";

        // Repeated fields are ambiguous; don't silently overwrite them.
        if (values[name] !== undefined) break;

        values[name] = field[2];
        end = next.sourceLine;
      }
    }

    add("ERROR_SIGNAL", values, current.sourceLine, end);
  }

  if (truncated && signals.length > 0) {
    signals[signals.length - 1]!.value.parserTruncated = 1;
  }

  return signals;
}