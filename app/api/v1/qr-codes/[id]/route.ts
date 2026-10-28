/**
 * PATCH /api/v1/qr-codes/[id] — renomear, trocar a mensagem ou o número, arquivar/reativar (gestor+).
 *
 * O CÓDIGO nunca muda: ele está impresso. Mudar a mensagem vale para as próximas leituras; quem já leu e não
 * mandou continua com a mensagem antiga no celular — por isso o código, e não a frase, é o que identifica.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { COLUNAS_DO_QR, editarQrCodeSchema, type QrCodeRow } from "@/lib/schemas/qr-codes";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "qr_codes", allowPlatformAdmin: true });
  if (!authz.ok) return authz.response;
  const orgId = authz.org.orgId;
  const { id } = await ctx.params;

  const parsed = editarQrCodeSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("validation_failed", "Dados inválidos.", 422, { requestId, details: parsed.error.flatten() });
  }
  const input = parsed.data;
  const supabase = await createClient();

  if (input.channel_session_id) {
    const { data: canal } = await supabase
      .from("channel_sessions")
      .select("id, phone_number")
      .eq("organization_id", orgId)
      .eq("id", input.channel_session_id)
      .maybeSingle();
    if (!canal || !(canal as { phone_number: string | null }).phone_number) {
      return fail("validation_failed", "Este número não está disponível para QR code.", 422, { requestId });
    }
  }

  const mudanca: Record<string, unknown> = {};
  if (input.nome !== undefined) mudanca.nome = input.nome;
  if (input.mensagem !== undefined) mudanca.mensagem = input.mensagem;
  if (input.channel_session_id !== undefined) mudanca.channel_session_id = input.channel_session_id;
  if (input.arquivado !== undefined) mudanca.arquivado_em = input.arquivado ? new Date().toISOString() : null;

  const { data, error } = await supabase
    .from("qr_codes")
    .update(mudanca)
    .eq("organization_id", orgId)
    .eq("id", id)
    .select(COLUNAS_DO_QR)
    .maybeSingle();
  if (error) return fail("internal_error", error.message, 500, { requestId });
  if (!data) return fail("not_found", "QR code não encontrado.", 404, { requestId });

  const qr = data as QrCodeRow;
  const acao =
    input.arquivado === true ? "qr_code.archived" : input.arquivado === false ? "qr_code.restored" : "qr_code.updated";
  await audit({
    action: acao,
    organizationId: orgId,
    actorUserId: authz.user.id,
    resourceType: "qr_code",
    resourceId: qr.id,
    requestId,
    metadata: { campos: Object.keys(mudanca) },
  });
  return ok(qr, { requestId });
}
