export type WizardStepKey = "url" | "source" | "brand" | "agent-workspace" | "done";

export interface WizardStepDefinition {
  key: WizardStepKey;
  path: string;
  label: string;
  visible: boolean;
}

/**
 * Keep future steps in the ordered definition array so they can be enabled
 * without changing the wizard's navigation shape. Hidden steps are filtered
 * before rendering and do not affect current step indexes.
 */
export const wizardStepDefinitions: readonly WizardStepDefinition[] = [
  { key: "url", path: "/new/url", label: "网址", visible: true },
  { key: "source", path: "/new/source", label: "数据源", visible: true },
  { key: "brand", path: "/new/brand", label: "品牌配置", visible: true },
  { key: "agent-workspace", path: "/new/agent-workspace", label: "Agent 工作区", visible: false },
  { key: "done", path: "/new/done", label: "完成", visible: true },
];

export const visibleWizardSteps = wizardStepDefinitions.filter((step) => step.visible);
