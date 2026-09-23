import type { Context } from "hono";
import { IncidentService } from "@incidentpilot/domain";
import type { AppBindings } from "../bindings";
import { D1AuditLog } from "../adapters/d1-audit-log";
import { D1IncidentStore } from "../adapters/d1-incident-store";
import { D1RuntimeControlStore } from "../adapters/d1-runtime-control-store";
import { D1WebhookDeliveryStore } from "../adapters/d1-webhook-delivery-store";
import { CloudflareWorkflowEngine } from "../adapters/cloudflare-workflow-engine";
import { routeGitHubSource } from "../github/source-router";
import { verifyGitHubSignature } from "../security/github-signature";
import { decodeUtf8Strict, readRequestBodyLimited, RequestBodyError } from "../security/request-body";
import { classifyD1ResourceExhaustion } from "../security/d1-errors";
import { sha256Hex } from "../security/sha256";

const MAX_WEBHOOK_BYTES = 1024 * 1024;
const SUPPORTED_EVENTS = new Set(["workflow_run", "check_run"]);
const DELIVERY_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/u;

export async function githubWebhookRoute(c: Context<{ Bindings: AppBindings }>) {
  const signature = c.req.header("X-Hub-Signature-256") ?? null;
  const deliveryId = c.req.header("X-GitHub-Delivery");
  const eventName = c.req.header("X-GitHub-Event");
  const contentType = c.req.header("Content-Type") ?? "";

  if (!deliveryId || !eventName) {
    return c.json({ error: "missing required GitHub delivery headers" }, 400);
  }
  if (!DELIVERY_ID_PATTERN.test(deliveryId)) {
    return c.json({ error: "invalid GitHub delivery id" }, 400);
  }
  if (!contentType.toLowerCase().startsWith("application/json")) {
    return c.json({ error: "unsupported webhook content type" }, 415);
  }

  let rawBytes: Uint8Array;
  try {
    rawBytes = await readRequestBodyLimited(c.req.raw, MAX_WEBHOOK_BYTES);
  } catch (error) {
    if (error instanceof RequestBodyError && error.code === "BODY_TOO_LARGE") {
      return c.json({ error: "webhook payload too large" }, 413);
    }
    return c.json({ error: "invalid webhook request body" }, 400);
  }

  // Authenticate the exact received bytes before parsing or expensive work.
  const valid = await verifyGitHubSignature(rawBytes, signature, c.env.GITHUB_WEBHOOK_SECRET);
  if (!valid) return c.json({ error: "invalid webhook signature" }, 401);

  if (!SUPPORTED_EVENTS.has(eventName)) {
    return c.json({ accepted: false, reason: "event is unsupported" }, 202);
  }

  try {
    const controls = new D1RuntimeControlStore(c.env.DB);
    if (!await controls.isEnabled("webhook_ingestion_enabled")) {
      return c.json({ accepted: false, reason: "webhook ingestion disabled" }, 503);
    }

    const bodySha256 = await sha256Hex(rawBytes);
    const deliveries = new D1WebhookDeliveryStore(c.env.DB);
    const claim = await deliveries.claim(deliveryId, eventName, bodySha256);
    if (claim.status === "CONFLICT") {
      console.warn(JSON.stringify({
        event: "webhook_delivery_conflict",
        provider: "github",
        deliveryId,
        eventName
      }));
      return c.json({ error: "webhook delivery conflict" }, 409);
    }
    if (claim.status === "ALREADY_PROCESSED") {
      return c.json({
        accepted: claim.disposition !== "REJECTED",
        incidentId: claim.incidentId,
        duplicate: true,
        disposition: claim.disposition,
        reason: claim.reason,
        workflowId: claim.incidentId ? `incident-${claim.incidentId}` : null
      }, 200);
    }

    let rawBody: string;
    let payload: Record<string, unknown>;
    try {
      rawBody = decodeUtf8Strict(rawBytes);
      payload = JSON.parse(rawBody) as Record<string, unknown>;
    } catch {
      return c.json({ error: "invalid JSON payload" }, 400);
    }

    const route = await routeGitHubSource(c.env.DB, eventName, deliveryId, payload);
    const decision = await deliveries.recordRouting(deliveryId, bodySha256, route);
    if (decision.disposition !== "CANONICAL_TRIGGER" && decision.disposition !== "INDEPENDENT_TRIGGER") {
      await deliveries.markProcessed(deliveryId, bodySha256, null);
      try { await deliveries.pruneExpired(); } catch {
        console.warn(JSON.stringify({ event: "webhook_delivery_retention_cleanup_failed", provider: "github" }));
      }
      return c.json({ accepted: decision.disposition !== "REJECTED", ...decision,
        incidentId: null, workflowId: null }, 202);
    }
    const trigger = route.trigger;
    if (!trigger) throw new Error("Previously routed trigger no longer authorized");

    // Redeliveries can use a new delivery ID. The provider's immutable trigger ID
    // remains the canonical incident key.
    const dedupeKey = await sha256Hex(
      `${trigger.provider}:${trigger.repositoryExternalId}:${trigger.triggerType}:${trigger.triggerExternalId}`
    );

    const service = new IncidentService(
      new D1IncidentStore(c.env.DB),
      new D1AuditLog(c.env.DB),
      new CloudflareWorkflowEngine(c.env.INCIDENT_WORKFLOW)
    );

    const result = await service.ingest(trigger, dedupeKey);
    await deliveries.markProcessed(deliveryId, bodySha256, result.incident.id);

    // Cleanup is deliberately best-effort and occurs only after the incident has
    // been durably accepted. A cleanup quota/error must never turn a successful
    // webhook into a failed delivery.
    try {
      await deliveries.pruneExpired();
    } catch {
      console.warn(JSON.stringify({
        event: "webhook_delivery_retention_cleanup_failed",
        provider: "github"
      }));
    }

    return c.json({
      accepted: true,
      disposition: decision.disposition,
      reason: decision.reason,
      incidentId: result.incident.id,
      duplicate: !result.created,
      workflowId: result.workflowId
    }, result.created ? 201 : 200);
  } catch (error) {
    const exhaustion = classifyD1ResourceExhaustion(error);
    if (!exhaustion) throw error;

    // D1 Free daily limits do not recover through rapid retries. Tell the caller
    // when to retry, fail closed, and avoid starting an internal retry storm.
    c.header("Retry-After", String(exhaustion.retryAfterSeconds));
    console.error(JSON.stringify({
      event: "d1_resource_exhausted",
      boundary: "github_webhook",
      resourceKind: exhaustion.kind
    }));
    return c.json({
      error: "resource exhausted",
      code: "D1_RESOURCE_EXHAUSTED",
      resource: exhaustion.kind
    }, 503);
  }
}
