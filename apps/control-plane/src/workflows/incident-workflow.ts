import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";

import {
  EvidenceService,
  assertTransition,
  type EvidenceCollectionSummary,
  type IncidentStatus,
} from "@incidentpilot/domain";

import { D1AuditLog } from "../adapters/d1-audit-log";
import { D1EvidenceStore } from "../adapters/d1-evidence-store";
import { D1IncidentAuthorizationPolicy } from "../adapters/d1-incident-authorization-policy";
import { D1IncidentContextStore } from "../adapters/d1-incident-context-store";
import { D1IncidentStore } from "../adapters/d1-incident-store";
import { D1RuntimeControlStore } from "../adapters/d1-runtime-control-store";
import { GitHubEvidenceSource } from "../evidence/github-evidence-source";
import { EvidenceCipher } from "../security/evidence-crypto";

import {
  classifyD1ResourceExhaustion,
  type D1ResourceExhaustion,
} from "../security/d1-errors";

import { evidenceRetryDelayMs } from "../security/retry-policy";
import type { AppBindings } from "../bindings";

interface Params {
  incidentId: string;
}

/*
 * --------------------------------------------------------------------------
 * Serializable D1 exhaustion state
 * --------------------------------------------------------------------------
 *
 * Only plain data crosses the durable Workflow step boundary.
 */
interface SerializableD1ResourceExhaustion {
  kind: D1ResourceExhaustion["kind"];
  retryAfterSeconds: number;
}

/*
 * Internal application control-flow signal.
 *
 * This object is never persisted by step.do().
 *
 * We throw it only AFTER a durable step has completed successfully with a
 * RESOURCE_EXHAUSTED sentinel.
 */
class D1ResourceExhaustedSignal extends Error {
  readonly exhaustion: SerializableD1ResourceExhaustion;

  constructor(exhaustion: SerializableD1ResourceExhaustion) {
    super(
      `D1_RESOURCE_EXHAUSTED:${exhaustion.kind}:${exhaustion.retryAfterSeconds}`,
    );

    this.name = "D1ResourceExhaustedSignal";
    this.exhaustion = exhaustion;
  }
}

/*
 * --------------------------------------------------------------------------
 * Serializable D1 step envelope
 * --------------------------------------------------------------------------
 */

interface D1Ok<T extends Rpc.Serializable<T>> {
  kind: "OK";
  value: T;
}

interface D1Exhausted {
  kind: "RESOURCE_EXHAUSTED";
  exhaustion: SerializableD1ResourceExhaustion;
}

type D1Envelope<T extends Rpc.Serializable<T>> = D1Ok<T> | D1Exhausted;

function serializableExhaustion(
  exhaustion: D1ResourceExhaustion,
): SerializableD1ResourceExhaustion {
  return {
    kind: exhaustion.kind,
    retryAfterSeconds: exhaustion.retryAfterSeconds,
  };
}

/*
 * Converts recognized D1 capacity/quota failures into durable plain data.
 *
 * Unknown failures continue to throw normally.
 */
async function captureD1<T extends Rpc.Serializable<T>>(
  operation: () => Promise<T>,
): Promise<D1Envelope<T>> {
  try {
    return {
      kind: "OK",
      value: await operation(),
    };
  } catch (error) {
    const exhaustion = classifyD1ResourceExhaustion(error);

    if (!exhaustion) {
      throw error;
    }

    return {
      kind: "RESOURCE_EXHAUSTED",

      exhaustion: serializableExhaustion(exhaustion),
    };
  }
}

/*
 * Converts a completed durable sentinel back into normal application
 * control flow.
 */
function unwrapD1<T extends Rpc.Serializable<T>>(result: D1Envelope<T>): T {
  if (result.kind === "RESOURCE_EXHAUSTED") {
    throw new D1ResourceExhaustedSignal(result.exhaustion);
  }

  return result.value;
}

/*
 * Standard wrapper for D1-backed Workflow steps.
 *
 * Cloudflare requires step results to satisfy Rpc.Serializable<T>, so the
 * generic is deliberately constrained here.
 */
async function doD1Step<T extends Rpc.Serializable<T>>(
  step: WorkflowStep,
  name: string,
  operation: () => Promise<T>,
): Promise<T> {
  const result = await step.do<D1Envelope<T>>(name, async () =>
    captureD1(operation),
  );

  return unwrapD1(result);
}

/*
 * --------------------------------------------------------------------------
 * Incident transition
 * --------------------------------------------------------------------------
 *
 * A Workflow attempt can fail after:
 *
 *     status UPDATE succeeds
 *     audit append fails
 *
 * On replay the incident may therefore already have the requested status.
 *
 * In that case we preserve the state and heal the missing idempotent audit
 * record instead of repeating the transition.
 */
async function transition(
  store: D1IncidentStore,
  audit: D1AuditLog,
  incidentId: string,
  expectedFrom: IncidentStatus,
  next: IncidentStatus,
): Promise<IncidentStatus> {
  const incident = await store.getById(incidentId);

  if (!incident) {
    throw new Error(`Incident not found: ${incidentId}`);
  }

  if (incident.status !== next) {
    if (incident.status !== expectedFrom) {
      throw new Error(
        `Unexpected incident status: expected ${expectedFrom}, got ${incident.status}`,
      );
    }

    assertTransition(incident.status, next);

    await store.updateStatus(incidentId, next);
  }

  await audit.append({
    idempotencyKey: `status:${incidentId}:${expectedFrom}->${next}`,

    incidentId,

    actorType: "SYSTEM",

    actorId: "incident-workflow",

    eventType: "INCIDENT_STATUS_CHANGED",

    occurredAt: new Date().toISOString(),

    metadata: {
      from: expectedFrom,

      to: next,
    },
  });

  return next;
}

/*
 * --------------------------------------------------------------------------
 * Explicit serializable evidence summary
 * --------------------------------------------------------------------------
 *
 * DO NOT use:
 *
 *     Rpc.Serializable<EvidenceCollectionSummary>
 *
 * as the application-facing type.
 *
 * Rpc.Serializable is a compatibility/mapped type. Using it directly caused
 * TypeScript to widen the result and lose the concrete `status` property.
 *
 * Instead we define the exact durable DTO explicitly.
 */
interface SerializableEvidenceCollectionSummary {
  status: EvidenceCollectionSummary["status"];

  requestsUsed: number;

  downloadedBytes: number;

  itemsProduced: number;

  edgesProduced: number;

  truncated: boolean;

  errorCodes: string[];

  baseResolution: EvidenceCollectionSummary["baseResolution"];
}

function serializableEvidenceSummary(
  summary: EvidenceCollectionSummary,
): SerializableEvidenceCollectionSummary {
  return {
    status: summary.status,

    requestsUsed: summary.requestsUsed,

    downloadedBytes: summary.downloadedBytes,

    itemsProduced: summary.itemsProduced,

    edgesProduced: summary.edgesProduced,

    truncated: summary.truncated,

    /*
     * Copy the array so the durable object is independent from any mutable
     * provider/domain object.
     */
    errorCodes: [...summary.errorCodes],

    baseResolution: summary.baseResolution,
  };
}

/*
 * --------------------------------------------------------------------------
 * Evidence collection durable result
 * --------------------------------------------------------------------------
 *
 * DISABLED and RESOURCE_EXHAUSTED are successful durable-step results.
 *
 * Genuine provider/network errors are still thrown, allowing Cloudflare's
 * retry machinery to handle them.
 */

interface CollectionCompleted {
  kind: "COLLECTED";
  summary: SerializableEvidenceCollectionSummary;
}

interface CollectionDisabled {
  kind: "DISABLED";
}

interface CollectionResourceExhausted {
  kind: "RESOURCE_EXHAUSTED";
  exhaustion: SerializableD1ResourceExhaustion;
}

type CollectionAttemptResult =
  | CollectionCompleted
  | CollectionDisabled
  | { kind: "SUPERSEDED" }
  | CollectionResourceExhausted;

export class IncidentWorkflow extends WorkflowEntrypoint<AppBindings, Params> {
  async run(event: WorkflowEvent<Params>, step: WorkflowStep) {
    const incidents = new D1IncidentStore(this.env.DB);

    const audit = new D1AuditLog(this.env.DB);

    const { incidentId } = event.payload;

    try {
      if (await doD1Step(step, "check incident supersession", () => incidents.isSuperseded(incidentId))) {
        return { incidentId, status: "SUPERSEDED" as const };
      }
      /*
       * --------------------------------------------------------------------
       * VALIDATE
       * --------------------------------------------------------------------
       */
      await doD1Step(
        step,

        "validate incident",

        () =>
          transition(incidents, audit, incidentId, "RECEIVED", "VALIDATING"),
      );

      /*
       * --------------------------------------------------------------------
       * INSTALLATION AUTHORIZATION
       * --------------------------------------------------------------------
       */
      const authorization = await doD1Step(
        step,

        "evaluate installation policy",

        async () => {
          const policy = new D1IncidentAuthorizationPolicy(this.env.DB);

          const decision = await policy.evaluate(incidentId);

          await audit.append({
            idempotencyKey: `authorization:${incidentId}`,

            incidentId,

            actorType: "SYSTEM",

            actorId: "incident-policy",

            eventType: "INCIDENT_AUTHORIZATION_DECISION",

            occurredAt: new Date().toISOString(),

            metadata: {
              allowed: decision.allowed,

              reason: decision.reason,
            },
          });

          return decision;
        },
      );

      if (!authorization.allowed) {
        await doD1Step(
          step,

          "deny unauthorized incident",

          () =>
            transition(
              incidents,
              audit,
              incidentId,
              "VALIDATING",
              "POLICY_DENIED",
            ),
        );

        return {
          incidentId,

          status: "POLICY_DENIED" as const,

          reason: authorization.reason,
        };
      }

      /*
       * --------------------------------------------------------------------
       * AUTHORIZED → TRIAGING
       * --------------------------------------------------------------------
       */
      await doD1Step(
        step,

        "authorize incident",

        () =>
          transition(incidents, audit, incidentId, "VALIDATING", "AUTHORIZED"),
      );

      await doD1Step(
        step,

        "enter triage",

        () =>
          transition(incidents, audit, incidentId, "AUTHORIZED", "TRIAGING"),
      );

      /*
       * --------------------------------------------------------------------
       * EARLY EVIDENCE KILL SWITCH
       * --------------------------------------------------------------------
       *
       * This avoids entering CONTEXT_BUILDING if evidence collection is
       * already disabled.
       *
       * It is NOT the only security boundary.
       *
       * The collection callback below rereads the switch on every actual
       * retry attempt.
       */
      const collectionEnabled = await doD1Step(
        step,

        "check evidence collection control",

        async () => {
          const controls = new D1RuntimeControlStore(this.env.DB);

          return controls.isEnabled("evidence_collection_enabled");
        },
      );

      if (!collectionEnabled) {
        await doD1Step(
          step,

          "security abort disabled evidence collection",

          () =>
            transition(
              incidents,
              audit,
              incidentId,
              "TRIAGING",
              "SECURITY_ABORTED",
            ),
        );

        return {
          incidentId,

          status: "SECURITY_ABORTED" as const,
        };
      }

      await doD1Step(
        step,

        "enter context building",

        () =>
          transition(
            incidents,
            audit,
            incidentId,
            "TRIAGING",
            "CONTEXT_BUILDING",
          ),
      );

      /*
       * --------------------------------------------------------------------
       * EVIDENCE COLLECTION
       * --------------------------------------------------------------------
       */
      try {
        const attemptResult = await step.do<CollectionAttemptResult>(
          "collect bounded GitHub evidence",

          {
            retries: {
              /*
               * IncidentPilot permits THREE TOTAL collection attempts:
               *
               *   attempt 1 = initial execution
               *   attempt 2 = retry #1
               *   attempt 3 = retry #2
               *
               * Workerd/Miniflare treats `limit` here as the number of retries
               * following the initial execution, so limit: 2 enforces our
               * three-total-attempt budget.
               */
              limit: 2,

              delay: ({ ctx, error }) =>
                evidenceRetryDelayMs(ctx.attempt, error),
            },
            timeout: "2 minutes",
          },

          async (): Promise<CollectionAttemptResult> => {
            try {
              // Recheck on every retry; a durable earlier result may be stale.
              if (await incidents.isSuperseded(incidentId)) return { kind: "SUPERSEDED" };
              /*
               * CRITICAL SECURITY INVARIANT
               *
               * This read is INSIDE the retry callback.
               *
               * Every actual retry therefore reads current D1 state rather
               * than relying on the cached durable result from the earlier
               * control step.
               */
              const controls = new D1RuntimeControlStore(this.env.DB);

              const enabledNow = await controls.isEnabled(
                "evidence_collection_enabled",
              );

              if (!enabledNow) {
                /*
                 * Do not throw NonRetryableError.
                 *
                 * IncidentPilot still needs another durable step to persist
                 * SECURITY_ABORTED.
                 */
                return {
                  kind: "DISABLED",
                };
              }

              const cipher = new EvidenceCipher(
                this.env.EVIDENCE_ENCRYPTION_KEY_B64,

                this.env.EVIDENCE_ENCRYPTION_KEY_VERSION,
              );

              const evidenceService = new EvidenceService(
                new D1IncidentContextStore(this.env.DB),

                new GitHubEvidenceSource(
                  this.env.GITHUB_APP_CLIENT_ID,

                  this.env.GITHUB_APP_PRIVATE_KEY_B64,
                ),

                new D1EvidenceStore(this.env.DB, cipher),

                audit,
              );

              const summary = await evidenceService.collect(incidentId);

              return {
                kind: "COLLECTED",

                summary: serializableEvidenceSummary(summary),
              };
            } catch (error) {
              /*
               * D1 quota/capacity exhaustion cannot be repaired through
               * normal provider retry behavior.
               */
              const exhaustion = classifyD1ResourceExhaustion(error);

              if (exhaustion) {
                return {
                  kind: "RESOURCE_EXHAUSTED",

                  exhaustion: serializableExhaustion(exhaustion),
                };
              }

              /*
               * Other errors remain genuine collection/provider failures.
               *
               * Throw them so Cloudflare applies the configured retries.
               */
              throw error;
            }
          },
        );

        /*
         * ------------------------------------------------------------------
         * LIVE KILL SWITCH DISABLED
         * ------------------------------------------------------------------
         */
        if (attemptResult.kind === "SUPERSEDED") {
          return { incidentId, status: "SUPERSEDED" as const };
        }
        if (attemptResult.kind === "DISABLED") {
          await doD1Step(
            step,

            "security abort collection disabled during retry",

            () =>
              transition(
                incidents,
                audit,
                incidentId,
                "CONTEXT_BUILDING",
                "SECURITY_ABORTED",
              ),
          );

          return {
            incidentId,

            status: "SECURITY_ABORTED" as const,
          };
        }

        /*
         * ------------------------------------------------------------------
         * D1 RESOURCE EXHAUSTION DURING COLLECTION
         * ------------------------------------------------------------------
         */
        if (attemptResult.kind === "RESOURCE_EXHAUSTED") {
          /*
           * This happens OUTSIDE step.do().
           *
           * Cloudflare has already successfully persisted the sentinel.
           *
           * We now enter IncidentPilot's own FAILED_SAFE control flow.
           */
          throw new D1ResourceExhaustedSignal(attemptResult.exhaustion);
        }

        /*
         * Because CollectionAttemptResult is a proper discriminated union,
         * reaching here means TypeScript knows this is CollectionCompleted.
         *
         * summary therefore keeps its concrete explicit DTO type and
         * `summary.status` is valid.
         */
        const summary = attemptResult.summary;

        /*
         * ------------------------------------------------------------------
         * COLLECTION COMPLETED BUT FAILED TO PRODUCE USABLE EVIDENCE
         * ------------------------------------------------------------------
         */
        if (summary.status === "FAILED") {
          await doD1Step(
            step,

            "fail safe after empty evidence collection",

            () =>
              transition(
                incidents,
                audit,
                incidentId,
                "CONTEXT_BUILDING",
                "FAILED_SAFE",
              ),
          );

          return {
            incidentId,

            status: "FAILED_SAFE" as const,

            evidence: summary,
          };
        }

        /*
         * V1.2/V1.2.3 intentionally stop at the evidence graph boundary.
         *
         * The future investigator begins from this persisted encrypted graph.
         */
        return {
          incidentId,

          status: "CONTEXT_BUILDING" as const,

          evidence: summary,
        };
      } catch (error) {
        /*
         * D1 exhaustion belongs to the outer resource-exhaustion handler.
         */
        if (error instanceof D1ResourceExhaustedSignal) {
          throw error;
        }

        /*
         * ------------------------------------------------------------------
         * NORMAL PROVIDER / NETWORK RETRIES EXHAUSTED
         * ------------------------------------------------------------------
         */
        await doD1Step(
          step,

          "audit exhausted evidence retries",

          async () => {
            await audit.append({
              idempotencyKey: `evidence-aborted:${incidentId}:github`,

              incidentId,

              actorType: "SYSTEM",

              actorId: "evidence-engine",

              eventType: "EVIDENCE_COLLECTION_ABORTED",

              occurredAt: new Date().toISOString(),

              metadata: {
                reason: "COLLECTOR_EXCEPTION_AFTER_RETRIES",
              },
            });

            /*
             * doD1Step requires a serializable result.
             */
            return true;
          },
        );

        await doD1Step(
          step,

          "fail safe after evidence collector error",

          () =>
            transition(
              incidents,
              audit,
              incidentId,
              "CONTEXT_BUILDING",
              "FAILED_SAFE",
            ),
        );

        return {
          incidentId,

          status: "FAILED_SAFE" as const,
        };
      }
    } catch (error) {
      /*
       * --------------------------------------------------------------------
       * D1 RESOURCE EXHAUSTION
       * --------------------------------------------------------------------
       */
      if (!(error instanceof D1ResourceExhaustedSignal)) {
        throw error;
      }

      /*
       * instanceof above narrows `error`, so this is strongly typed.
       */
      const exhaustion = error.exhaustion;

      /*
       * Do NOT call transition() or AuditLog here.
       *
       * Both would require additional D1 activity while we already know D1
       * is resource exhausted.
       *
       * Make exactly one direct best-effort write.
       */
      let persisted = false;

      try {
        persisted = await step.do<boolean>(
          "persist D1 resource exhaustion fail-safe",

          {
            retries: {
              limit: 1,
              delay: 0,
            },

            timeout: "5 seconds",
          },

          async () =>
            incidents.markFailedSafe(incidentId, "RESOURCE_EXHAUSTED"),
        );
      } catch {
        persisted = false;
      }

      console.error(
        JSON.stringify({
          event: "incident_failed_safe_resource_exhausted",

          incidentId,

          resourceKind: exhaustion.kind,

          persisted,
        }),
      );

      return {
        incidentId,

        status: "FAILED_SAFE" as const,

        failureCode: "RESOURCE_EXHAUSTED" as const,

        resource: exhaustion.kind,

        persisted,
      };
    }
  }
}
