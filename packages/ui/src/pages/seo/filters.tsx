import { useState, type ReactNode } from "react";
import { ChevronDown, Search } from "lucide-react";
import * as PopoverPrimitive from "@radix-ui/react-popover";
import { Button } from "../../components";

export interface SeoFilterOption<T extends string> {
  value: T;
  label: string;
  count?: number;
}

function SeoPopover({
  open, onOpenChange, className, trigger, children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  className: string;
  trigger: ReactNode;
  children: ReactNode;
}) {
  return <PopoverPrimitive.Root open={open} onOpenChange={onOpenChange}>
    <PopoverPrimitive.Trigger asChild>{trigger}</PopoverPrimitive.Trigger>
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content className={`si-popover-content ${className}`} align="start" sideOffset={6}>
        {children}<PopoverPrimitive.Arrow className="si-popover-arrow" />
      </PopoverPrimitive.Content>
    </PopoverPrimitive.Portal>
  </PopoverPrimitive.Root>;
}

export function SeoSingleFilter<T extends string>({
  label, value, options, onChange,
}: {
  label: string;
  value: T;
  options: SeoFilterOption<T>[];
  onChange: (value: T) => void;
}) {
  const [open, setOpen] = useState(false);
  const selected = options.find((option) => option.value === value);
  return <SeoPopover
    open={open} onOpenChange={setOpen} className="si-seo-dropdown-content"
    trigger={<button type="button" className="si-seo-dropdown-trigger" aria-label={`${label}：${selected?.label ?? "全部"}`}>
      <span>{label} · {selected?.label ?? "全部"}</span><ChevronDown size={14} aria-hidden="true" />
    </button>}
  >
    <div className="si-seo-dropdown-options" role="group" aria-label={label}>
      {options.map((option) => <button key={option.value} type="button" aria-pressed={option.value === value} onClick={() => { onChange(option.value); setOpen(false); }}>
        <span>{option.label}</span>{option.count != null && <small>{option.count}</small>}
      </button>)}
    </div>
  </SeoPopover>;
}

export function SeoMultiFilter<T extends string>({
  label, values, options, onChange,
}: {
  label: string;
  values: T[];
  options: SeoFilterOption<T>[];
  onChange: (values: T[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const visible = options.filter((option) => option.label.toLocaleLowerCase("zh-CN").includes(search.trim().toLocaleLowerCase("zh-CN")) || option.value.toLocaleLowerCase("zh-CN").includes(search.trim().toLocaleLowerCase("zh-CN")));
  const toggle = (value: T) => onChange(values.includes(value) ? values.filter((item) => item !== value) : [...values, value]);

  return <SeoPopover
    open={open} onOpenChange={setOpen} className="si-seo-dropdown-content si-seo-rule-popover"
    trigger={<button type="button" className="si-seo-dropdown-trigger" aria-label={`${label} · 已选 ${values.length}`}>
      <span>{label} · 已选 {values.length}</span><ChevronDown size={14} aria-hidden="true" />
    </button>}
  >
    <label className="si-seo-dropdown-search"><Search size={14} aria-hidden="true" /><input type="search" value={search} onChange={(event) => setSearch(event.currentTarget.value)} placeholder="搜索问题类型" aria-label="搜索问题类型" /></label>
    <div className="si-seo-dropdown-options si-seo-rule-options" role="group" aria-label={label}>
      {visible.length ? visible.map((option) => <label key={option.value} className="si-seo-rule-option">
        <input type="checkbox" checked={values.includes(option.value)} onChange={() => toggle(option.value)} />
        <span>{option.label}</span><small>{option.count ?? 0}</small>
      </label>) : <span className="si-seo-dropdown-empty">没有匹配的问题类型</span>}
    </div>
    <div className="si-seo-dropdown-footer"><Button size="small" onClick={() => onChange([])}>清除</Button></div>
  </SeoPopover>;
}

export function SeoFilterChip({ label, onRemove }: { label: string; onRemove: () => void }) {
  return <button type="button" className="si-seo-filter-chip" onClick={onRemove} aria-label={`移除筛选：${label}`}>
    <span>{label}</span><span aria-hidden="true">×</span>
  </button>;
}
