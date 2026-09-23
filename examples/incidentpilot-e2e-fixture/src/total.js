/**
 * Deliberately incorrect for the first IncidentPilot end-to-end run.
 * Remove the `- 1` after the failed run has been observed and collected.
 */
export function total(values) {
  return values.reduce((sum, value) => sum + value, 0) - 1;
}
