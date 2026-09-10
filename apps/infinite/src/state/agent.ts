/**
 * The owned agent, once — docs/HANDOFF-infinite-agent.md §4.1 and §3.3.
 *
 * WHY THE BOOT IS A STORE AND NOT A LIFECYCLE HOOK. The first visit is a sequence a person WATCHES
 * (shell, workspace, runtime, local AI), and every one of those lines can also be true on the tenth
 * visit — a cold reload after an eviction is a first visit again. Keeping the sequence as state means
 * the same screen paints both, the failure of one step is visible rather than fatal, and the durability
 * answer of §3.3 has somewhere to live that the Settings pane can read later.
 */
import { computed, ref, shallowRef } from "vue";
import { bootFailed, bootProgress, initialBootSteps, setStep, shellReady, type BootStep, type StepId, type StepState } from "../lib/boot-steps.js";
import { requestPersistence, type DurabilityReport } from "../lib/durability.js";
import { createOwnedAgent, type OwnedAgent, type OwnedProfile } from "../runtime/bootstrap.js";
import { askPermission } from "./approvals.js";

const steps = ref<BootStep[]>(initialBootSteps());
const agentRef = shallowRef<OwnedAgent | null>(null);
const durability = ref<DurabilityReport | null>(null);
const failure = ref<string | null>(null);
let booting: Promise<OwnedAgent> | null = null;

export const bootSteps = computed(() => steps.value);
export const progress = computed(() => bootProgress(steps.value));
export const ready = computed(() => shellReady(steps.value) && agentRef.value !== null);
export const blocked = computed(() => bootFailed(steps.value));
export const bootError = computed(() => failure.value);
export const agent = computed<OwnedAgent | null>(() => agentRef.value);
export const profile = computed<OwnedProfile | null>(() => agentRef.value?.profile ?? null);
export const persistence = computed(() => durability.value);
export const stubs = computed(() => agentRef.value?.stubs ?? []);

export function markStep(id: StepId, state: StepState, detail?: string): void {
  steps.value = setStep(steps.value, id, state, detail);
}

/**
 * Idempotent: a second call while the first is in flight joins it. Vue's dev-mode double mount and a
 * hot reload both do exactly that, and scaffolding an agent twice would be a second agent.
 */
export function boot(identity?: { displayName: string; emoji: string }): Promise<OwnedAgent> {
  if (agentRef.value) return Promise.resolve(agentRef.value);
  if (booting) return booting;
  booting = (async () => {
    try {
      const owned = await createOwnedAgent({
        identity,
        askPermission,
        onStep: (id, state, detail) => markStep(id, state, detail),
      });
      agentRef.value = owned;
      // §3.3: ask on first creation, and SHOW the answer — never swallow a refusal.
      if (owned.freshlyCreated) durability.value = await requestPersistence();
      return owned;
    } catch (err) {
      failure.value = err instanceof Error ? err.message : String(err);
      markStep("workspace", "failed", failure.value);
      throw err;
    } finally {
      booting = null;
    }
  })();
  return booting;
}

/** After a Restore (§3.3), everything downstream of the filesystem has to be built again. */
export function forgetAgent(): void {
  agentRef.value = null;
  steps.value = initialBootSteps();
  failure.value = null;
}

export async function checkPersistence(): Promise<DurabilityReport> {
  const report = await requestPersistence();
  durability.value = report;
  return report;
}
