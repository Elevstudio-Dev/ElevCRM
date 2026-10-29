/**
 * GET/POST /api/v1/qr-codes — os QR codes da organização (gestor+).
 *
 * A RLS de `qr_codes` também exige manager: a porta HTTP e a do PostgREST concordam. Criar usa o cliente da
 * SESSÃO (não o admin): a policy de INSERT é a segunda cerca, e o `organization_id` vem da org ativa, nunca do body.
 * O código é sorteado aqui; colisão (unique da instalação) é re-sorteada até 5 vezes.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { gerarCodigo } from "@/lib/qr-codes/codigo";
import { COLUNAS_DO_QR, criarQrCodeSchema, type CanalDoQr, type QrCodeRow } from "@/lib/schemas/qr-codes";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "qr_codes", allowPlatformAdmin: true });
  if (!authz.ok) return authz.response;
  const orgId = authz.org.orgId;

  const supabase = await createClient();
  const [{ data: qrs, error: e1 }, { data: canais, error: e2 }] = await Promise.all([
    supabase
      .from("qr_codes")
      .select(COLUNAS_DO_QR)
      .eq("organization_id", orgId)
      .order("arquivado_em", { ascending: true, nullsFirst: true })
      .order("created_at", { ascending: false })
      .limit(200),
    supabase
      .from("channel_sessions")
      .select("id, display_name, phone_number, status")
      .eq("organization_id", orgId)
      .order("created_at", { ascending: true }),
  ]);
  if (e1) return fail("internal_error", e1.message, 500, { requestId });
  if (e2) return fail("internal_error", e2.message, 500, { requestId });

  const listaDeCanais: CanalDoQr[] = (
    (canais ?? []) as Array<{ id: string; display_name: string | null; phone_number: string | null; status: string }>
  ).map((c) => ({ id: c.id, nome: c.display_name, telefone: c.phone_number, conectado: c.status === "WORKING" }));

  return ok({ qr_codes: (qrs ?? []) as QrCodeRow[], canais: listaDeCanais }, { requestId });
}

export async function POST(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "qr_codes", allowPlatformAdmin: true });
  if (!authz.ok) return authz.response;
  const orgId = authz.org.orgId;

  const corpo = await req.json().catch(() => null);
  const parsed = criarQrCodeSchema.safeParse(corpo);
  if (!parsed.success) {
    return fail("validation_failed", "Dados inválidos.", 422, { requestId, details: parsed.error.flatten() });
  }
  const input = parsed.data;

  const supabase = await createClient();
  const { data: canal } = await supabase
    .from("channel_sessions")
    .select("id, phone_number")
    .eq("organization_id", orgId)
    .eq("id", input.channel_session_id)
    .maybeSingle();
  if (!canal) return fail("validation_failed", "Número de WhatsApp não encontrado.", 422, { requestId });
  if (!(canal as { phone_number: string | null }).phone_number) {
    return fail("validation_failed", "Este número ainda não tem telefone conectado.", 422, { requestId });
  }

  for (let tentativa = 0; tentativa < 5; tentativa++) {
    const { data, error } = await supabase
      .from("qr_codes")
      .insert({
        organization_id: orgId,
        codigo: gerarCodigo(),
        nome: input.nome,
        mensagem: input.mensagem,
        channel_session_id: input.channel_session_id,
        created_by_user_id: authz.user.id,
      })
      .select(COLUNAS_DO_QR)
      .single();
    if (error?.code === "23505") continue;
    if (error || !data) return fail("internal_error", error?.message ?? "Falha ao criar.", 500, { requestId });

    const criado = data as QrCodeRow;
    await audit({
      action: "qr_code.created",
      organizationId: orgId,
      actorUserId: authz.user.id,
      resourceType: "qr_code",
      resourceId: criado.id,
      requestId,
      metadata: { codigo: criado.codigo, nome: criado.nome },
    });
    return ok(criado, { requestId, status: 201 });
  }
  return fail("internal_error", "Não foi possível gerar um código único. Tente de novo.", 500, { requestId });
}
