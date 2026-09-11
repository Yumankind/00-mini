<script setup lang="ts">
/**
 * The Git panel — status, diff, stage, commit, log, branches, for one `projects/<name>` folder.
 *
 * WHY THE REFUSALS ARE ON SCREEN RATHER THAN BEHIND A DISABLED BUTTON. Clone, push and pull cannot
 * work from a page (§4.2: github.com sends no CORS header, and no proxy has been chosen), and
 * unstaging has no wrapper in `@00/agent-fs` yet. A greyed button teaches nothing; a line that says
 * which machine can do it is the same answer the rest of this app gives about the Mac.
 */
import { onMounted, ref, watch } from "vue";
import TablerIcon from "./TablerIcon.vue";
import { GIT_UNAVAILABLE, gitUsable } from "../power/git-bridge.js";
import { statusLetter } from "../state/git.js";
import {
  REMOTE_LINE,
  chooseRepo,
  commitStaged,
  gitCommitProblem,
  gitInitialised,
  gitRepos,
  gitSplit,
  gitState,
  initRepo,
  openDiff,
  refreshGit,
  setCommitMessage,
  stagePaths,
  switchBranch,
  unstagePath,
} from "../state/git.js";
import { refreshFiles } from "../state/files.js";

const newBranch = ref("");

onMounted(async () => {
  await refreshFiles();
  if (!gitState.value.repo && gitRepos.value.length === 1) await chooseRepo(gitRepos.value[0]!);
});

watch(gitRepos, async (repos) => {
  if (!gitState.value.repo && repos.length === 1) await chooseRepo(repos[0]!);
});

function shortName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

async function createBranch(): Promise<void> {
  const name = newBranch.value.trim();
  if (!name) return;
  newBranch.value = "";
  await switchBranch(name, true);
}
</script>

<template>
  <div class="h-full flex flex-col min-h-0">
    <div class="flex items-center gap-2 px-3 h-11 border-b border-[var(--color-line)] shrink-0">
      <TablerIcon name="history" :size="14" class="text-[var(--color-ink-faint)] shrink-0" />
      <span class="ia-label font-pixel">Git</span>
      <select
        class="ia-input h-7 py-0 text-[11px] max-w-[180px]"
        :value="gitState.repo ?? ''"
        @change="chooseRepo(($event.target as HTMLSelectElement).value || null)"
      >
        <option value="">Pick a project…</option>
        <option v-for="repo in gitRepos" :key="repo" :value="repo">{{ shortName(repo) }}</option>
      </select>
      <button
        type="button"
        class="ia-btn ia-btn-ghost w-7 h-7 ml-auto"
        title="Reload"
        :disabled="!gitState.repo"
        @click="refreshGit()"
      >
        <TablerIcon name="refresh" :size="13" />
      </button>
    </div>

    <div class="flex-1 ia-scroll">
      <p v-if="!gitUsable()" class="text-[12px] text-[var(--color-ink-dim)] p-4">{{ GIT_UNAVAILABLE }}</p>

      <p v-else-if="!gitRepos.length" class="text-[12px] text-[var(--color-ink-dim)] p-4">
        No projects yet. A project is one folder under
        <span class="font-mono">workspace/projects/</span>, and that is where a repository goes.
      </p>

      <p v-else-if="!gitState.repo" class="text-[12px] text-[var(--color-ink-dim)] p-4">Pick a project.</p>

      <template v-else>
        <p v-if="gitState.error" class="text-[11px] text-[var(--color-red)] px-3 py-2">{{ gitState.error }}</p>

        <div v-if="!gitInitialised" class="p-4">
          <p class="text-[12px] text-[var(--color-ink-dim)] mb-3">
            <span class="font-mono">{{ gitState.repo }}</span> is not a repository yet.
          </p>
          <button type="button" class="ia-btn ia-btn-primary h-8 px-3 text-[11px]" :disabled="gitState.busy" @click="initRepo()">
            Initialise a repository here
          </button>
        </div>

        <template v-else>
          <!-- Branches. -->
          <div class="px-3 py-2 border-b border-[var(--color-line)] flex items-center gap-1.5 flex-wrap">
            <span class="ia-label font-pixel">Branch</span>
            <button
              v-for="branch in gitState.status?.branches ?? []"
              :key="branch"
              type="button"
              class="ia-btn h-6 px-2 text-[10px] font-mono"
              :class="branch === gitState.status?.branch ? 'ia-btn-on' : ''"
              :disabled="gitState.busy"
              @click="switchBranch(branch)"
            >
              {{ branch }}
            </button>
            <span v-if="!gitState.status?.branches.length" class="text-[10px] text-[var(--color-ink-dim)]">
              none yet — nothing has been committed
            </span>
            <form class="flex items-center gap-1 ml-auto" @submit.prevent="createBranch()">
              <input v-model="newBranch" class="ia-input h-6 py-0 text-[10px] w-28" placeholder="new branch" />
              <button type="submit" class="ia-btn h-6 px-2 text-[10px]" :disabled="!newBranch.trim()">Create</button>
            </form>
          </div>

          <!-- Changes. -->
          <div class="px-3 py-2 border-b border-[var(--color-line)]">
            <div class="flex items-center gap-2 mb-1.5">
              <span class="ia-label font-pixel">Changes</span>
              <button
                v-if="gitSplit.unstaged.length"
                type="button"
                class="ia-btn h-6 px-2 text-[10px] ml-auto"
                :disabled="gitState.busy"
                @click="stagePaths(['.'])"
              >
                Stage all
              </button>
            </div>

            <p v-if="!gitSplit.staged.length && !gitSplit.unstaged.length" class="text-[11px] text-[var(--color-ink-dim)] py-1">
              Working tree clean.
            </p>

            <button
              v-for="entry in gitSplit.unstaged"
              :key="`u-${entry.path}`"
              type="button"
              class="w-full flex items-center gap-2 px-1 py-1 rounded-md text-left hover:bg-[color-mix(in_srgb,var(--color-panel-2)_70%,transparent)]"
              :class="gitState.selected === entry.path ? 'bg-[color-mix(in_srgb,var(--color-phosphor)_12%,transparent)]' : ''"
              @click="openDiff(entry.path)"
            >
              <span class="font-mono text-[10px] w-3 text-[var(--color-amber)]">{{ statusLetter(entry.status) }}</span>
              <span class="text-[11px] font-mono truncate">{{ entry.path }}</span>
              <span
                class="ia-btn ml-auto shrink-0 h-5 px-1.5 text-[10px] flex items-center"
                title="Stage"
                @click.stop="stagePaths([entry.path])"
              >
                Stage
              </span>
            </button>

            <div v-if="gitSplit.staged.length" class="mt-2">
              <span class="ia-label font-pixel">Staged</span>
              <button
                v-for="entry in gitSplit.staged"
                :key="`s-${entry.path}`"
                type="button"
                class="w-full flex items-center gap-2 px-1 py-1 rounded-md text-left hover:bg-[color-mix(in_srgb,var(--color-panel-2)_70%,transparent)]"
                :class="gitState.selected === entry.path ? 'bg-[color-mix(in_srgb,var(--color-phosphor)_12%,transparent)]' : ''"
                @click="openDiff(entry.path)"
              >
                <span class="font-mono text-[10px] w-3 text-[var(--color-phosphor)]">{{ statusLetter(entry.status) }}</span>
                <span class="text-[11px] font-mono truncate">{{ entry.path }}</span>
                <span
                  class="ia-btn ml-auto shrink-0 h-5 px-1.5 text-[10px] flex items-center"
                  title="Unstage"
                  @click.stop="unstagePath(entry.path)"
                >
                  Unstage
                </span>
              </button>
            </div>
          </div>

          <!-- Commit. -->
          <form class="px-3 py-2 border-b border-[var(--color-line)]" @submit.prevent="commitStaged()">
            <textarea
              :value="gitState.message"
              class="ia-input text-[11px] font-sans resize-none"
              rows="2"
              placeholder="Why this change, not what."
              @input="setCommitMessage(($event.target as HTMLTextAreaElement).value)"
            />
            <div class="flex items-center gap-2 mt-1.5">
              <span class="text-[10px] text-[var(--color-ink-dim)]">{{ gitCommitProblem ?? "&nbsp;" }}</span>
              <button
                type="submit"
                class="ia-btn ia-btn-primary h-7 px-3 text-[11px] ml-auto"
                :disabled="Boolean(gitCommitProblem) || gitState.busy"
              >
                Commit
              </button>
            </div>
          </form>

          <!-- Diff. -->
          <div v-if="gitState.selected" class="border-b border-[var(--color-line)]">
            <div class="px-3 py-1.5 text-[10px] font-mono text-[var(--color-ink-dim)]">{{ gitState.selected }}</div>
            <pre
              v-if="gitState.diff"
              class="px-3 pb-2 text-[11px] font-mono leading-[1.5] overflow-x-auto"
            ><span v-for="(row, i) in gitState.diff.split('\n')" :key="i" :class="
                row.startsWith('+') && !row.startsWith('+++') ? 'text-[var(--color-phosphor)]'
                : row.startsWith('-') && !row.startsWith('---') ? 'text-[var(--color-red)]'
                : row.startsWith('@@') ? 'text-[var(--color-cyan)]'
                : 'text-[var(--color-ink-dim)]'
              ">{{ row }}
</span></pre>
            <p v-else class="px-3 pb-2 text-[11px] text-[var(--color-ink-dim)] ia-pulse">Reading the diff…</p>
          </div>

          <!-- Log. -->
          <div class="px-3 py-2">
            <span class="ia-label font-pixel">Log</span>
            <p v-if="!gitState.log.length" class="text-[11px] text-[var(--color-ink-dim)] py-1">No commits yet.</p>
            <div v-for="commit in gitState.log" :key="commit.oid" class="flex items-baseline gap-2 py-0.5">
              <span class="font-mono text-[10px] text-[var(--color-phosphor-dim)] shrink-0">{{ commit.oid.slice(0, 7) }}</span>
              <span class="text-[11px] truncate">{{ commit.message.split("\n")[0] }}</span>
            </div>
          </div>
        </template>

        <p class="px-3 py-2 text-[10px] text-[var(--color-ink-dim)] border-t border-[var(--color-line)]">
          {{ REMOTE_LINE }}
        </p>
      </template>
    </div>
  </div>
</template>
