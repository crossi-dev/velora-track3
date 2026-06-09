import { z } from "zod";

// Chip payload validator — mirrors src/app/api/supervisor/_lib/supervisor-chips.ts
// (defensive shape only; the supervisor's own validator is the source of truth).
// Persisted as JSONB so the GET endpoint can echo it back to the client without
// re-running the assistant turn.
export const chipsSchema = z
  .object({
    kind: z.enum(["single", "multi", "action"]),
    options: z
      .array(
        z.object({
          label: z.string().min(1).max(40),
          value: z.string().min(1).max(80),
          action: z.enum(["subscribe_push"]).optional(),
        }),
      )
      .min(1)
      .max(8),
  })
  .nullable()
  .optional();
