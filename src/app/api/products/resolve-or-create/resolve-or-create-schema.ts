import { z } from "zod";

export const resolveOrCreateBodySchema = z.object({
  name: z.string().max(255).optional().nullable(),
  price: z.preprocess((v) => (v === "" ? undefined : v), z.coerce.number().nonnegative().nullable().optional()),
  costPrice: z.preprocess((v) => (v === "" ? undefined : v), z.coerce.number().nonnegative().nullable().optional()),
}).strict();

export type ResolveOrCreateBodyInput = z.infer<typeof resolveOrCreateBodySchema>;
