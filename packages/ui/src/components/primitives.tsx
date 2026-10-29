import { memo, useEffect, useRef, useState, type ButtonHTMLAttributes, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import * as Checkbox from "@radix-ui/react-checkbox";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import * as PopoverPrimitive from "@radix-ui/react-popover";
import { Check, ChevronDown, ChevronLeft, ChevronRight, Search, X } from "lucide-react";
import { Link } from "react-router-dom";
import type { Kpi, StockStatus } from "@siteindex/shared";
import { getLengthGrade, getPaginationModel, nextFilterValue, type LengthKind } from "./utils";

export type ButtonVariant = "default" | "primary" | "quiet" | "danger";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: "default" | "small";
  icon?: ReactNode;
}

export function Button({ variant = "default", size = "default", icon, className = "", children, ...props }: ButtonProps) {
  return (
    <button className={"si-button si-button-" + variant + (size === "small" ? " si-button-small" : "") + (className ? " " + className : "")} {...props}>
      {icon && <span className="si-button-icon" aria-hidden="true">{icon}</span>}
      {children}
    </button>
  );
}

export function FilterPill<T extends string>({
  active: activeProp, currentValue, value, onValueChange, onClick, className = "", children, ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  active?: boolean;
  currentValue?: T;
  value?: T;
  onValueChange?: (value: T | undefined) => void;
}) {
  const active = activeProp ?? (value !== undefined && currentValue === value);
  return (
    <button
      className={"si-filter-pill" + (active ? " active" : "") + (className ? " " + className : "")}
      aria-pressed={active}
      onClick={(event) => {
        if (value !== undefined && onValueChange) onValueChange(nextFilterValue(currentValue, value));
        onClick?.(event);
      }}
      {...props}
    >{children}</button>
  );
}

export interface Choice<T extends string> {
  value: T;
  label: string;
  disabled?: boolean;
}

interface ChoiceControlProps<T extends string> {
  value: T;
  options: readonly Choice<T>[];
  onChange: (value: T) => void;
  ariaLabel?: string;
}

export function Segmented<T extends string>({ value, options, onChange, ariaLabel = "视图切换" }: ChoiceControlProps<T>) {
  return (
    <div className="si-segmented" role="group" aria-label={ariaLabel}>
      {options.map((option) => <button key={option.value} type="button" disabled={option.disabled} aria-pressed={value === option.value} className={value === option.value ? "active" : ""} onClick={() => onChange(option.value)}>{option.label}</button>)}
    </div>
  );
}

export function SubTabs<T extends string>(props: ChoiceControlProps<T>) {
  return <div className="si-subtabs"><Segmented {...props} ariaLabel={props.ariaLabel ?? "设置子页"} /></div>;
}

export function Tabs<T extends string>({ value, options, onChange, ariaLabel = "页面标签" }: ChoiceControlProps<T>) {
  const handleKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>, currentIndex: number) => {
    const enabledOptions = options.flatMap((option, index) => option.disabled ? [] : [{ option, index }]);
    if (enabledOptions.length === 0) return;

    const currentEnabledIndex = enabledOptions.findIndex(({ index }) => index === currentIndex);
    let targetIndex: number;
    switch (event.key) {
      case "ArrowRight":
        targetIndex = (currentEnabledIndex + 1 + enabledOptions.length) % enabledOptions.length;
        break;
      case "ArrowLeft":
        targetIndex = (currentEnabledIndex - 1 + enabledOptions.length) % enabledOptions.length;
        break;
      case "Home":
        targetIndex = 0;
        break;
      case "End":
        targetIndex = enabledOptions.length - 1;
        break;
      default:
        return;
    }

    event.preventDefault();
    const target = enabledOptions[targetIndex];
    if (!target) return;
    const nextValue = target.option.value;
    onChange(nextValue);
    const focusSelectedTab = (attempt = 0) => {
      const tablist = Array.from(document.querySelectorAll<HTMLElement>('[role="tablist"]'))
        .find((element) => element.getAttribute("aria-label") === ariaLabel);
      const nextTab = Array.from(tablist?.querySelectorAll<HTMLButtonElement>('[role="tab"]') ?? [])
        .find((element) => element.dataset.tabValue === nextValue && element.getAttribute("aria-selected") === "true");
      if (nextTab) {
        nextTab.focus();
      } else if (attempt < 30) {
        window.requestAnimationFrame(() => focusSelectedTab(attempt + 1));
      }
    };
    window.requestAnimationFrame(() => focusSelectedTab());
  };

  return (
    <div className="si-tabs" role="tablist" aria-label={ariaLabel}>
      {options.map((option, index) => <button
        key={option.value}
        type="button"
        role="tab"
        aria-selected={value === option.value}
        tabIndex={value === option.value ? 0 : -1}
        disabled={option.disabled}
        data-tab-value={option.value}
        className={value === option.value ? "active" : ""}
        onClick={() => onChange(option.value)}
        onKeyDown={(event) => handleKeyDown(event, index)}
      >{option.label}</button>)}
    </div>
  );
}

export type ChipTone = "ok" | "warn" | "danger" | "info" | "neutral";

export function Chip({ tone = "neutral", children, className = "" }: { tone?: ChipTone; children: ReactNode; className?: string }) {
  return <span className={"si-chip si-chip-" + tone + (className ? " " + className : "")}>{children}</span>;
}

export function LengthBadge({ length, kind = "title", range }: { length: number; kind?: LengthKind; range?: [number, number] }) {
  const grade = getLengthGrade(length, kind, range);
  const label = kind === "title" ? "标题" : "描述";
  return <span className={"si-length-badge si-length-" + grade} aria-label={label + "长度 " + length + " 字符"} title={label + "长度：" + length + " 字符"}>{length}</span>;
}

export function KpiCard({ metric }: { metric: Kpi }) {
  const content = (
    <>
      <span className="si-kpi-label">{metric.label}</span>
      <strong className={"si-kpi-value" + (metric.reserved ? " is-reserved" : "")}>{metric.value}</strong>
      {metric.hint && <span className="si-kpi-hint">{metric.hint}</span>}
    </>
  );
  const className = "si-kpi-card" + (metric.reserved ? " is-reserved" : "") + (metric.tone ? " si-kpi-" + metric.tone : "");
  return metric.link ? <Link className={className} to={metric.link}>{content}</Link> : <div className={className}>{content}</div>;
}

export function Popover({ trigger, children, align = "end", className = "" }: { trigger: ReactNode; children: ReactNode; align?: "start" | "center" | "end"; className?: string }) {
  return (
    <PopoverPrimitive.Root>
      <PopoverPrimitive.Trigger asChild>{trigger}</PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content className={"si-popover-content" + (className ? " " + className : "")} align={align} sideOffset={6}>
          {children}<PopoverPrimitive.Arrow className="si-popover-arrow" />
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}

export function ColumnCheckbox({ checked, onCheckedChange, label, disabled = false }: { checked: boolean; onCheckedChange: (checked: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <Checkbox.Root asChild checked={checked} onCheckedChange={(next) => onCheckedChange(next === true)} disabled={disabled} aria-label={label}>
      <button className="si-checkbox-row" type="button">
        <span className="si-checkbox" aria-hidden="true"><Checkbox.Indicator><Check size={12} /></Checkbox.Indicator></span>
        <span>{label}</span>
      </button>
    </Checkbox.Root>
  );
}

export function ConfirmDialog({
  open, onOpenChange, title, description, confirmLabel = "确认", cancelLabel = "取消", tone = "danger", onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: "primary" | "danger";
  onConfirm: () => void | Promise<void>;
}) {
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const confirm = async () => { await onConfirm(); onOpenChange(false); };
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="si-dialog-overlay" />
        <DialogPrimitive.Content
          className="si-confirm-dialog"
          onOpenAutoFocus={() => {
            returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            const target = returnFocusRef.current;
            returnFocusRef.current = null;
            if (target?.isConnected) target.focus();
          }}
        >
          <DialogPrimitive.Title className="si-dialog-title">{title}</DialogPrimitive.Title>
          <DialogPrimitive.Description className="si-dialog-description">{description}</DialogPrimitive.Description>
          <div className="si-dialog-actions">
            <Button onClick={() => onOpenChange(false)}>{cancelLabel}</Button>
            <Button variant={tone} onClick={confirm}>{confirmLabel}</Button>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

export function DetailPanel({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: string; children: ReactNode }) {
  const returnFocusRef = useRef<HTMLElement | null>(null);
  return (
    <DialogPrimitive.Root open={open} onOpenChange={(value) => { if (!value) onClose(); }}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="si-detail-overlay" />
        <DialogPrimitive.Content
          className="si-detail-panel"
          aria-describedby={undefined}
          onOpenAutoFocus={() => {
            returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            const target = returnFocusRef.current;
            returnFocusRef.current = null;
            if (target?.isConnected) target.focus();
          }}
        >
          <div className="si-detail-heading">
            <DialogPrimitive.Title className="si-dialog-title">{title}</DialogPrimitive.Title>
            <DialogPrimitive.Close asChild><button className="si-icon-button" type="button" aria-label="关闭详情"><X size={16} aria-hidden="true" /></button></DialogPrimitive.Close>
          </div>
          <div className="si-detail-content">{children}</div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

export function Pagination({ page, pageSize, total, onPageChange, onPageSizeChange }: {
  page: number;
  pageSize: 20 | 50 | 100;
  total: number;
  onPageChange: (page: number) => void;
  onPageSizeChange: (pageSize: 20 | 50 | 100) => void;
}) {
  const model = getPaginationModel(page, pageSize, total);
  return (
    <div className="si-pagination" aria-label="分页">
      <span className="si-pagination-count">显示 {model.from}–{model.to} / {model.total}</span>
      <label className="si-page-size">每页
        <select value={model.pageSize} onChange={(event) => onPageSizeChange(Number(event.target.value) as 20 | 50 | 100)} aria-label="每页条数">
          {[20, 50, 100].map((size) => <option key={size} value={size}>{size}</option>)}
        </select>
      </label>
      <div className="si-pagination-controls">
        <button type="button" aria-label="上一页" disabled={model.page <= 1} onClick={() => onPageChange(model.page - 1)}><ChevronLeft size={16} /></button>
        <span>第 {model.page} / {model.pageCount} 页</span>
        <button type="button" aria-label="下一页" disabled={model.page >= model.pageCount} onClick={() => onPageChange(model.page + 1)}><ChevronRight size={16} /></button>
      </div>
    </div>
  );
}

export const StatusCells = memo(function StatusCells({ history, label = "近 30 日库存" }: { history: string; label?: string }) {
  const statuses: Record<string, { label: string; tone: string }> = {
    i: { label: "有货", tone: "in" },
    o: { label: "缺货", tone: "out" },
    p: { label: "预售", tone: "preorder" },
    u: { label: "未知", tone: "unknown" },
    "-": { label: "未上架", tone: "not-listed" },
  };
  const cells = history.slice(-30).padStart(30, "-").split("");
  const summary = cells.map((cell) => statuses[cell]?.label ?? "未知").join("、");
  const colors: Record<string, string> = {
    in: "var(--color-stock-in)", out: "var(--color-stock-out)", preorder: "var(--color-stock-preorder)",
    unknown: "var(--color-stock-unknown)", "not-listed": "#E9EBEE",
  };
  const unit = 100 / cells.length;
  const gradient = cells.map((cell, index) => {
    const start = unit * index;
    const end = start + unit;
    const filledEnd = start + unit * (5 / 6);
    const tone = statuses[cell]?.tone ?? "unknown";
    return `${colors[tone] ?? colors.unknown} ${start}% ${filledEnd}%, transparent ${filledEnd}% ${end}%`;
  }).join(", ");
  const detail = cells.map((cell, index) => dateLabel(index, cells.length) + " · " + (statuses[cell]?.label ?? "未知")).join("；");
  return <span className="si-status-cells" role="img" aria-label={label + "：" + summary} title={detail} style={{ backgroundImage: `linear-gradient(to right, ${gradient})` }} />;
});

function dateLabel(index: number, length: number): string {
  const daysAgo = length - index - 1;
  return daysAgo === 0 ? "今天" : daysAgo + " 天前";
}

export function SearchInput({ value, onSearch, label = "搜索", placeholder = "搜索" }: { value: string; onSearch: (value: string) => void; label?: string; placeholder?: string }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  useEffect(() => {
    if (draft === value) return;
    const timer = window.setTimeout(() => onSearch(draft.trim()), 50);
    return () => window.clearTimeout(timer);
  }, [draft, onSearch, value]);
  return (
    <label className="si-search-input">
      <Search size={15} aria-hidden="true" />
      <input type="search" aria-label={label} placeholder={placeholder} value={draft} onChange={(event) => setDraft(event.target.value)} />
    </label>
  );
}

export const stockTone: Record<StockStatus, ChipTone> = {
  in_stock: "ok", out_of_stock: "danger", preorder: "warn", unknown: "neutral",
};
