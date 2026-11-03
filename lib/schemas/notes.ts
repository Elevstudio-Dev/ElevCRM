import { z } from "zod";

import { mencoesPedidasSchema } from "@/lib/mencoes/servidor";

export const createNoteSchema = z.object({
  body: z.string().trim().min(1).max(4096),
  /** Quem foi marcado com @ (só o id; o servidor confere e põe o nome). */
  mentions: mencoesPedidasSchema,
});
export type CreateNoteInput = z.infer<typeof createNoteSchema>;
