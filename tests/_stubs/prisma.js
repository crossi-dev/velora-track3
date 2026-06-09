// Stub for @/lib/prisma in unit tests.
// The real prisma.ts calls validateEnv() at module load time, which throws if
// AUTH_SECRET / DATABASE_URL are missing. Unit tests that don't touch the DB
// import handlers that transitively import prisma and need this no-op stub.
//
// Each model method returns the minimal safe value for tests:
//   - findMany → [] (no rows)
//   - findFirst → null (no row found)
//   - create, update, delete → {} (no-op)
//
// businessId is undefined in test makeParams, so prisma is never actually
// called in most handlers (they guard with `if (businessId && ...)`) — but
// the stub prevents the module-load crash AND handles cases like
// handleReturnSale which calls prisma.sale.findFirst unconditionally.
function makeModel() {
  return {
    findMany: async () => [],
    findFirst: async () => null,
    findUnique: async () => null,
    create: async () => ({}),
    createMany: async () => ({ count: 0 }),
    update: async () => ({}),
    updateMany: async () => ({ count: 0 }),
    delete: async () => ({}),
    deleteMany: async () => ({ count: 0 }),
    upsert: async () => ({}),
    count: async () => 0,
    aggregate: async () => ({}),
  };
}

const prisma = new Proxy({}, {
  get(_, model) {
    return makeModel();
  },
});

module.exports = { prisma };
