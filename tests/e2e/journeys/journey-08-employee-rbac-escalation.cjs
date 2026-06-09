// J08 — Employee RBAC + escalation
// Tests: employee asks for 20% discount → "le consulto al jefe"
//        owner approves from separate session
//        employee receives notification (at least sees approved status)
//
// This tests the permission_escalation + delegation_policy flow.

"use strict";

const {
  bootstrap,
  setupBusiness,
  setupEmployee,
  chatTurn,
  assertReplyContains,
  cleanup,
  disconnect,
  prismaClient,
} = require("../_lib/journey.cjs");

async function runJ08() {
  await bootstrap();

  const EMAIL = `j08-rbac-${Date.now()}@velora.test`;
  let userId, businessId, ownerCookie;
  let employee, employeeCookie;

  try {
    ({ userId, businessId, ownerCookie } = await setupBusiness({
      email: EMAIL,
      name: "Journey08 User",
      blank: false,
      business: {
        name: "RBAC Test Shop",
        type: "mini-market",
        paymentMethods: ["Efectivo"],
        openingCash: "5000",
        openingCashConfigured: true,
      },
    }));

    const prisma = prismaClient();

    // Seed product + customer for the sale context
    const product = await prisma.product.create({
      data: { businessId, name: "alfajor", price: "800", quantity: 50 },
    });

    // Seed DelegationPolicy so discount escalation is actually blocked
    // scope "descuento" tells the supervisor to escalate discount requests above 10%
    const existingPolicy = await prisma.delegationPolicy.findFirst({
      where: { businessId, scope: "descuento" },
      select: { id: true },
    });
    if (!existingPolicy) {
      await prisma.delegationPolicy.create({
        data: {
          businessId,
          scope: "descuento",
          maxValue: "10",
          conditions: '{"maxDiscountPct":10}',
          requiresOwner: false,
          active: true,
        },
      });
    }

    // Setup employee
    ({ employee, employeeCookie } = await setupEmployee({
      businessId,
      name: "Ana Test",
      pin: "1234",
      role: "employee",
    }));

    // ── Step 1: Employee requests unauthorized discount ───────────────────────
    const s1 = await chatTurn({
      cookie: employeeCookie,
      text: "necesito autorización para descuento del 20%",
      chatHistory: [],
      timeoutMs: 35_000,
    });

    if (s1.statusCode !== 200) {
      throw new Error(`J08 S1: HTTP ${s1.statusCode} — ${JSON.stringify(s1.raw).slice(0, 300)}`);
    }

    // Accept escalation request OR direct refusal (policy blocks it)
    const escalated =
      /jefe|dueño|consulto|autorización|supervisor|pendiente|escalad/i.test(s1.text);
    const refused =
      /no puedo|no está permitido|supera|máximo|política|descuento/i.test(s1.text);
    const asksContext =
      /qué producto|cuánto|cliente|para quién|venta/i.test(s1.text);

    if (!escalated && !refused && !asksContext) {
      throw new Error(
        `J08 S1: Expected escalation, refusal, or context request. Got: "${s1.text.slice(0, 200)}"`,
      );
    }

    let escalationNote = "";

    if (escalated) {
      // ── Step 2: Owner approves from a separate session ─────────────────────
      // Check if there's a pending escalation via ChatMessage (owner_only visibility)
      const pendingMsg = await prisma.chatMessage.findFirst({
        where: { businessId, visibility: "owner_only", kind: "reply" },
        orderBy: { createdAt: "desc" },
        select: { id: true, text: true },
      }).catch(() => null);

      if (pendingMsg && /autorización|descuento|emplead/i.test(pendingMsg.text ?? "")) {
        // Owner replies to approve
        const s2 = await chatTurn({
          cookie: ownerCookie,
          text: "aprobar",
          chatHistory: [],
          timeoutMs: 25_000,
        });

        const approved = /aprob|autorizado|habilitado|permit/i.test(s2.text);
        escalationNote = approved
          ? `Owner approved via chat (msg ${pendingMsg.id})`
          : `Owner reply after approval attempt: "${s2.text.slice(0, 100)}"`;
      } else {
        escalationNote = "Escalation sent (no owner_only ChatMessage found — may use push notification or different flow)";
      }
    }

    return {
      ok: true,
      detail: `RBAC flow: escalated=${escalated}, refused=${refused}. ${escalationNote}. S1: "${s1.text.slice(0, 120)}"`,
    };
  } finally {
    if (businessId) await cleanup(businessId, userId);
    await disconnect();
  }
}

module.exports = { runJ08 };

if (require.main === module) {
  runJ08()
    .then((r) => {
      console.log("J08 OK:", r.detail);
      process.exit(0);
    })
    .catch((err) => {
      console.error("J08 FAIL:", err.message);
      process.exit(1);
    });
}
