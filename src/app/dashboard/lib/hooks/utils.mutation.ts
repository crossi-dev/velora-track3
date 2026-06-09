"use client";

const MUTATION_KEYS_STORAGE = "velora-mutation-keys";
const MUTATION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

function readAndPruneMutationKeys(): Record<string, { key: string; createdAt: number }> {
  if (typeof window === "undefined") return {};
  try {
    const raw = JSON.parse(localStorage.getItem(MUTATION_KEYS_STORAGE) || "{}");
    const now = Date.now();
    const pruned: Record<string, { key: string; createdAt: number }> = {};
    let changed = false;
    for (const [sig, entry] of Object.entries(raw)) {
      // Migrate legacy entries (plain string UUID → timestamped object)
      if (typeof entry === "string") {
        pruned[sig] = { key: entry, createdAt: now };
        changed = true;
      } else if (entry && typeof entry === "object" && typeof (entry as Record<string, unknown>).key === "string") {
        const e = entry as { key: string; createdAt: number };
        if (now - (e.createdAt ?? 0) < MUTATION_TTL_MS) {
          pruned[sig] = e;
        } else {
          changed = true;
        }
      } else {
        changed = true;
      }
    }
    if (changed) {
      localStorage.setItem(MUTATION_KEYS_STORAGE, JSON.stringify(pruned));
    }
    return pruned;
  } catch {
    return {};
  }
}

export function clearMutationKey(signature: string) {
  if (typeof window !== "undefined") {
    const keys = readAndPruneMutationKeys();
    delete keys[signature];
    localStorage.setItem(MUTATION_KEYS_STORAGE, JSON.stringify(keys));
  }
}

/**
 * Removes all mutation keys whose signature starts with the given action type prefix.
 * Used when an action is undone so the next identical payload gets a fresh idempotency key.
 */
export function clearMutationKeysForAction(actionType: string) {
  if (typeof window === "undefined") return;
  const keys = readAndPruneMutationKeys();
  const prefix = `${actionType}:`;
  let changed = false;
  for (const sig of Object.keys(keys)) {
    if (sig.startsWith(prefix)) {
      delete keys[sig];
      changed = true;
    }
  }
  if (changed) {
    localStorage.setItem(MUTATION_KEYS_STORAGE, JSON.stringify(keys));
  }
}

export function getOrCreateMutationKey(signature: string) {
  if (typeof window === "undefined") return crypto.randomUUID();
  const keys = readAndPruneMutationKeys();
  if (keys[signature]) return keys[signature].key;
  const nextKey = crypto.randomUUID();
  keys[signature] = { key: nextKey, createdAt: Date.now() };
  localStorage.setItem(MUTATION_KEYS_STORAGE, JSON.stringify(keys));
  return nextKey;
}

export function buildMutationHeaders(signature: string) {
  return {
    "Content-Type": "application/json",
    "X-Idempotency-Key": getOrCreateMutationKey(signature),
  };
}

export function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableSerialize(entry)).join(",")}]`;
  }

  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableSerialize(entry)}`);

    return `{${entries.join(",")}}`;
  }

  return JSON.stringify(value);
}

export function createMutationSignature(scope: string, payload: unknown) {
  return `${scope}:${stableSerialize(payload)}`;
}
