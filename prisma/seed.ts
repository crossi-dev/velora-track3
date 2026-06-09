import { PrismaClient } from "@prisma/client";

if (process.env.NODE_ENV === "production") {
  console.error("[seed] Seeding is disabled in production.");
  process.exit(1);
}

const prisma = new PrismaClient();

const DEMO_BUSINESS_ID = "demo-business";
const TAX_RATE = 0.21;

const productSeeds = [
  { name: "Yerba Mate 1kg", sku: "YERBA-1KG", price: 6200, stock: 40 },
  { name: "Azucar 1kg", sku: "AZUCAR-1KG", price: 1800, stock: 55 },
  { name: "Cafe Molido 500g", sku: "CAFE-500G", price: 4900, stock: 28 },
  { name: "Leche Entera 1L", sku: "LECHE-1L", price: 1600, stock: 70 },
  { name: "Galletitas Dulces 300g", sku: "GALLETAS-300G", price: 2300, stock: 60 },
];

const customerSeeds = [
  { name: "Ana Torres", email: "ana.torres@example.com", phone: "+54 11 4000 1001" },
  { name: "Carlos Mendoza", email: "carlos.mendoza@example.com", phone: "+54 11 4000 1002" },
  { name: "Lucia Pereyra", email: "lucia.pereyra@example.com", phone: "+54 11 4000 1003" },
];

const supplierSeeds = [
  {
    name: "Distribuidora Norte SRL",
    contactName: "Martin Salas",
    email: "ventas@norte-srl.example",
    phone: "+54 11 4555 2101",
  },
  {
    name: "Mayorista Sur SA",
    contactName: "Paula Nunez",
    email: "compras@sur-sa.example",
    phone: "+54 11 4555 2102",
  },
];

const saleSeeds = [
  {
    customerName: "Ana Torres",
    daysAgo: 2,
    items: [
      { productName: "Yerba Mate 1kg", quantity: 2 },
      { productName: "Azucar 1kg", quantity: 1 },
    ],
  },
  {
    customerName: "Carlos Mendoza",
    daysAgo: 1,
    items: [
      { productName: "Cafe Molido 500g", quantity: 1 },
      { productName: "Leche Entera 1L", quantity: 3 },
      { productName: "Galletitas Dulces 300g", quantity: 2 },
    ],
  },
  {
    customerName: null,
    daysAgo: 0,
    items: [
      { productName: "Yerba Mate 1kg", quantity: 1 },
      { productName: "Leche Entera 1L", quantity: 2 },
    ],
  },
];

async function clearDemoBusinessData() {
  const existingBusiness = await prisma.business.findUnique({
    where: { id: DEMO_BUSINESS_ID },
    select: { id: true },
  });

  if (!existingBusiness) return;

  const sales = await prisma.sale.findMany({
    where: { businessId: DEMO_BUSINESS_ID },
    select: { id: true },
  });

  if (sales.length > 0) {
    await prisma.saleItem.deleteMany({
      where: { saleId: { in: sales.map((sale) => sale.id) } },
    });
  }

  await prisma.sale.deleteMany({ where: { businessId: DEMO_BUSINESS_ID } });

  const products = await prisma.product.findMany({
    where: { businessId: DEMO_BUSINESS_ID },
    select: { id: true },
  });

  await prisma.product.deleteMany({ where: { businessId: DEMO_BUSINESS_ID } });
  await prisma.customer.deleteMany({ where: { businessId: DEMO_BUSINESS_ID } });
  await prisma.supplier.deleteMany({ where: { businessId: DEMO_BUSINESS_ID } });
  await prisma.cashMovement.deleteMany({ where: { businessId: DEMO_BUSINESS_ID } });
  await prisma.business.delete({ where: { id: DEMO_BUSINESS_ID } });
}

async function seed() {
  await clearDemoBusinessData();

  const business = await prisma.business.create({
    data: {
      id: DEMO_BUSINESS_ID,
      name: "Demo Comercio SA",
      type: "retail",
      cuit: "30-71234567-8",
      address: "Av. Siempre Viva 742",
      phone: "+54 11 5000 9000",
      workerCount: 6,
      openingCash: 150000,
      taxRate: TAX_RATE,
      currency: "ARS",
    },
  });

  const createdProducts = [];
  for (const product of productSeeds) {
    const createdProduct = await prisma.product.create({
      data: {
        businessId: business.id,
        name: product.name,
        sku: product.sku,
        price: product.price,
        reorderThreshold: 5,
      },
      select: { id: true, name: true, price: true },
    });

    // Set initial stock directly on Product
    const stock = productSeeds.find((seedProduct) => seedProduct.name === createdProduct.name)?.stock ?? 0;
    if (stock > 0) {
      await prisma.product.update({ where: { id: createdProduct.id }, data: { quantity: stock } });
    }
    createdProducts.push(createdProduct);
  }

  await prisma.customer.createMany({
    data: customerSeeds.map((customer) => ({
      businessId: business.id,
      name: customer.name,
      email: customer.email,
      phone: customer.phone,
    })),
  });

  await prisma.supplier.createMany({
    data: supplierSeeds.map((supplier) => ({
      businessId: business.id,
      name: supplier.name,
      contactName: supplier.contactName,
      email: supplier.email,
      phone: supplier.phone,
    })),
  });

  const customers = await prisma.customer.findMany({
    where: { businessId: business.id },
    select: { id: true, name: true },
  });

  const customerIdByName = new Map(customers.map((customer) => [customer.name, customer.id]));
  const productByName = new Map(
    createdProducts.map((product) => [product.name, { id: product.id, unitPrice: Number(product.price) }])
  );

  for (const saleSeed of saleSeeds) {
    const saleItems = saleSeed.items.map((item) => {
      const product = productByName.get(item.productName);
      if (!product) {
        throw new Error(`Missing product for sale seed: ${item.productName}`);
      }

      return {
        productId: product.id,
        quantity: item.quantity,
        unitPrice: product.unitPrice,
      };
    });

    const subtotal = saleItems.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0);
    const taxAmount = Number((subtotal * TAX_RATE).toFixed(2));
    const totalAmount = Number((subtotal + taxAmount).toFixed(2));

    await prisma.sale.create({
      data: {
        businessId: business.id,
        customerId: saleSeed.customerName ? customerIdByName.get(saleSeed.customerName) ?? null : null,
        date: new Date(Date.now() - saleSeed.daysAgo * 24 * 60 * 60 * 1000),
        status: "completed",
        totalAmount,
        taxAmount,
        saleItems: {
          create: saleItems.map((item) => ({
            productId: item.productId,
            quantity: item.quantity,
            unitPrice: item.unitPrice,
          })),
        },
      },
    });
  }

  console.log("Seed completed:");
  console.log(`- Business: ${business.name} (${business.id})`);
  console.log(`- Products: ${productSeeds.length}`);
  console.log(`- Customers: ${customerSeeds.length}`);
  console.log(`- Suppliers: ${supplierSeeds.length}`);
  console.log(`- Sales: ${saleSeeds.length}`);
}

seed()
  .catch((error) => {
    console.error("Seed failed:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
