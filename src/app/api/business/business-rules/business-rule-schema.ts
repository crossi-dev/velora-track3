import { z } from "zod";
export { validateTimeTrigger, validateConditionTrigger } from "@/domain/rules/cron-validation";

const VALID_KINDS = ["time-based", "condition-based", "behavior-based"] as const;

export const createBusinessRuleBodySchema = z.object({
  kind: z.enum(VALID_KINDS, {
    errorMap: () => ({
      message: "kind must be time-based, condition-based, or behavior-based.",
    }),
  }),
  trigger: z
    .string()
    .min(1, "trigger is required.")
    .max(500, "trigger exceeds the maximum length of 500 characters."),
  message: z
    .string()
    .min(1, "message is required.")
    .max(1000, "message exceeds the maximum length of 1000 characters."),
}).strict();

export const updateBusinessRuleBodySchema = z
  .object({
    kind: z.enum(VALID_KINDS).optional(),
    trigger: z.string().min(1).max(500).optional(),
    message: z.string().min(1).max(1000).optional(),
    active: z.boolean().optional(),
  })
  .strict()
  .refine(
    (data) =>
      data.kind !== undefined ||
      data.trigger !== undefined ||
      data.message !== undefined ||
      data.active !== undefined,
    { message: "No fields to update were provided." },
  );

export type CreateBusinessRuleBodyInput = z.infer<typeof createBusinessRuleBodySchema>;
export type UpdateBusinessRuleBodyInput = z.infer<typeof updateBusinessRuleBodySchema>;
