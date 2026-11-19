import * as Popover from "@radix-ui/react-popover";
import { MoreHorizontal } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";
import { InfoTooltip } from "./info-tooltip";
import "./summary-line.css";

export interface SummaryLineItem {
  id: string;
  label: string;
  value: number;
  active: boolean;
  onToggle: () => void;
}

/** Actionable counts only; each item toggles its matching table filter. */
export function SummaryLine({ items, timeNote, ariaLabel = "板块摘要" }: {
  items: readonly SummaryLineItem[];
  timeNote?: string;
  ariaLabel?: string;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLDivElement>(null);
  const [visibleCount, setVisibleCount] = useState(items.length);
  const [menuOpen, setMenuOpen] = useState(false);

  useLayoutEffect(() => {
    const root = rootRef.current;
    const measure = measureRef.current;
    if (!root || !measure) return;
    const update = () => {
      const widths = Array.from(measure.querySelectorAll<HTMLElement>("[data-summary-measure-item]"))
        .map((element) => element.getBoundingClientRect().width);
      const more = measure.querySelector<HTMLElement>("[data-summary-measure-more]")?.getBoundingClientRect().width ?? 0;
      const note = root.querySelector<HTMLElement>(".si-summary-line-note")?.getBoundingClientRect().width ?? 0;
      const gap = Number.parseFloat(getComputedStyle(root).columnGap) || 0;
      const available = root.clientWidth - (note ? note + gap : 0);
      let count = widths.length;
      while (count > 0 && widths.slice(0, count).reduce((sum, width) => sum + width, 0)
        + gap * Math.max(0, count - 1) + (count < widths.length ? more + gap : 0) > available) count -= 1;
      setVisibleCount(count);
    };
    const observer = new ResizeObserver(update);
    observer.observe(root);
    observer.observe(measure);
    update();
    return () => observer.disconnect();
  }, [items, timeNote]);

  const shown = items.slice(0, Math.min(4, visibleCount));
  const hidden = items.slice(shown.length, 4);
  return <div ref={rootRef} className="si-summary-line" role="group" aria-label={ariaLabel}>
    {shown.map((item) => <button key={item.id} type="button" className="si-summary-line-item" aria-pressed={item.active} onClick={item.onToggle}>
      <span>{item.label}</span><strong>{item.value.toLocaleString()}</strong>
    </button>)}
    {hidden.length > 0 && <Popover.Root open={menuOpen} onOpenChange={setMenuOpen}>
      <Popover.Trigger asChild><button type="button" className="si-summary-line-more" aria-label="更多摘要项" aria-expanded={menuOpen}><MoreHorizontal size={16} aria-hidden="true" />更多</button></Popover.Trigger>
      <Popover.Portal><Popover.Content className="si-summary-line-popover" align="start" sideOffset={4}>
        {hidden.map((item) => <button key={item.id} type="button" aria-pressed={item.active} onClick={() => { item.onToggle(); setMenuOpen(false); }}>
          <span>{item.label}</span><strong>{item.value.toLocaleString()}</strong>
        </button>)}
      </Popover.Content></Popover.Portal>
    </Popover.Root>}
    {timeNote && <div className="si-summary-line-note"><InfoTooltip label="数据来源时间" content={timeNote} /></div>}
    <div ref={measureRef} className="si-summary-line-measure" aria-hidden="true">
      {items.slice(0, 4).map((item) => <span key={item.id} data-summary-measure-item className="si-summary-line-item"><span>{item.label}</span><strong>{item.value.toLocaleString()}</strong></span>)}
      <span data-summary-measure-more className="si-summary-line-more"><MoreHorizontal size={16} />更多</span>
    </div>
  </div>;
}
