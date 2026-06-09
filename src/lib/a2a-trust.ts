// A2A Trust Framework — TrustedPeerAgent CRUD.
//
// The owner explicitly adds peer agents to their trusted list. Before the
// Supervisor invokes any external A2A agent, isPeerTrusted must return true.
//
// Inbound JWT assertion verification lives in a2a-trust-assertion.ts and is
// re-exported here so existing import sites keep working.

import { prisma } from "@/lib/prisma";
import { discoverAgent, evictDiscoveryCache, type PeerAgentCard } from "@/lib/a2a-discovery";
import { cloudLog } from "@/lib/cloud-logger";

export { verifyAgentAssertion } from "@/lib/a2a-trust-assertion";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface AddTrustedPeerResult {
  ok: boolean;
  agentCard?: PeerAgentCard;
  error?: string;
}

// ── Peer trust CRUD ───────────────────────────────────────────────────────────

/**
 * Returns true if the given domain is in the business's trusted peer list.
 * This is a synchronous DB read — call with await at the handler level.
 */
export async function isPeerTrusted(businessId: string, domain: string): Promise<boolean> {
  const row = await prisma.trustedPeerAgent.findUnique({
    where: { businessId_domain: { businessId, domain } },
    select: { id: true },
  });
  return row !== null;
}

/**
 * Discover the agent at `domain`, validate its card, and persist it.
 * If discovery fails the operation fails — we only trust agents we can verify.
 */
export async function addTrustedPeer(
  businessId: string,
  domain: string,
): Promise<AddTrustedPeerResult> {
  // Evict cache so we always get a fresh card on add.
  evictDiscoveryCache(domain);

  const agentCard = await discoverAgent(domain);
  if (!agentCard) {
    return {
      ok: false,
      error: `No se pudo descubrir el agente en "${domain}". Verificá que el dominio sea correcto y esté disponible.`,
    };
  }

  await prisma.trustedPeerAgent.upsert({
    where: { businessId_domain: { businessId, domain } },
    create: {
      businessId,
      domain,
      agentName: agentCard.name,
      agentCardJson: JSON.stringify(agentCard),
    },
    update: {
      agentName: agentCard.name,
      agentCardJson: JSON.stringify(agentCard),
    },
  });

  cloudLog({
    severity: "INFO",
    component: "A2A",
    action: "PEER_ADDED",
    a2a_transfer: false,
    message: `Trusted peer added: ${agentCard.name} (${domain})`,
    data: { businessId, domain, agentName: agentCard.name },
  });

  return { ok: true, agentCard };
}

/**
 * Remove a trusted peer. No-op if the domain was not in the list.
 */
export async function removeTrustedPeer(
  businessId: string,
  domain: string,
): Promise<void> {
  await prisma.trustedPeerAgent.deleteMany({
    where: { businessId, domain },
  });

  cloudLog({
    severity: "INFO",
    component: "A2A",
    action: "PEER_REMOVED",
    a2a_transfer: false,
    message: `Trusted peer removed: ${domain}`,
    data: { businessId, domain },
  });
}

/**
 * List all trusted peers for a business, newest first.
 */
export async function listTrustedPeers(businessId: string) {
  return prisma.trustedPeerAgent.findMany({
    where: { businessId },
    orderBy: { addedAt: "desc" },
    select: {
      id: true,
      domain: true,
      agentName: true,
      agentCardJson: true,
      addedAt: true,
      lastUsedAt: true,
    },
  });
}

/**
 * Mark a peer as used now (fire-and-forget update).
 */
export function touchPeerUsage(businessId: string, domain: string): void {
  prisma.trustedPeerAgent
    .updateMany({ where: { businessId, domain }, data: { lastUsedAt: new Date() } })
    .catch(() => undefined); // non-critical
}
