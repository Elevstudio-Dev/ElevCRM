import { z } from "zod";

import { PAPEIS_INTERNOS } from "@/lib/bastidor/papeis";

/**
 * `PUT /api/v1/contacts/:id/papel-interno` — definir ou tirar o papel de um contato da equipe.
 *
 * `papel: null` tira o papel (o contato continua "fora do funil": quem o devolve ao funil é outra decisão, tomada
 * na lista de contatos). O valor tem de ser um dos papéis conhecidos — o banco também recusa qualquer outro.
 */
export const definirPapelInternoSchema = z.object({
  papel: z.enum(PAPEIS_INTERNOS).nullable(),
});
export type DefinirPapelInternoInput = z.output<typeof definirPapelInternoSchema>;
