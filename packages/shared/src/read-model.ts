import type { ISODateTime, Severity } from "./models";
import type { PathKey } from "./paths";

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
  /** Non-empty references to source records; path is a PATHS key resolved for the project's layout. */
  sources: [TodoRuleSourceReference, ...TodoRuleSourceReference[]];
  first_seen_at: ISODateTime;
  /** Updated only when this finding is observed, never from a partial or failed scan. */
  last_seen_at: ISODateTime;
}

/** Traceable reference to the source file and record that supports a rule finding. */
export interface TodoRuleSourceReference {
  path: PathKey;
  record_key: string;
  collected_at: ISODateTime;
}

/** Current manual state and note; rule regeneration preserves both. */
export interface TodoManualState {
  dedupe_key: string;
  status: TodoManualStatus;
  note: string | null;
  updated_at: ISODateTime;
  /** Persisted timestamp from a complete trusted scan that confirmed this finding was absent; cleared on reappearance. */
  absence_confirmed_at?: ISODateTime | null;
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
    }
  | {
      event_id: string;
      dedupe_key: string;
      /** A renewed rule match reopens a completed todo for human review. */
      action: "rule_reopened";
      from_status: "done";
      to_status: "pending_review";
      rule_id: string;
      /** Timestamp when a complete trusted scan confirmed this rule finding was absent. */
      absence_confirmed_at: ISODateTime;
      changed_at: ISODateTime;
    };

/** Current rule result joined to its separately stored manual lifecycle. */
export interface ProjectTodo {
  finding: TodoRuleFinding;
  state: TodoManualState;
}

/** Only complete means all required rule sources were read and trusted for absence conclusions. */
export type TodoRuleScanStatus = "not_run" | "complete" | "partial" | "failed";

export interface TodoRuleScanSummary {
  /** complete means every required rule source was readable, complete, and trusted for absence conclusions. */
  status: TodoRuleScanStatus;
  evaluated_at: ISODateTime | null;
}

/** Snapshot of current findings plus the scan quality needed to interpret missing findings safely. */
export interface ProjectTodosResult {
  items: ProjectTodo[];
  scan: TodoRuleScanSummary;
}

/** At least one manual field must be supplied; omitted fields remain unchanged and note=null clears the note. */
export type UpdateTodoManualInput =
  | { dedupe_key: string; status: TodoManualStatus; note?: string | null }
  | { dedupe_key: string; status?: never; note: string | null };
