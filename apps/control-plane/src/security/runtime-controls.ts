export const RUNTIME_CONTROLS = [
  "webhook_ingestion_enabled",
  "evidence_collection_enabled",
  "model_calls_enabled",
  "privileged_actions_enabled"
] as const;

export type RuntimeControl = (typeof RUNTIME_CONTROLS)[number];

export interface RuntimeControlStore {
  isEnabled(control: RuntimeControl): Promise<boolean>;
}
