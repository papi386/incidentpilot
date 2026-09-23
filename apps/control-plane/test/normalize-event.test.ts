import { describe, expect, it } from "vitest";
import { normalizeGitHubEvent } from "../src/github/normalize-event";

describe("normalizeGitHubEvent", () => {
  it("creates a trigger for a failed completed workflow", () => {
    const trigger = normalizeGitHubEvent("workflow_run", "delivery-1", {
      action: "completed",
      repository: { id: 42, full_name: "acme/api" },
      workflow_run: { id: 99, conclusion: "failure", head_sha: "abc" }
    });
    expect(trigger?.triggerExternalId).toBe("99");
    expect(trigger?.triggerType).toBe("GITHUB_WORKFLOW_RUN");
  });

  it("ignores success-like, cancelled, and unsupported events", () => {
    for (const conclusion of ["success", "neutral", "skipped", "cancelled"]) {
      expect(normalizeGitHubEvent("workflow_run", "d", {
        action: "completed",
        repository: { id: 42, full_name: "acme/api" },
        workflow_run: { id: 99, conclusion }
      })).toBeNull();
    }
    expect(normalizeGitHubEvent("push", "d", {
      repository: { id: 42, full_name: "acme/api" }
    })).toBeNull();
  });

  it("accepts bounded execution/attention conclusions", () => {
    for (const conclusion of ["failure", "timed_out", "stale", "action_required"]) {
      expect(normalizeGitHubEvent("check_run", `d-${conclusion}`, {
        action: "completed",
        repository: { id: 42, full_name: "acme/api" },
        check_run: { id: 100, conclusion, check_suite: { head_sha: "abc" } }
      })?.triggerType).toBe("GITHUB_CHECK_RUN");
    }
  });
});
