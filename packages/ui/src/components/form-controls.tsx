import { forwardRef, useId, useRef, useState, type InputHTMLAttributes, type KeyboardEvent, type ReactNode } from "react";
import * as Popover from "@radix-ui/react-popover";
import { ChevronDown } from "lucide-react";

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input({ className = "", ...props }, ref) {
  return <input {...props} ref={ref} className={"si-text-field" + (className ? " " + className : "")} />;
});
Input.displayName = "Input";

export interface SelectOption {
  value: string;
  label: ReactNode;
  disabled?: boolean;
}

export interface SelectProps {
  value: string;
  options: readonly SelectOption[];
  onValueChange: (value: string) => void;
  placeholder?: string;
  ariaLabel?: string;
  ariaLabelledBy?: string;
  id?: string;
  disabled?: boolean;
  className?: string;
}

export function Select({ value, options, onValueChange, placeholder = "请选择", ariaLabel, ariaLabelledBy, id, disabled = false, className = "" }: SelectProps) {
  const generatedId = useId();
  const triggerId = id ?? "si-select-" + generatedId;
  const listboxId = triggerId + "-listbox";
  const [open, setOpen] = useState(false);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const selectedIndex = options.findIndex((option) => option.value === value);
  const selected = options[selectedIndex];

  const onTriggerKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setOpen(true);
    }
  };

  const onListKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const enabledIndices = options.map((option, index) => option.disabled ? -1 : index).filter((index) => index >= 0);
    if (!enabledIndices.length) return;
    const focusedIndex = optionRefs.current.findIndex((node) => node === document.activeElement);
    const current = enabledIndices.indexOf(focusedIndex);
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const position = current < 0 ? 0 : current;
      const next = event.key === "ArrowDown" ? (position + 1) % enabledIndices.length : (position - 1 + enabledIndices.length) % enabledIndices.length;
      optionRefs.current[enabledIndices[next] ?? enabledIndices[0]!]?.focus();
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      const index = event.key === "Home" ? enabledIndices[0]! : enabledIndices[enabledIndices.length - 1]!;
      optionRefs.current[index]?.focus();
    }
  };

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          id={triggerId}
          type="button"
          role="combobox"
          aria-label={ariaLabel}
          aria-labelledby={ariaLabelledBy}
          aria-controls={listboxId}
          aria-expanded={open}
          aria-haspopup="listbox"
          disabled={disabled}
          className={"si-select-trigger" + (className ? " " + className : "")}
          onKeyDown={onTriggerKeyDown}
        >
          <span>{selected?.label ?? placeholder}</span>
          <ChevronDown size={14} aria-hidden="true" />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          id={listboxId}
          role="listbox"
          aria-label={ariaLabel}
          aria-labelledby={ariaLabelledBy}
          className="si-select-content"
          align="start"
          sideOffset={4}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            const firstEnabled = options.findIndex((option) => !option.disabled);
            const initial = selected && !selected.disabled ? selectedIndex : firstEnabled;
            if (initial >= 0) optionRefs.current[initial]?.focus();
          }}
          onKeyDown={onListKeyDown}
        >
          {options.map((option, index) => (
            <button
              key={option.value}
              ref={(node) => { optionRefs.current[index] = node; }}
              type="button"
              role="option"
              aria-selected={option.value === value}
              disabled={option.disabled}
              className="si-select-option"
              onClick={() => {
                onValueChange(option.value);
                setOpen(false);
              }}
            >
              <span>{option.label}</span>
              {option.value === value && <span aria-hidden="true">✓</span>}
            </button>
          ))}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}