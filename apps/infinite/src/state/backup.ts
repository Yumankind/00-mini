/**
 * Backup and Restore — docs/HANDOFF-infinite-agent.md §3.3 and §7.2.
 *
 * WHY THIS IS OFFERED FROM DAY ONE, before anyone asks for it. `navigator.storage.persist()` can say
 * no, Safari evicts an origin nobody has opened for seven days, and a browser profile can be wiped by
 * someone who has no idea an agent lived in it. A `.00agent` file with a passphrase the person chose
 * is the only recovery that needs nothing of ours — no account, no network, no server.
 *
 * The download goes through a Blob URL that is revoked on the next tick. It has to be revoked: an
 * object URL holds the whole encrypted bundle alive in memory for as long as the document lives.
 */
import { computed, ref } from "vue";
import { backupFilename, passphraseMismatch, passphraseProblem } from "../lib/backup.js";
import { arrivedLine, carriedLine } from "../lib/vault-policy.js";
import { agent, forgetAgent } from "./agent.js";
import { releaseAfterRestore } from "./move.js";

const busy = ref(false);
const error = ref<string | null>(null);
const note = ref<string | null>(null);

export const backupBusy = computed(() => busy.value);
export const backupError = computed(() => error.value);
export const backupNote = computed(() => note.value);

export function validateNewPassphrase(a: string, b: string): string | null {
  return passphraseProblem(a) ?? passphraseMismatch(a, b);
}

/**
 * §4.5's tick, threaded through (gap audit A2). `carrySecrets` is a REQUIRED-BY-DEFAULT false rather
 * than an option object here because there is exactly one choice and the caller is one screen; the
 * bundle door beneath it (`OwnedAgent.exportBundleFile`) takes the object, where the next choice
 * will go.
 */
export async function exportBackup(passphrase: string, carrySecrets = false, at = new Date()): Promise<boolean> {
  const owned = agent.value;
  if (!owned) return false;
  busy.value = true;
  error.value = null;
  note.value = null;
  try {
    const blob = await owned.exportBundleFile(passphrase, { carrySecrets });
    const name = backupFilename(owned.profile, at);
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = name;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
    note.value = `Saved ${name}. Without that passphrase the file is noise — keep it somewhere else. ${carriedLine(carrySecrets)}`;
    return true;
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
    return false;
  } finally {
    busy.value = false;
  }
}

/**
 * Restore REPLACES what is in OPFS, so the caller confirms first and the store then forgets the live
 * agent: everything downstream of the filesystem — the loop, the sessions list, the tree — was built
 * against files that are no longer the ones on disk.
 */
export async function importBackup(file: File, passphrase: string): Promise<string | null> {
  const owned = agent.value;
  if (!owned) return null;
  busy.value = true;
  error.value = null;
  note.value = null;
  try {
    const { agentId, vaultTravelled } = await owned.importBundleFile(file, passphrase);
    // §7: a restore is how a moved agent comes home, so it is also what takes the lock off the
    // receipt. Released BEFORE the reload the caller does, or the shell would paint the receipt over
    // the agent that has just arrived.
    await releaseAfterRestore();
    note.value = `Restored ${agentId}. ${arrivedLine(vaultTravelled)} Reopening…`;
    forgetAgent();
    return agentId;
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
    return null;
  } finally {
    busy.value = false;
  }
}

export function clearBackupMessages(): void {
  error.value = null;
  note.value = null;
}
