<script setup lang="ts">
/**
 * The approvals door — §4.3, three tiers, three buttons.
 *
 * The MODAL IS THE DECISION, not a notification: the loop is blocked on the promise behind these
 * buttons. So there is no way to dismiss it by clicking outside and no Escape key — an accidental
 * dismissal would either hang the run or silently answer for the person, and both are worse than a
 * dialog that insists. The arguments are shown in full, because "allow `write`" without the path is
 * not a question anyone can answer.
 */
import { computed } from "vue";
import TablerIcon from "./TablerIcon.vue";
import { TIER_HEADLINE } from "../lib/conversation.js";
import { allowAlways, allowOnce, current, refuse, waiting } from "../state/approvals.js";

const args = computed(() => {
  const item = current.value;
  if (!item) return "";
  try {
    return JSON.stringify(item.args, null, 2);
  } catch {
    return String(item.args);
  }
});

const tone = computed(() => (current.value?.tier === "high-risk" ? "var(--color-red)" : "var(--color-amber)"));
</script>

<template>
  <div
    v-if="current"
    class="fixed inset-0 z-[70] flex items-end sm:items-center justify-center p-0 sm:p-6"
    style="background: rgba(0, 0, 0, 0.55)"
  >
    <div
      class="ia-float w-full max-w-md overflow-hidden ia-rise rounded-b-none sm:rounded-2xl"
      :style="{ borderColor: tone, paddingBottom: 'env(safe-area-inset-bottom)' }"
    >
      <div class="flex items-start gap-2.5 px-4 pt-4">
        <TablerIcon name="shield-lock" :size="18" :style="{ color: tone }" class="mt-0.5 shrink-0" />
        <div class="min-w-0">
          <div class="text-[15px] font-semibold tracking-tight">{{ TIER_HEADLINE[current.tier] }}</div>
          <div class="text-[11px] text-[var(--color-ink-faint)]">
            {{ current.tier }} · <span class="font-mono">{{ current.name }}</span>
            <span v-if="waiting > 1"> · {{ waiting - 1 }} more waiting</span>
          </div>
        </div>
      </div>

      <pre
        class="mx-4 my-3 text-[11.5px] font-mono leading-[1.55] whitespace-pre-wrap break-words max-h-56 ia-scroll rounded-xl p-3"
        :style="{ background: 'var(--color-panel)' }"
        >{{ args }}</pre
      >

      <div class="flex flex-col-reverse sm:flex-row gap-2 px-4 pb-4">
        <button type="button" class="ia-btn flex-1 h-10 text-[13px]" @click="refuse(current.id)">Cancel</button>
        <button type="button" class="ia-btn flex-1 h-10 text-[13px]" @click="allowOnce(current.id)">Allow once</button>
        <button type="button" class="ia-btn ia-btn-primary flex-1 h-10 text-[13px]" @click="allowAlways(current.id)">
          Always allow
        </button>
      </div>
      <p class="px-4 pb-4 -mt-1 text-[11px] text-[var(--color-ink-faint)] leading-relaxed">
        “Always” is remembered for this tool on this origin, and travels with your agent.
      </p>
    </div>
  </div>
</template>
