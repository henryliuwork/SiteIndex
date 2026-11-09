import { useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import * as Popover from "@radix-ui/react-popover";
import { AlertCircle, Info, MoreHorizontal, TriangleAlert, X } from "lucide-react";
import { Button } from "./primitives";

export function Card({ children, className = "", label }: { children: ReactNode; className?: string; label?: string }) {
  return <section aria-label={label} className={"si-card" + (className ? " " + className : "")}>{children}</section>;
}

export interface PageHeaderOverflowAction {
  label: string;
  onSelect: () => void;
  disabled?: boolean;
  danger?: boolean;
  icon?: ReactNode;
}

export function PageHeaderActions({ actions, overflow = [], className = "si-page-header-actions" }: {
  actions?: ReactNode;
  overflow?: readonly PageHeaderOverflowAction[];
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const menuItems = useRef<Array<HTMLButtonElement | null>>([]);
  const onMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const enabled = overflow.flatMap((item, index) => item.disabled ? [] : [index]);
    if (!enabled.length) return;
    const current = enabled.indexOf(menuItems.current.findIndex((node) => node === document.activeElement));
    const position = current < 0 ? 0 : current;
    const target = event.key === "Home" ? enabled[0]!
      : event.key === "End" ? enabled[enabled.length - 1]!
        : enabled[(position + (event.key === "ArrowDown" ? 1 : -1) + enabled.length) % enabled.length]!;
    event.preventDefault();
    menuItems.current[target]?.focus();
  };
  if (!actions && overflow.length === 0) return null;
  return <div className={className}>
    {actions}
    {overflow.length > 0 && <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <Button variant="ghost" size="small" className="si-page-header-more" aria-label="更多操作" title="更多操作" aria-haspopup="menu" aria-expanded={open}>
          <MoreHorizontal size={16} aria-hidden="true" /><span>更多</span>
        </Button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content className="si-page-header-menu" role="menu" aria-label="更多操作" align="end" sideOffset={4} onKeyDown={onMenuKeyDown}>
          {overflow.map((item) => <button
            key={item.label}
            ref={(node) => { menuItems.current[overflow.indexOf(item)] = node; }}
            type="button"
            role="menuitem"
            disabled={item.disabled}
            className={"si-page-header-menu-item" + (item.danger ? " is-danger" : "")}
            onClick={() => { item.onSelect(); setOpen(false); }}
          >
            {item.icon && <span aria-hidden="true">{item.icon}</span>}
            {item.label}
          </button>)}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>}
  </div>;
}

export function PageHeader({ title, meta, actions, overflow = [] }: {
  title: ReactNode;
  meta?: ReactNode;
  actions?: ReactNode;
  overflow?: readonly PageHeaderOverflowAction[];
}) {
  return (
    <header className="si-page-header">
      <div className="si-page-header-copy">
        <h1>{title}</h1>
        {meta && <div className="si-page-header-meta">{meta}</div>}
      </div>
      <PageHeaderActions actions={actions} overflow={overflow} />
    </header>
  );
}

export function Notice({ tone = "info", title, children, action, onDismiss, className = "" }: {
  tone?: "info" | "warn" | "error";
  title?: ReactNode;
  children: ReactNode;
  action?: ReactNode;
  onDismiss?: () => void;
  className?: string;
}) {
  const Icon = tone === "error" ? AlertCircle : tone === "warn" ? TriangleAlert : Info;
  return (
    <div className={"si-notice si-notice-" + tone + (className ? " " + className : "")} role={tone === "error" ? "alert" : "status"}>
      <Icon size={16} aria-hidden="true" />
      <div className="si-notice-copy">{title && <strong>{title}</strong>}<div>{children}</div></div>
      {action && <div className="si-notice-action">{action}</div>}
      {onDismiss && <Button variant="ghost" size="small" className="si-notice-close" aria-label="关闭提示" title="关闭提示" onClick={onDismiss}><X size={14} aria-hidden="true" /></Button>}
    </div>
  );
}

export function EmptyState({ icon, title, children, action }: {
  icon?: ReactNode;
  title?: ReactNode;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="si-empty-state" role="status">
      {icon && <div className="si-empty-state-icon" aria-hidden="true">{icon}</div>}
      {title && <h2>{title}</h2>}
      <p>{children}</p>
      {action && <div className="si-empty-state-action">{action}</div>}
    </div>
  );
}
