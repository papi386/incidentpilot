export interface RedactionResult {
  text: string;
  count: number;
  kinds: string[];
}

interface Rule {
  kind: string;
  pattern: RegExp;
  replacement: string;
}

const SECRET_NAME =
  /^(?:password|passwd|secret|secret[_-]?key|api[_-]?key|token|access[_-]?token|auth[_-]?token|refresh[_-]?token|github[_-]?token|npm[_-]?token|client[_-]?secret|private[_-]?key|aws[_-]?secret[_-]?access[_-]?key|session[_-]?(?:secret|token))$/iu;

const RULES: readonly Rule[] = [
  {
    kind: "PRIVATE_KEY",
    pattern:
      /-----BEGIN(?: [A-Z0-9]+)? PRIVATE KEY-----[\s\S]*?(?:-----END(?: [A-Z0-9]+)? PRIVATE KEY-----|$)/giu,
    replacement: "[REDACTED_PRIVATE_KEY]",
  },
  {
    kind: "GITHUB_TOKEN",
    pattern: /\b(?:github_pat_|gh[opusr]_)[A-Za-z0-9._-]{20,}\b/gu,
    replacement: "[REDACTED_GITHUB_TOKEN]",
  },
  {
    kind: "JWT",
    pattern:
      /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/gu,
    replacement: "[REDACTED_JWT]",
  },
  {
    kind: "AUTHORIZATION_HEADER",
    pattern:
      /(\b(?:proxy-)?authorization\s*:\s*)(?:bearer|basic|token)\s+[^\s"'<>]+/giu,
    replacement: "$1[REDACTED]",
  },
  {
    kind: "SESSION_COOKIE",
    pattern: /(\b(?:set-cookie|cookie)\s*:\s*)[^\r\n]+/giu,
    replacement: "$1[REDACTED]",
  },
  {
    kind: "AWS_ACCESS_KEY",
    pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/gu,
    replacement: "[REDACTED_AWS_ACCESS_KEY]",
  },
  {
    kind: "URL_CREDENTIALS",
    pattern:
      /((?:https?|postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis(?:s)?|amqp(?:s)?):\/\/)[^\s/@:]+:[^\s/@]+@/giu,
    replacement: "$1[REDACTED]@",
  },
  {
    kind: "COMMON_SECRET_QUOTED_ASSIGNMENT",
    // Preserve the original delimiter. Replacing ":" with "=" corrupts JSON.
    pattern:
      /(["']?)(password|passwd|secret|secret[_-]?key|api[_-]?key|token|access[_-]?token|auth[_-]?token|refresh[_-]?token|github[_-]?token|npm[_-]?token|client[_-]?secret|private[_-]?key|aws[_-]?secret[_-]?access[_-]?key|session[_-]?(?:secret|token))\1(\s*[:=]\s*)(["'])[^\r\n]*?\4/giu,
    replacement: "$1$2$1$3$4[REDACTED]$4",
  },
  {
    kind: "COMMON_SECRET_ASSIGNMENT",
    pattern:
      /\b(password|passwd|secret|secret[_-]?key|api[_-]?key|token|access[_-]?token|auth[_-]?token|refresh[_-]?token|github[_-]?token|npm[_-]?token|client[_-]?secret|aws[_-]?secret[_-]?access[_-]?key|session[_-]?(?:secret|token))\b(\s*[:=]\s*)(?!\[REDACTED)[^\s,;"']+/giu,
    replacement: "$1$2[REDACTED]",
  },
];

function isRedacted(value: string): boolean {
  return /^\[REDACTED(?:_[A-Z_]+)?\]$/u.test(value);
}

export function redactSensitiveText(input: string): RedactionResult {
  let count = 0;
  const kinds = new Set<string>();

  function redactText(text: string): string {
    let result = text;

    for (const rule of RULES) {
      // A fresh RegExp avoids sharing mutable lastIndex state.
      const pattern = new RegExp(rule.pattern.source, rule.pattern.flags);
      let matches = 0;

      result = result.replace(pattern, (...args: unknown[]) => {
        const matched = args[0];

        if (typeof matched !== "string") {
          throw new Error("REDACTION_INTERNAL_ERROR");
        }

        if (matched.includes("[REDACTED")) return matched;

        matches += 1;

        // Apply replacement captures with the same rule on this match.
        const single = new RegExp(
          rule.pattern.source,
          rule.pattern.flags.replace("g", ""),
        );

        return matched.replace(single, rule.replacement);
      });

      if (matches > 0) {
        count += matches;
        kinds.add(rule.kind);
      }
    }

    return result;
  }

  function redactJson(value: unknown, depth: number): unknown {
    if (depth > 64) {
      // Fail closed rather than returning deeply nested, uninspected content.
      throw new Error("REDACTION_JSON_DEPTH_EXCEEDED");
    }

    if (typeof value === "string") return redactText(value);

    if (Array.isArray(value)) {
      return value.map((entry) => redactJson(entry, depth + 1));
    }

    if (value !== null && typeof value === "object") {
      const result: Record<string, unknown> = Object.create(null);

      for (const [key, entry] of Object.entries(value)) {
        if (
          SECRET_NAME.test(key) &&
          entry !== null &&
          !(typeof entry === "string" && isRedacted(entry))
        ) {
          result[key] = "[REDACTED]";
          count += 1;
          kinds.add("JSON_SECRET_FIELD");
        } else {
          result[key] = redactJson(entry, depth + 1);
        }
      }

      return result;
    }

    return value;
  }

  let text: string;

  // Structured provider metadata must remain valid JSON.
  let parsed: unknown;
  let isJson = false;

  try {
    parsed = JSON.parse(input);
    isJson = true;
  } catch {
    // Ordinary logs are not JSON.
  }

  if (isJson) {
    const encoded = JSON.stringify(redactJson(parsed, 0));

    if (encoded === undefined) {
      throw new Error("REDACTION_JSON_ENCODING_FAILED");
    }

    text = encoded;
  } else {
    text = redactText(input);
  }

  return {
    text,
    count,
    kinds: [...kinds].sort(),
  };
}