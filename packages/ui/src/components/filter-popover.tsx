import { cloneElement, useId, type ReactElement, type ReactNode } from "react";
import * as Popover from "@radix-ui/react-popover";
import { ColumnCheckbox } from "./primitives";
import type { SelectProps } from "./form-controls";
import "./filter-popover.css";

export function FilterPopover({ trigger, label, children }: { trigger: ReactElement; label: string; children: ReactNode }) {
  return <Popover.Root>
    <Popover.Trigger asChild>{trigger}</Popover.Trigger>
    <Popover.Portal><Popover.Content className="si-filter-popover" aria-label={label} align="start" sideOffset={4} collisionPadding={12}>
      {children}
    </Popover.Content></Popover.Portal>
  </Popover.Root>;
}

export function FilterGroup({ children }: { children: ReactNode }) {
  return <div className="si-filter-popover-group">{children}</div>;
}

export function FilterField({ label, children }: { label: string; children: ReactElement<SelectProps> }) {
  const labelId = useId();
  return <div className="si-filter-popover-field">
    <span className="si-filter-popover-label" id={labelId}>{label}</span>
    {cloneElement(children, { ariaLabelledBy: labelId })}
  </div>;
}

export function FilterCheckbox({ label, checked, onCheckedChange, disabled = false }: {
  label: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
}) {
  return <div className="si-filter-popover-checkbox">
    <ColumnCheckbox label={label} checked={checked} onCheckedChange={onCheckedChange} disabled={disabled} />
  </div>;
}
