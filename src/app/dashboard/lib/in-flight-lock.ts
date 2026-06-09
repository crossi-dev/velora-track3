// Module-scoped in-flight lock keyed by businessId (or "global" when null).
// Shared between useAssistantChat and useAssistantConfirmation to prevent
// concurrent mutations when the user triggers a chat send and a confirmation
// confirm at overlapping times.

const locks = new Map<string, boolean>();

function keyFor(businessId: string | null | undefined): string {
  return businessId ?? "global";
}

export function isInFlight(businessId: string | null | undefined): boolean {
  return locks.get(keyFor(businessId)) === true;
}

export function acquireInFlight(businessId: string | null | undefined): boolean {
  const key = keyFor(businessId);
  if (locks.get(key)) return false;
  locks.set(key, true);
  return true;
}

export function releaseInFlight(businessId: string | null | undefined): void {
  locks.delete(keyFor(businessId));
}
