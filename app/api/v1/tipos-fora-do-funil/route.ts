/**
 * GET/POST /api/v1/tipos-fora-do-funil — os tipos de contato "fora do funil" que o dono cadastra (Equipe,
 * Contador, Dentista parceiro…).
 *
 * Ler é de qualquer atendente (o diálogo de marcar precisa da lista); criar é de gestor+. A RLS de
 * `tipos_fora_do_funil` diz o mesmo: a porta HTTP e a do PostgREST concordam. O `organization_id` vem da sessão,
 * nunca do corpo. Nome repetido (sem diferenciar maiúscula) é recusado pelo índice único — o banco é a cerca.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import {
  COLUNAS_DO_TIPO,
  criarTipoForaDoFunilSchema,
  type TipoForaDoFunil,
} from "@/lib/schemas/fora-do-funil";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "tipos_fora_do_funil", allowPlatformAdmin: true });
  if (!authz.ok) return authz.response;

  // Arquivados só quando pedidos (a tela de Configurações os mostra à parte).
  const comArquivados = new URL(req.url).searchParams.get("arquivados") === "1";
  const supabase = await createClient();
  let consulta = supabase
    .from("tipos_fora_do_funil")
    .select(COLUNAS_DO_TIPO)
    .eq("organization_id", authz.org.orgId)
    .order("nome", { ascending: true })
    .limit(200);
  if (!comArquivados) consulta = consulta.is("arquivado_em", null);

  const { data, error } = await consulta;
  if (error) return fail("internal_error", error.message, 500, { requestId });
  return ok((data ?? []) as TipoForaDoFunil[], { requestId });
}

export async function POST(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "tipos_fora_do_funil", allowPlatformAdmin: true });
  if (!authz.ok) return authz.response;
  const orgId = authz.org.orgId;

  const parsed = criarTipoForaDoFunilSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("validation_failed", "Dados inválidos.", 422, { requestId, details: parsed.error.flatten() });
  }

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("tipos_fora_do_funil")
    .insert({ organization_id: orgId, nome: parsed.data.nome, created_by_user_id: authz.user.id })
    .select(COLUNAS_DO_TIPO)
    .single();
  if (error?.code === "23505") {
    return fail("validation_failed", "Já existe um tipo com esse nome.", 422, { requestId });
  }
  if (error || !data) return fail("internal_error", error?.message ?? "Falha ao criar.", 500, { requestId });

  const criado = data as TipoForaDoFunil;
  await audit({
    action: "tipo_fora_do_funil.criado",
    organizationId: orgId,
    actorUserId: authz.user.id,
    resourceType: "tipo_fora_do_funil",
    resourceId: criado.id,
    requestId,
    metadata: { nome: criado.nome },
  });
  return ok(criado, { requestId, status: 201 });
}
