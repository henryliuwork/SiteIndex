import * as Tooltip from "@radix-ui/react-tooltip";
import { Info } from "lucide-react";
import type { ReactNode } from "react";
import "./info-tooltip.css";

export function InfoTooltip({ label, content }: { label: string; content: ReactNode }) {
  return <Tooltip.Provider delayDuration={0}>
    <Tooltip.Root>
      <Tooltip.Trigger asChild>
        <button type="button" className="si-info-tooltip-trigger" aria-label={label}>
          <Info size={14} aria-hidden="true" />
        </button>
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content className="si-info-tooltip-content" sideOffset={6} collisionPadding={8}>
          {content}
          <Tooltip.Arrow className="si-info-tooltip-arrow" />
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  </Tooltip.Provider>;
}
