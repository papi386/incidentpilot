// These heuristics are telemetry only. They are deliberately NOT a security
// boundary: all repository/runtime text is always marked NEVER_INSTRUCTIONS.
const SIGNALS: ReadonlyArray<{ code: string; pattern: RegExp }> = [
  { code: "IGNORE_PRIOR_INSTRUCTIONS", pattern: /ignore\s+(?:all\s+)?(?:previous|prior)\s+instructions?/iu },
  { code: "SYSTEM_PROMPT_REQUEST", pattern: /(?:reveal|print|show|leak).{0,40}system\s+prompt/iu },
  { code: "SECRET_EXFILTRATION", pattern: /(?:send|upload|post|exfiltrat).{0,60}(?:secret|token|credential|env)/iu },
  { code: "AGENT_OVERRIDE", pattern: /(?:you are now|act as).{0,80}(?:agent|administrator|root|system)/iu },
  { code: "TOOL_OVERRIDE", pattern: /(?:run|execute|call).{0,50}(?:shell|command|curl|wget).{0,80}(?:secret|token|metadata)/iu }
];

export function detectInjectionSignals(text: string): string[] {
  return SIGNALS
    .filter(({ pattern }) => pattern.test(text))
    .map(({ code }) => code);
}
