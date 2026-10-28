import type { ReactNode } from "react";
import { apiErrorDetails } from "../api";

export function ApiErrorNotice({
  label,
  error,
  detail,
  onRetry,
  page = false,
  className,
}: {
  label: ReactNode;
  error: unknown;
  detail?: string;
  onRetry?: () => void;
  page?: boolean;
  className?: string;
}) {
  const details = apiErrorDetails(error);
  const classes = ["si-api-error-state", page ? "is-page" : "", className ?? ""].filter(Boolean).join(" ");

  return <div className={classes} role="alert">
    <span>{label}</span>
    {(details || detail) && <small className="si-api-error-detail">{details?.message ?? detail}{details?.code && `（${details.code}）`}</small>}
    {onRetry && <button className="si-api-error-retry" type="button" onClick={onRetry}>重试</button>}
  </div>;
}
