import { describe, expect, it } from "vitest";
import { visibleWizardSteps, wizardStepDefinitions } from "./wizard-steps";

describe("new project wizard step slots", () => {
  it("keeps the Agent workspace insertion point in the sequence without rendering it", () => {
    expect(wizardStepDefinitions.map(({ key }) => key)).toEqual([
      "url", "source", "brand", "agent-workspace", "done",
    ]);
    expect(wizardStepDefinitions.find(({ key }) => key === "agent-workspace")?.visible).toBe(false);
    expect(visibleWizardSteps.map(({ key }) => key)).toEqual(["url", "source", "brand", "done"]);
    expect(visibleWizardSteps.some(({ label }) => label === "Agent 工作区")).toBe(false);
  });
});
