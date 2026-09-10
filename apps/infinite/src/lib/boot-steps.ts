/**
 * The first-visit progress lines — docs/HANDOFF-infinite-agent.md §4.1.
 *
 * WHY THE STEPS ARE DATA. §4.1 is a timeline with four honest milestones (shell, workspace, runtime,
 * local AI) and a promise attached: nothing above talks to our servers except the app shell and the
 * model weights. Making the steps a list rather than four booleans in a component is what lets the
 * boot screen show the SAME words on a cold first visit and on a warm reload, and what lets a step
 * fail visibly — an unsupported WebGPU is a normal outcome, not an error screen.
 */

export type StepId = "shell" | "workspace" | "runtime" | "local-ai";
export type StepState = "pending" | "active" | "done" | "failed";

export interface BootStep {
  id: StepId;
  label: string;
  state: StepState;
  /** The tail after the `·`: a readiness phrase, a reason, or nothing. */
  detail?: string;
}

/** `local-ai` is last on purpose: the shell is usable before it, and often without it. */
export const BOOT_STEP_LABELS: Record<StepId, string> = {
  shell: "Shell",
  workspace: "Workspace",
  runtime: "Runtime",
  "local-ai": "Local AI",
};

export const BOOT_STEP_ORDER: StepId[] = ["shell", "workspace", "runtime", "local-ai"];

export function initialBootSteps(): BootStep[] {
  return BOOT_STEP_ORDER.map((id) => ({ id, label: BOOT_STEP_LABELS[id], state: "pending" as StepState }));
}

export function setStep(steps: BootStep[], id: StepId, state: StepState, detail?: string): BootStep[] {
  return steps.map((s) => (s.id === id ? { ...s, state, detail } : s));
}

export function stepLine(step: BootStep): string {
  return step.detail ? `${step.label} · ${step.detail}` : step.label;
}

/** 0..1 over the four steps; a failed step counts as finished, because it will not finish later. */
export function bootProgress(steps: BootStep[]): number {
  if (steps.length === 0) return 1;
  const settled = steps.filter((s) => s.state === "done" || s.state === "failed").length;
  return settled / steps.length;
}

/**
 * The shell opens when the first three are settled. Waiting for the local brain would mean staring at
 * a spinner for a 300 MB download on a first visit, and §4.1 explicitly says retrieval works with no
 * model at all.
 */
export function shellReady(steps: BootStep[]): boolean {
  const blocking: StepId[] = ["shell", "workspace", "runtime"];
  return blocking.every((id) => {
    const s = steps.find((x) => x.id === id);
    return s?.state === "done";
  });
}

export function bootFailed(steps: BootStep[]): BootStep | null {
  const blocking: StepId[] = ["shell", "workspace", "runtime"];
  return steps.find((s) => s.state === "failed" && blocking.includes(s.id)) ?? null;
}
