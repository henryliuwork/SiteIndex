import type { ReactNode } from "react";

export function InputWithAction({ children, action, className = "" }: {
  children: ReactNode;
  action: ReactNode;
  className?: string;
}) {
  return <div className={"si-input-with-action" + (className ? " " + className : "")}>
    {children}
    <div className="si-input-with-action-actions">{action}</div>
  </div>;
}
