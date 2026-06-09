
const prisma = {
  paymentIntent: {
    findFirst: async (...args) => global.__prismaFindFirst ? global.__prismaFindFirst(...args) : null,
    findUnique: async () => null,
    create: async () => ({}),
    update: async () => ({}),
  },
};
// Provide a Proxy for any other model access (e.g. business.findUnique)
const handler = { get(_, model) { return prisma[model] ?? { findFirst: async()=>null, findUnique: async()=>null, create:async()=>({}), update:async()=>({}) }; } };
module.exports = { prisma: new Proxy(prisma, handler) };
