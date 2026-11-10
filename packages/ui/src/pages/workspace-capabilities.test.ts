import { describe, expect, it } from "vitest";
import { createMockApi } from "../mock";
import { getWorkspaceCapabilities } from "./workspace-capabilities";

describe("workspace capability gate", () => {
  const pendingWorkspaceHandlers = [
    "projects.createWorkspaceOnly",
    "workspace.check",
    "workspace.create",
    "workspace.importCheck",
  ];

  it("keeps the full workspace flow available in browser mock mode", () => {
    expect(getWorkspaceCapabilities(createMockApi(), true)).toEqual({
      wizardAvailable: true,
      emptyWorkspaceAvailable: true,
      importCheckAvailable: true,
      explainWizardUnavailable: false,
      explainEmptyWorkspaceUnavailable: false,
    });
  });

  it("does not mistake pending Desktop API stubs for implemented handlers", () => {
    expect(getWorkspaceCapabilities(createMockApi(), false, pendingWorkspaceHandlers)).toEqual({
      wizardAvailable: false,
      emptyWorkspaceAvailable: false,
      importCheckAvailable: false,
      explainWizardUnavailable: true,
      explainEmptyWorkspaceUnavailable: true,
    });
  });

  it("enables Desktop capabilities when implemented methods are no longer pending", () => {
    expect(getWorkspaceCapabilities(createMockApi(), false, [])).toEqual({
      wizardAvailable: true,
      emptyWorkspaceAvailable: true,
      importCheckAvailable: true,
      explainWizardUnavailable: false,
      explainEmptyWorkspaceUnavailable: false,
    });
  });

  it("does not advertise a capability when a required method is absent", () => {
    const api = createMockApi();
    api.workspace = undefined;

    expect(getWorkspaceCapabilities(api, true, [])).toMatchObject({
      wizardAvailable: false,
      emptyWorkspaceAvailable: false,
      importCheckAvailable: false,
    });
  });
});
