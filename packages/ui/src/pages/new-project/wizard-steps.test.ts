import { describe, expect, it } from "vitest";
import { getVisibleWizardSteps, visibleWizardSteps, wizardStepDefinitions } from "./wizard-steps";

describe("new project wizard step slots", () => {
  it("keeps the Agent workspace insertion point in the sequence without rendering it", () => {
    expect(wizardStepDefinitions.map(({ key }) => key)).toEqual([
      "url", "source", "brand", "agent-workspace", "done",
    ]);
    expect(wizardStepDefinitions.find(({ key }) => key === "agent-workspace")?.visible).toBe(false);
    expect(visibleWizardSteps.map(({ key }) => key)).toEqual(["url", "source", "brand", "done"]);
    expect(visibleWizardSteps.some(({ label }) => label === "Agent 工作区")).toBe(false);
  });

  it("shows the Agent workspace step only when the optional workspace API is available", () => {
    expect(getVisibleWizardSteps(false).map(({ key }) => key)).toEqual(["url", "source", "brand", "done"]);
    expect(getVisibleWizardSteps(true).map(({ key }) => key)).toEqual([
      "url", "source", "brand", "agent-workspace", "done",
    ]);
  });
});
