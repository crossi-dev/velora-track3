import { z } from "zod";

const CUID = z.string().min(20).max(30).regex(/^[a-z0-9]{20,30}$/, "ID con formato inválido.");

export const bulkPriceUpdateBodySchema = z
  .object({
    amount: z.number().positive("Amount must be greater than zero."),
    mode: z.enum(["percentage", "absolute"], {
      errorMap: () => ({ message: "Mode must be percentage or absolute." }),
    }),
    direction: z.enum(["up", "down", "set"], {
      errorMap: () => ({ message: "Direction must be up, down, or set." }),
    }),
    productIds: z.array(CUID).optional(),
  })
  .strict()
  .superRefine((data, ctx) => {
    if (data.direction === "set" && data.mode !== "absolute") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["direction"],
        message: "The 'set' direction only applies with absolute amounts.",
      });
    }
  });

export type BulkPriceUpdateBodyInput = z.infer<typeof bulkPriceUpdateBodySchema>;
