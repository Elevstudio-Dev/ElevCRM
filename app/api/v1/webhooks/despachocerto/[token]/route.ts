/**
 * POST /api/v1/webhooks/despachocerto/[token] — a OS chega, as tags nascem.
 *
 * Mesmo desenho do webhook per-tenant do canal e do `/webhooks/in/[token]`:
 *
 *   1. o TOKEN DO CAMINHO resolve a organização — fonte confiável. Nunca o
 *      corpo: um corpo diz o que quem manda quiser, e "organization_id" vindo
 *      de fora é a porta de escrita numa base que não é dele;
 *   2. a ASSINATURA HMAC do corpo cru prova que quem mandou tem o segredo;
 *   3. só então o evento é aplicado.
 *
 * Responde 200 com o que aconteceu (`vinculado`, `tags_novas`) para o outro
 * lado poder registrar — um webhook que responde só "ok" não deixa ninguém
 * descobrir que a OS caiu num cliente que o CRM não conhece.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { eventoDeOsSchema } from "@/lib/integrations/despachocerto/contrato";
import { aplicarEventoDeOs } from "@/lib/integrations/despachocerto/aplicar-evento";
import { lerSegredoDoWebhook } from "@/lib/integrations/despachocerto/estado";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";
import { verifyInboundSignature } from "@/lib/webhooks/inbound";

export const dynamic = "force-dynamic";

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ token: string }> },
): Promise<Response> {
  const requestId = randomUUID();
  const { token } = await ctx.params;

  const destino = await lerSegredoDoWebhook(token);
  if (!destino) {
    // 404 e não 401: um token que não existe não é credencial errada, é URL
    // errada — e responder 401 ensinaria quem varre a insistir.
    return fail("not_found", "Integração não encontrada.", 404, { requestId });
  }

  // O corpo CRU, antes de qualquer parse: a assinatura é sobre os bytes que
  // vieram. `JSON.parse` + `JSON.stringify` mudaria espaços e ordem de chaves,
  // e a assinatura deixaria de bater sem ninguém entender por quê.
  const cru = await req.text();

  if (destino.segredo) {
    const assinatura =
      req.headers.get("x-despachocerto-signature") ?? req.headers.get("x-signature");
    if (!verifyInboundSignature(cru, assinatura, destino.segredo)) {
      logger.warn("despachocerto: assinatura inválida", {
        requestId,
        organization_id: destino.organizationId,
      });
      return fail("unauthorized", "Assinatura inválida.", 401, { requestId });
    }
  }

  let corpo: unknown;
  try {
    corpo = JSON.parse(cru);
  } catch {
    return fail("invalid_payload", "Corpo não é JSON.", 400, { requestId });
  }

  const parsed = eventoDeOsSchema.safeParse(corpo);
  if (!parsed.success) {
    return fail("invalid_payload", "Evento de OS em formato inesperado.", 400, { requestId });
  }

  const resultado = await aplicarEventoDeOs(
    createAdminClient(),
    destino.organizationId,
    parsed.data,
    requestId,
  );

  return ok(resultado, { requestId });
}
