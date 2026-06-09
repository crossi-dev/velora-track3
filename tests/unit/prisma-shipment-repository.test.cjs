"use strict";

// Unit tests for prisma-shipment.repository.ts + shipment-create.ts wiring.
//
// Covers:
//   1. PrismaShipmentRepository.upsertAndreaniShipment — happy path: calls
//      prisma.andreaniShipment.upsert with correct WHERE, CREATE, and UPDATE fields.
//   2. upsertAndreaniShipment — UPDATE block: status:"created" is set on update
//      (intentional status-reset to preserve behavior of original inline upsert).
//   3. upsertAndreaniShipment — labelPdfPath null is forwarded as-is.
//   4. shipment-create wiring: upsertAndreaniShipment is called on port, NOT
//      inline prisma.andreaniShipment.upsert.

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  clearMockModules,
  resetSourceModules,
  setMockModule,
} = require("../phase4/module-hooks.cjs");

// ── Helpers ───────────────────────────────────────────────────────────────────

const BIZ_ID = "biz1aaaaaaaaaaaaaaaaaaaa";
const SALE_ID = "sale1aaaaaaaaaaaaaaaaaaa";
const TRACKING = "AND-12345678";
const ESTIMATED_DELIVERY = new Date("2026-06-05T00:00:00.000Z");

/** Builds a minimal fake PrismaClient for upsert calls only. */
function makeFakePrismaUpsert() {
  const calls = [];
  return {
    _calls: calls,
    andreaniShipment: {
      upsert: async (args) => {
        calls.push(args);
        return {}; // prisma upsert returns the record, but port returns void
      },
    },
  };
}

// ── 1. upsertAndreaniShipment — CREATE args ───────────────────────────────────

test("upsertAndreaniShipment — CREATE block has correct fields including status:created and events:[]", async () => {
  const fakePrisma = makeFakePrismaUpsert();

  resetSourceModules();
  clearMockModules();

  // Override the global prisma import so the module uses our fake.
  // The repository's singleton (prismaShipmentRepository) is what we test.
  setMockModule("@/lib/prisma", { prisma: fakePrisma });

  const { makePrismaShipmentRepository } = require(
    "../../src/infrastructure/persistence/prisma-shipment.repository.ts"
  );

  const repo = makePrismaShipmentRepository(fakePrisma);

  await repo.upsertAndreaniShipment({
    saleId: SALE_ID,
    businessId: BIZ_ID,
    trackingNumber: TRACKING,
    service: "domicilio",
    labelPdfPath: "pdfs/label/biz1/AND-12345678.pdf",
    estimatedDelivery: ESTIMATED_DELIVERY,
  });

  assert.equal(fakePrisma._calls.length, 1, "upsert should be called exactly once");

  const call = fakePrisma._calls[0];

  // WHERE
  assert.deepEqual(call.where, { saleId: SALE_ID });

  // CREATE fields — all required
  assert.equal(call.create.businessId, BIZ_ID);
  assert.equal(call.create.saleId, SALE_ID);
  assert.equal(call.create.trackingNumber, TRACKING);
  assert.equal(call.create.service, "domicilio");
  assert.equal(call.create.status, "created");
  assert.equal(call.create.labelPdfPath, "pdfs/label/biz1/AND-12345678.pdf");
  assert.deepEqual(call.create.estimatedDelivery, ESTIMATED_DELIVERY);
  assert.deepEqual(call.create.events, []);
});

// ── 2. upsertAndreaniShipment — UPDATE block resets status:"created" ──────────

test("upsertAndreaniShipment — UPDATE block includes status:created (intentional reset) and excludes businessId", async () => {
  const fakePrisma = makeFakePrismaUpsert();

  resetSourceModules();
  clearMockModules();
  setMockModule("@/lib/prisma", { prisma: fakePrisma });

  const { makePrismaShipmentRepository } = require(
    "../../src/infrastructure/persistence/prisma-shipment.repository.ts"
  );

  const repo = makePrismaShipmentRepository(fakePrisma);

  await repo.upsertAndreaniShipment({
    saleId: SALE_ID,
    businessId: BIZ_ID,
    trackingNumber: TRACKING,
    service: "express",
    labelPdfPath: null,
    estimatedDelivery: ESTIMATED_DELIVERY,
  });

  const update = fakePrisma._calls[0].update;

  // UPDATE must include these tracking fields + status reset
  assert.equal(update.trackingNumber, TRACKING);
  assert.equal(update.service, "express");
  assert.equal(update.status, "created", "UPDATE must reset status to 'created' (intentional — preserves original inline upsert behavior)");
  assert.equal(update.labelPdfPath, null);
  assert.deepEqual(update.estimatedDelivery, ESTIMATED_DELIVERY);

  // businessId must NOT appear in UPDATE (cross-tenant protection)
  assert.ok(!("businessId" in update), "businessId must not be in UPDATE block");
  // events must NOT appear in UPDATE (preserved from original)
  assert.ok(!("events" in update), "events must not be in UPDATE block");
});

// ── 3. upsertAndreaniShipment — null labelPdfPath forwarded ──────────────────

test("upsertAndreaniShipment — null labelPdfPath is forwarded as null in both CREATE and UPDATE", async () => {
  const fakePrisma = makeFakePrismaUpsert();

  resetSourceModules();
  clearMockModules();
  setMockModule("@/lib/prisma", { prisma: fakePrisma });

  const { makePrismaShipmentRepository } = require(
    "../../src/infrastructure/persistence/prisma-shipment.repository.ts"
  );

  const repo = makePrismaShipmentRepository(fakePrisma);

  await repo.upsertAndreaniShipment({
    saleId: SALE_ID,
    businessId: BIZ_ID,
    trackingNumber: TRACKING,
    service: "sucursal",
    labelPdfPath: null,
    estimatedDelivery: ESTIMATED_DELIVERY,
  });

  const call = fakePrisma._calls[0];
  assert.equal(call.create.labelPdfPath, null);
  assert.equal(call.update.labelPdfPath, null);
});

// ── 4. shipment-create wiring — port is called, NOT inline prisma.andreaniShipment.upsert ──

test("shipmentCreate — calls ShipmentRepositoryPort.upsertAndreaniShipment, does NOT call prisma.andreaniShipment.upsert", async () => {
  const upsertCalls = [];
  const fakePort = {
    upsertAndreaniShipment: async (args) => {
      upsertCalls.push(args);
    },
  };

  // Track whether the inline prisma upsert is called (it must NOT be after wiring)
  const inlinePrismaUpsertCalls = [];
  const fakePrismaForShipmentCreate = {
    business: {
      findUnique: async () => ({
        name: "Negocio Test",
        cuit: "20-12345678-9",
        phone: "+5491122334455",
        email: "owner@test.com",
      }),
    },
    andreaniShipment: {
      upsert: async (args) => {
        inlinePrismaUpsertCalls.push(args);
        return {};
      },
    },
  };

  resetSourceModules();
  clearMockModules();

  setMockModule("@/lib/prisma", { prisma: fakePrismaForShipmentCreate });
  setMockModule("@/lib/cloud-logger", { cloudLog: () => {} });
  setMockModule("@/lib/r2", {
    uploadPdfToGcs: async () => "pdfs/label/biz1/AND-12345678.pdf",
    getSignedUrlForGcsKey: async (key) => `https://storage.googleapis.com/bucket/${key}`,
    buildPdfR2Key: (_type, _biz, _sale, tracking) => `pdfs/label/biz1/${tracking}.pdf`,
  });
  setMockModule(
    "@/infrastructure/persistence/prisma-shipment.repository",
    { prismaShipmentRepository: fakePort }
  );

  // Stub the Andreani API client
  setMockModule("./andreani-api-client", {
    resolveTokenWithEnv: async () => ({
      ctx: { token: "tok-test" },
      environment: "test",
    }),
    resolveContractCodes: async () => ({
      domicilio: "CONT_DOM",
      sucursal: "CONT_SUC",
      express: "CONT_EXP",
    }),
    createOrden: async () => ({
      nroAndreani: "AND-12345678",
      fechaEstimadaEntrega: "2026-06-05",
    }),
    andreaniFetch: async () => ({
      ok: false, // skip label fetch to simplify
      status: 404,
    }),
    isAndreaniCircuitOpen: () => false,
  });

  setMockModule("./andreani-mock", {
    isMockEnabled: () => false,
  });

  const { shipmentCreate } = require(
    "../../src/app/api/agents/andreani/_lib/shipment-create.ts"
  );

  const result = await shipmentCreate(
    {
      saleId: SALE_ID,
      service: "domicilio",
      weightGrams: 500,
      declaredValue: 5000,
      customer: {
        name: "Ana Test",
        phone: "+5491155667788",
        address: "Calle Falsa 123",
        postalCode: "1425",
        city: "Buenos Aires",
        dni: "12345678",
      },
    },
    BIZ_ID
  );

  // Port must have been called exactly once
  assert.equal(upsertCalls.length, 1, "port.upsertAndreaniShipment must be called once");
  assert.equal(upsertCalls[0].saleId, SALE_ID);
  assert.equal(upsertCalls[0].businessId, BIZ_ID);
  assert.equal(upsertCalls[0].trackingNumber, "AND-12345678");

  // Inline prisma.andreaniShipment.upsert must NOT have been called
  assert.equal(
    inlinePrismaUpsertCalls.length,
    0,
    "prisma.andreaniShipment.upsert (inline) must NOT be called after wiring to port"
  );

  // Return shape unchanged
  assert.equal(result.trackingNumber, "AND-12345678");
  assert.equal(result.service, "domicilio");
  assert.ok(typeof result.estimatedDelivery === "string");
});
