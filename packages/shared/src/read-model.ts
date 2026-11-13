import type { ISODateTime, Severity } from "./models";

/** Read-only query data source. `kind` is a stable lowercase identifier, not a URL or credential. */
export interface ScenarioSource {
  kind: string;
  /** Optional display-safe label; do not include account identifiers, credentials, or raw service responses. */
  label?: string;
}

export type ScenarioDataQuality = "complete" | "partial" | "unreliable";

/** A sanitized data-quality issue; raw response bodies and credentials must never cross the API boundary. */
export interface ScenarioAnomaly {
  code: string;
  severity: "warning" | "unreliable";
  message: string;
  field?: string;
}

/** Shared provenance and quality metadata for read-only scenario results. */
export interface ScenarioResultMetadata {
  sources: ScenarioSource[];
  collected_at: ISODateTime | null;
  missing_fields: string[];
  quality: ScenarioDataQuality;
  anomalies: ScenarioAnomaly[];
}

/** JSON-serializable envelope; `data: null` means the query has no usable result. */
export interface ScenarioQueryResult<T> {
  data: T | null;
  metadata: ScenarioResultMetadata;
}

/**
 * User-maintained lifecycle for a rule finding; independent of whether the rule matches again.
 * open=待处理, in_progress=进行中, pending_review=待复核, done=已完成, ignored=已忽略.
 */
export type TodoManualStatus = "open" | "in_progress" | "pending_review" | "done" | "ignored";

/** Rule output. `dedupe_key` is an opaque, stable join key derived from rule and canonical subject identity. */
export interface TodoRuleFinding {
  dedupe_key: string;
  rule_id: string;
  subject: { kind: string; key: string; label?: string };
  title: string;
  detail?: string;
  severity?: Severity;
  first_seen_at: ISODateTime;
  last_seen_at: ISODateTime;
}

/** Current user-maintained state, stored separately from rule output and its history. */
export interface TodoManualState {
  dedupe_key: string;
  status: TodoManualStatus;
  note: string | null;
  updated_at: ISODateTime;
}

/** Append-only review event. Note changes and status changes remain explicit and serializable. */
export type TodoManualHistoryEntry =
  | {
      event_id: string;
      dedupe_key: string;
      action: "status_changed";
      from_status: TodoManualStatus | null;
      to_status: TodoManualStatus;
      changed_at: ISODateTime;
    }
  | {
      event_id: string;
      dedupe_key: string;
      action: "note_changed";
      note: string | null;
      changed_at: ISODateTime;
    };
