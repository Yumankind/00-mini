/**
 * The Backup file — docs/HANDOFF-infinite-agent.md §3.3 and §7.2.
 *
 * WHY THE NAME IS A RULE AND NOT A TEMPLATE STRING AT THE CALL SITE. This file is the thing a person
 * has after Safari evicts the origin, and it lands in a Downloads folder next to a year of other
 * files. It has to sort by date, say which agent it is, and survive being renamed by a share sheet —
 * so the id is IN the name (the display name may repeat, the id may not) and the timestamp is UTC and
 * lexicographic. The restore side reads the id back out of it to tell the person what they are about
 * to replace, which is why the shape is pinned by a test rather than left to a caller.
 */

/** Lowercase, hyphenated, ASCII: the part of the name that came from a person and cannot be trusted. */
export function slugName(name: string): string {
  const slug = name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
    .replace(/-+$/g, "");
  return slug || "agent";
}

function two(n: number): string {
  return String(n).padStart(2, "0");
}

/** `<name>-<id>-<YYYYMMDD-HHMM>.00agent`, always UTC so two devices agree. */
export function backupFilename(agent: { id: string; displayName: string }, at: Date): string {
  const stamp = `${at.getUTCFullYear()}${two(at.getUTCMonth() + 1)}${two(at.getUTCDate())}-${two(
    at.getUTCHours(),
  )}${two(at.getUTCMinutes())}`;
  return `${slugName(agent.displayName)}-${agent.id}-${stamp}.00agent`;
}

export function isBundleFilename(name: string): boolean {
  return /\.00agent$/i.test(name);
}

/** The id a `.00agent` name carries, when it was made by us; null for a file renamed past recognition. */
export function agentIdFromFilename(name: string): string | null {
  const m = /^[a-z0-9-]+-([A-Za-z0-9_-]{12})-\d{8}-\d{4}\.00agent$/i.exec(name);
  return m ? m[1] : null;
}

/**
 * The passphrase gate. Deliberately a floor and not a strength meter: the bundle is AES-256-GCM and
 * the passphrase is the only key, so what matters is refusing the empty and the four-character ones,
 * and saying the true thing — that a forgotten passphrase is a lost agent.
 */
export function passphraseProblem(passphrase: string): string | null {
  if (!passphrase) return "A passphrase is required — the file is useless without one.";
  if (passphrase.length < 8) return "At least 8 characters.";
  if (passphrase.trim().length === 0) return "Spaces only is not a passphrase.";
  return null;
}

export function passphraseMismatch(a: string, b: string): string | null {
  return a === b ? null : "The two passphrases do not match.";
}
