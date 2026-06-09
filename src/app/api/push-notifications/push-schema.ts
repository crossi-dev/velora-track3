import { z } from "zod";

export const pushSubscribeBodySchema = z.object({
  endpoint: z.string().min(1, "El endpoint es obligatorio.").max(2048),
  keys: z.object({
    p256dh: z.string().min(1, "La clave p256dh es obligatoria.").max(100),
    auth: z.string().min(1, "La clave auth es obligatoria.").max(40),
  }).strict(),
  deviceLabel: z.string().max(100).optional(),
}).strict();

export type PushSubscribeBodyInput = z.infer<typeof pushSubscribeBodySchema>;
