/**
 * O que as rotas de campanha têm em comum: transformar o erro do serviço em
 * resposta, sem vazar mensagem de banco para a tela.
 */
import { fail } from "@/lib/api/wrappers";
import { logger } from "@/lib/logger";
import { ErroDeCampanha } from "@/lib/campanhas/servico";

export const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function respostaDeErro(err: unknown, requestId: string, onde: string): Response {
  if (err instanceof ErroDeCampanha) {
    return fail(err.code, err.message, err.status, { requestId });
  }
  logger.error(`[campanhas] ${onde} falhou`, {
    requestId,
    error: err instanceof Error ? err.message : String(err),
  });
  return fail("internal_error", "Não foi possível concluir. Tente de novo em instantes.", 500, { requestId });
}

export async function lerJson(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    return undefined;
  }
}
