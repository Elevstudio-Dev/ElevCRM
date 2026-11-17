/**
 * PUT /api/v1/contacts/:id/papel-interno — define (ou tira) o papel de um contato da equipe: secretaria ou marketing.
 *
 * ## Por que existe
 *
 * A IA conversa com a equipe para fazer o trabalho: pergunta à secretaria como está a agenda, recebe do marketing
 * o briefing de uma campanha. Para isso o sistema precisa saber QUEM é quem. O papel é uma decisão da clínica, não
 * da IA: aqui só gerente ou admin define.
 *
 * ## O que acontece ao definir
 *
 * - O contato passa a ficar "fora do funil" (0221) se ainda não estava: não vira lead, não entra em relatório de
 *   vendas e o agente de VENDAS não lhe escreve. O banco exige isso (CHECK da 0227).
 * - O papel NÃO dá, sozinho, poder nenhum sobre os dados: ele só diz ao agente de bastidor com quem falar e o quê.
 *
 * ## O que acontece ao tirar
 *
 * O papel some; o contato continua fora do funil. Devolver a pessoa ao funil é outra decisão (e o banco recusa
 * devolver quem ainda tem papel — veja a rota de "fora do funil").
 *
 * ## Isolamento
 *
 * O contato é lido pela conexão do USUÁRIO (RLS): id de outra empresa volta 404. A escrita também passa pela
 * conexão do usuário, e o gatilho do banco (0227) confere de novo que é gerente ou admin — uma chamada direta ao
 * PostgREST por um atendente não contorna esta rota.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { aplicarMarcador } from "@/lib/contatos/fora-do-funil";
import { definirPapelInternoSchema } from "@/lib/schemas/papel-interno";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const Id = z.string().uuid();

export async function PUT(req: NextRequest, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "contact_role" });
  if (!authz.ok) return authz.response;
  const { user, org } = authz;

  const { id } = await ctx.params;
  if (!Id.safeParse(id).success) {
    return fail("invalid_request", "Contato inválido.", 400, { requestId });
  }

  const parsed = definirPapelInternoSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("validation_failed", "Escolha Secretaria, Marketing ou nenhum papel.", 422, {
      requestId,
      details: parsed.error.flatten(),
    });
  }
  const { papel } = parsed.data;

  const supabase = await createClient();
  const { data: contato, error: erroContato } = await supabase
    .from("contacts")
    .select("id, phone_number, wa_lid, is_blocked, is_anonymized, fora_do_funil_em, papel_interno")
    .eq("organization_id", org.orgId)
    .eq("id", id)
    .maybeSingle();
  if (erroContato) return fail("db_error", "Não foi possível ler o contato.", 500, { requestId });
  if (!contato) return fail("not_found", "Contato não encontrado.", 404, { requestId });

  const atual = (contato.papel_interno as string | null) ?? null;
  if (atual === papel) {
    return ok({ papel, alterado: false, fora_do_funil: contato.fora_do_funil_em !== null }, { requestId });
  }

  if (papel !== null) {
    // A IA só consegue falar com quem tem um endereço, não pediu para parar e não foi anonimizado.
    if (contato.is_anonymized === true) {
      return fail("validation_failed", "Esse contato foi anonimizado e não pode ter um papel.", 422, { requestId });
    }
    if (contato.is_blocked === true) {
      return fail(
        "validation_failed",
        "Esse contato está bloqueado (pediu para não receber mensagens). Desbloqueie antes de dar um papel.",
        422,
        { requestId },
      );
    }
    if (!contato.phone_number && !contato.wa_lid) {
      return fail("validation_failed", "Esse contato não tem número de WhatsApp cadastrado.", 422, { requestId });
    }
  }

  let marcouForaDoFunil = false;
  try {
    // Papel exige "fora do funil" (CHECK do banco). Marca primeiro; se a gravação do papel falhar logo depois, o
    // contato fica só fora do funil — o lado seguro, a IA continua calada.
    if (papel !== null && contato.fora_do_funil_em === null) {
      await aplicarMarcador(supabase, {
        organizationId: org.orgId,
        userId: user.id,
        contactIds: [id],
        marcar: true,
        contador: createAdminClient(),
      });
      marcouForaDoFunil = true;
    }

    const { error: erroPapel } = await supabase
      .from("contacts")
      .update({ papel_interno: papel })
      .eq("organization_id", org.orgId)
      .eq("id", id);
    if (erroPapel) {
      // 42501 = o gatilho do banco recusou (não é gerente/admin): nunca vira 500.
      if (erroPapel.code === "42501") {
        return fail("forbidden", "Só gerente ou administrador define o papel de um contato.", 403, { requestId });
      }
      throw new Error(erroPapel.message);
    }
  } catch (err) {
    return fail("internal_error", err instanceof Error ? err.message : "Falha ao atualizar.", 500, { requestId });
  }

  await audit({
    action: "contact.papel_interno_alterado",
    organizationId: org.orgId,
    actorUserId: user.id,
    resourceType: "contact",
    resourceId: id,
    requestId,
    metadata: { de: atual, para: papel, marcou_fora_do_funil: marcouForaDoFunil },
  });

  return ok({ papel, alterado: true, fora_do_funil: true }, { requestId });
}
