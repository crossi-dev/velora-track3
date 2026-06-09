// tests/e2e/_lib/journey.cjs
// Core helper library for Velora E2E journey tests.
//
// Provides:
//   setupBusiness(opts)    — seed User+Business via direct Prisma + mint owner cookie
//   setupEmployee(opts)    — create Employee row + mint signed HMAC cookie
//   chatTurn(opts)         — POST /api/business-assistant, return structured reply
//   assertBusinessState(opts) — Prisma assertions on live DB
//   cleanup(businessId)    — full tenant wipe
//
// Auth strategy:
//   Owner  → JWE cookie minted with @auth/core/jwt (same as _seed-demo-owner.mjs)
//   Employee → HMAC-signed cookie (same as smoke-prod-500.mjs signEmployeeSession)
//
// Designed to run against https://somosvelora.com (PROD).
// DB_URL is pulled from Secret Manager (same gate as _seed-demo-owner.mjs).
// AUTH_SECRET is pulled from Secret Manager.

"use strict";

const { execSync } = require("node:child_process");
const { createHmac, randomUUID } = require("node:crypto");
const { PrismaClient } = require("@prisma/client");

// ─── Secret Manager bootstrap (lazy, cached) ──────────────────────────────────

let _bootstrapped = false;
let _authSecret = null;
let _prisma = null;

function sm(name) {
  return execSync(`gcloud secrets versions access latest --secret=${name}`, {
    encoding: "utf8",
  }).trim();
}

/**
 * Must be called once before any journey helper.
 * Loads secrets and initialises Prisma.
 */
async function bootstrap() {
  if (_bootstrapped) return;
  process.env.DATABASE_URL = sm("DATABASE_URL");
  process.env.DIRECT_URL   = sm("DATABASE_URL");
  _authSecret = sm("AUTH_SECRET");
  process.env.AUTH_SECRET  = _authSecret;
  _prisma = new PrismaClient();
  _bootstrapped = true;
}

function prismaClient() {
  if (!_prisma) throw new Error("journey: call bootstrap() first");
  return _prisma;
}

function authSecret() {
  if (!_authSecret) throw new Error("journey: call bootstrap() first");
  return _authSecret;
}

// ─── Cookie minting ───────────────────────────────────────────────────────────

/**
 * Mint a NextAuth JWE session cookie for the owner.
 * Returns the full "Cookie: ..." header value string.
 */
async function mintOwnerCookie(userId, email, name) {
  const { encode } = await import("@auth/core/jwt");
  const SALT = "__Secure-authjs.session-token";
  const token = await encode({
    token: { sub: userId, id: userId, email, name },
    secret: authSecret(),
    salt: SALT,
    maxAge: 7 * 24 * 60 * 60,
  });
  return `${SALT}=${token}`;
}

/**
 * Mint an employee HMAC session cookie.
 * Returns the full "Cookie: ..." header value string.
 */
function mintEmployeeCookie(employeeId, businessId, role) {
  const payload = { employeeId, businessId, role, exp: Date.now() + 8 * 60 * 60 * 1000 };
  const b64 = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = createHmac("sha256", authSecret()).update(b64).digest("base64url");
  return `velora-employee-session=${b64}.${sig}`;
}

// ─── DB seeding helpers ───────────────────────────────────────────────────────

/**
 * Create (or reset) a User+Business for a journey test.
 * Returns { userId, businessId, ownerCookie }.
 *
 * opts:
 *   email       — test user email (must be unique per journey run)
 *   name        — display name
 *   blank       — if true, business is created in blank onboarding state
 *   business    — optional partial Business fields to set on creation/reset
 */
async function setupBusiness(opts) {
  const {
    email,
    name = "Journey Test User",
    blank = false,
    business: bizOverride = {},
  } = opts;

  const prisma = prismaClient();
  const timestamp = Date.now();
  const journeyEmail = email ?? `journey-${timestamp}@velora.test`;

  // Upsert user
  let user = await prisma.user.findUnique({
    where: { email: journeyEmail },
    select: { id: true },
  });

  if (!user) {
    user = await prisma.user.create({
      data: { email: journeyEmail, name },
      select: { id: true },
    });
  }

  // Default business data
  const defaultBizData = blank
    ? {
        name: "",
        type: "",
        paymentMethods: [],
        openingCash: "0",
        openingCashConfigured: false,
        currency: "ARS",
        taxRate: "0",
      }
    : {
        name: "Journey Test Business",
        type: "mini-market",
        paymentMethods: ["Efectivo"],
        openingCash: "0",
        openingCashConfigured: true,
        currency: "ARS",
        taxRate: "0",
        ...bizOverride,
      };

  // Upsert business
  let biz = await prisma.business.findUnique({
    where: { userId: user.id },
    select: { id: true },
  });

  if (biz) {
    // Full wipe then reset fields
    await _wipeBusinessData(prisma, biz.id);
    await prisma.business.update({
      where: { id: biz.id },
      data: defaultBizData,
    });
  } else {
    biz = await prisma.business.create({
      data: { userId: user.id, ...defaultBizData },
      select: { id: true },
    });
  }

  // Seed MpConnection placeholder so cobro QR gate passes
  await prisma.mpConnection.upsert({
    where: { businessId: biz.id },
    create: {
      businessId: biz.id,
      mpUserId: `journey-mp-${biz.id.slice(-6)}`,
      accessToken: "JOURNEY_PLACEHOLDER_TOKEN",
      refreshToken: "JOURNEY_PLACEHOLDER_REFRESH",
      liveMode: false,
      expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
    },
    update: {
      accessToken: "JOURNEY_PLACEHOLDER_TOKEN",
      refreshToken: "JOURNEY_PLACEHOLDER_REFRESH",
      liveMode: false,
      expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
    },
  });

  // Seed TrustedPeerAgent for Distribuidora Mendoza (needed by J07)
  const DIST_DOMAIN = "somosvelora.com/api/peers/distribuidora-mendoza";
  await prisma.trustedPeerAgent.upsert({
    where: { businessId_domain: { businessId: biz.id, domain: DIST_DOMAIN } },
    create: {
      businessId: biz.id,
      domain: DIST_DOMAIN,
      agentName: "Distribuidora Mendoza",
      agentCardJson: JSON.stringify({
        name: "Distribuidora Mendoza",
        url: "https://somosvelora.com/api/peers/distribuidora-mendoza",
        version: "1.0",
        skills: [
          { id: "wholesale.price.quote", name: "Cotización de precio mayorista" },
          { id: "wholesale.order.create", name: "Crear orden de compra" },
        ],
      }),
    },
    update: {
      agentName: "Distribuidora Mendoza",
    },
  });

  const ownerCookie = await mintOwnerCookie(user.id, journeyEmail, name);

  return { userId: user.id, businessId: biz.id, ownerCookie };
}

/**
 * Create an Employee for a business. Returns { employee, employeeCookie }.
 *
 * opts:
 *   businessId   — required
 *   name         — employee name (default "Ana Test")
 *   pin          — PIN string (default "1234")
 *   role         — default "employee"
 */
async function setupEmployee(opts) {
  const {
    businessId,
    name = "Ana Test",
    pin = "1234",
    role = "employee",
  } = opts;

  const prisma = prismaClient();

  // hashPin from src/lib/employee-auth.ts — replicated here to avoid TS import hell
  const { scryptSync, randomBytes } = require("node:crypto");
  const salt = randomBytes(16);
  const derived = scryptSync(pin, salt, 32, { N: 16384 });
  const pinHash = `v1$${salt.toString("hex")}$${derived.toString("hex")}`;

  let employee;
  try {
    employee = await prisma.employee.upsert({
      where: { businessId_name: { businessId, name } },
      create: { businessId, name, pinHash, role, active: true },
      update: { pinHash, role, active: true, failedPinAttempts: 0, lockedUntil: null },
    });
  } catch (err) {
    // Unique constraint on businessId+name — create with a timestamp suffix if collision
    const uniqueName = `${name}-${Date.now()}`;
    employee = await prisma.employee.create({
      data: { businessId, name: uniqueName, pinHash, role, active: true },
    });
  }

  const employeeCookie = mintEmployeeCookie(employee.id, businessId, role);
  return { employee, employeeCookie };
}

// ─── HTTP chat helper ─────────────────────────────────────────────────────────

const BASE_URL = (process.env.JOURNEY_BASE_URL ?? "https://somosvelora.com").replace(/\/$/, "");

/**
 * Send one chat turn to /api/business-assistant.
 * Returns { text, agentActivity, actions, confirmationRequest, statusCode, raw }.
 *
 * opts:
 *   cookie         — full Cookie header value (owner or employee)
 *   text           — the message text
 *   chatHistory    — optional prior history array
 *   timeoutMs      — fetch timeout (default 30_000)
 */
async function chatTurn(opts) {
  const {
    cookie,
    text,
    chatHistory = [],
    timeoutMs = 30_000,
  } = opts;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let res;
  try {
    res = await fetch(`${BASE_URL}/api/business-assistant`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: cookie,
        "X-Idempotency-Key": randomUUID(),
        // Origin must match NEXTAUTH_URL (somosvelora.com) to pass the middleware CSRF check.
        // Node.js fetch doesn't send Origin automatically on cross-origin requests to external hosts,
        // so we inject it explicitly here. This mirrors what the browser sends on the real app.
        Origin: BASE_URL,
        Referer: `${BASE_URL}/dashboard`,
      },
      body: JSON.stringify({ text, chatHistory, lang: "es-AR" }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  const statusCode = res.status;
  let raw;
  try {
    raw = await res.json();
  } catch {
    raw = {};
  }

  return {
    statusCode,
    text: typeof raw.answer === "string" ? raw.answer : "",
    agentActivity: Array.isArray(raw.agentActivity) ? raw.agentActivity : [],
    actions: Array.isArray(raw.actions) ? raw.actions : [],
    confirmationRequest: raw.confirmationRequest ?? null,
    chips: raw.chips ?? null,
    raw,
  };
}

// ─── DB assertion helper ──────────────────────────────────────────────────────

/**
 * Assert business state in the database. Throws with descriptive message if failed.
 * Returns the full business snapshot for additional caller assertions.
 *
 * opts:
 *   businessId     — required
 *   name           — assert Business.name
 *   type           — assert Business.type (case-insensitive)
 *   paymentMethodsInclude — array of strings that must all appear in paymentMethods
 *   openingCashMin — assert openingCash >= value
 *   productCount   — exact count of products
 *   productCountMin — minimum count
 *   inventoryQuantityMin — minimum total inventory across all products
 */
async function assertBusinessState(opts) {
  const {
    businessId,
    name: expectedName,
    type: expectedType,
    paymentMethodsInclude = [],
    openingCashMin,
    productCount,
    productCountMin,
    inventoryQuantityMin,
  } = opts;

  const prisma = prismaClient();

  const biz = await prisma.business.findUnique({
    where: { id: businessId },
    select: {
      name: true,
      type: true,
      paymentMethods: true,
      openingCash: true,
      openingCashConfigured: true,
      products: {
        select: {
          id: true,
          name: true,
          quantity: true,
        },
      },
    },
  });

  if (!biz) throw new Error(`assertBusinessState: business ${businessId} not found`);

  if (expectedName !== undefined) {
    if (biz.name !== expectedName) {
      throw new Error(`assertBusinessState: name expected "${expectedName}", got "${biz.name}"`);
    }
  }

  if (expectedType !== undefined) {
    const norm = (s) => s.toLowerCase().replace(/[\s-]/g, "");
    if (norm(biz.type) !== norm(expectedType)) {
      throw new Error(`assertBusinessState: type expected "${expectedType}", got "${biz.type}"`);
    }
  }

  for (const pm of paymentMethodsInclude) {
    if (!biz.paymentMethods.some((m) => m.toLowerCase() === pm.toLowerCase())) {
      throw new Error(
        `assertBusinessState: paymentMethod "${pm}" not in [${biz.paymentMethods.join(",")}]`,
      );
    }
  }

  if (openingCashMin !== undefined) {
    const cash = Number(biz.openingCash ?? 0);
    if (cash < openingCashMin) {
      throw new Error(`assertBusinessState: openingCash ${cash} < expected min ${openingCashMin}`);
    }
  }

  if (productCount !== undefined) {
    if (biz.products.length !== productCount) {
      throw new Error(
        `assertBusinessState: productCount expected ${productCount}, got ${biz.products.length}`,
      );
    }
  }

  if (productCountMin !== undefined) {
    if (biz.products.length < productCountMin) {
      throw new Error(
        `assertBusinessState: productCountMin ${productCountMin}, got ${biz.products.length}`,
      );
    }
  }

  if (inventoryQuantityMin !== undefined) {
    const totalQty = biz.products.reduce((sum, p) => {
      return sum + (p.quantity ? Number(p.quantity) : 0);
    }, 0);
    if (totalQty < inventoryQuantityMin) {
      throw new Error(
        `assertBusinessState: totalInventory ${totalQty} < expected min ${inventoryQuantityMin}`,
      );
    }
  }

  return biz;
}

// ─── Cleanup helper ───────────────────────────────────────────────────────────

/**
 * Full tenant wipe — removes all business data and the User.
 * Safe to call multiple times (idempotent).
 */
async function cleanup(businessId, userId = null) {
  const prisma = prismaClient();
  try {
    await _wipeBusinessData(prisma, businessId);
    await prisma.business.deleteMany({ where: { id: businessId } });
    if (userId) {
      await prisma.session.deleteMany({ where: { userId } });
      await prisma.account.deleteMany({ where: { userId } });
      await prisma.user.deleteMany({ where: { id: userId } });
    }
  } catch (err) {
    // Non-fatal: log but don't break the test report
    console.warn(`[journey] cleanup error for business ${businessId}:`, err.message);
  }
}

async function _wipeBusinessData(prisma, bizId) {
  // Order matters — FK deps cascade outward
  await prisma.$transaction([
    prisma.saleItem.deleteMany({ where: { sale: { businessId: bizId } } }),
    prisma.cashMovement.deleteMany({ where: { businessId: bizId } }),
    prisma.sale.deleteMany({ where: { businessId: bizId } }),
    prisma.stockMovement.deleteMany({ where: { businessId: bizId } }),
    prisma.product.deleteMany({ where: { businessId: bizId } }),
    prisma.chatMessage.deleteMany({ where: { businessId: bizId } }),
    prisma.businessRule.deleteMany({ where: { businessId: bizId } }),
    prisma.supplier.deleteMany({ where: { businessId: bizId } }),
    prisma.mpConnection.deleteMany({ where: { businessId: bizId } }),
    prisma.trustedPeerAgent.deleteMany({ where: { businessId: bizId } }),
    prisma.paymentIntent.deleteMany({ where: { businessId: bizId } }),
    prisma.invoice.deleteMany({ where: { businessId: bizId } }),
    prisma.andreaniShipment.deleteMany({ where: { businessId: bizId } }),
    prisma.budget.deleteMany({ where: { businessId: bizId } }),
    prisma.customer.deleteMany({ where: { businessId: bizId } }),
    prisma.employee.deleteMany({ where: { businessId: bizId } }),
  ]);
}

// ─── Text assertion helper ─────────────────────────────────────────────────────

/**
 * Assert that a reply text contains at least one of the given substrings (case-insensitive).
 * Throws with a human-readable message if none match.
 */
function assertReplyContains(replyText, patterns, stepLabel = "") {
  const lower = replyText.toLowerCase();
  const matches = patterns.some((p) => lower.includes(p.toLowerCase()));
  if (!matches) {
    const label = stepLabel ? `[${stepLabel}] ` : "";
    throw new Error(
      `${label}Reply does not contain any of [${patterns.join(" | ")}].\nActual reply: ${replyText.slice(0, 300)}`,
    );
  }
}

// ─── Disconnect helper ─────────────────────────────────────────────────────────

async function disconnect() {
  if (_prisma) {
    await _prisma.$disconnect().catch(() => {});
    _prisma = null;
    _bootstrapped = false;
  }
}

module.exports = {
  bootstrap,
  setupBusiness,
  setupEmployee,
  chatTurn,
  assertBusinessState,
  assertReplyContains,
  cleanup,
  disconnect,
  prismaClient,
};
