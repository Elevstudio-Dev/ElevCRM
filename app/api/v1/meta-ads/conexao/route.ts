/**
 * GET/PUT/DELETE /api/v1/meta-ads/conexao — a conta de anúncios da Meta da organização (gestor+).
 *
 * A tabela da chave (`meta_ads_conexoes`) tem RLS ligada e ZERO policies: o cliente de sessão não a enxerga, então
 * tudo aqui passa pelo cliente administrativo — e por isso o `organization_id` de TODA consulta vem da organização
 * ativa já validada por `requireRole`, nunca do corpo ou da URL. A chave entra por PUT, é conferida na Meta,
 * cifrada e gravada; NENHUMA resposta a devolve, e nenhum log a contém.
 *
 * Só dono e gerente conectam ou desconectam: a chave dá acesso aos números de investimento da empresa.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { lerConta, MetaAdsError } from "@/lib/channels/meta/ads-graph";
import { mensagemDoErro } from "@/lib/meta-ads/sincronizar";
import {
  COLUNAS_PUBLICAS_DA_CONEXAO,
  conectarMetaAdsSchema,
  SEM_CONEXAO,
  type EstadoDaConexaoMeta,
} from "@/lib/schemas/meta-ads";
import { createAdminClient } from "@/lib/supabase/admin";
import { encryptWebhookSecret } from "@/lib/webhooks/secrets";

export const dynamic = "force-dynamic";

async function estadoDaConexao(orgId: string): Promise<{ estado: EstadoDaConexaoMeta; erro?: string }> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("meta_ads_conexoes")
    .select(COLUNAS_PUBLICAS_DA_CONEXAO)
    .eq("organization_id", orgId)
    .maybeSingle();
  if (error) return { estado: SEM_CONEXAO, erro: error.message };
  if (!data) return { estado: SEM_CONEXAO };
  return { estado: { conectada: true, ...(data as Omit<EstadoDaConexaoMeta, "conectada">) } };
}

export async function GET(): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "meta_ads", allowPlatformAdmin: true });
  if (!authz.ok) return authz.response;

  const { estado, erro } = await estadoDaConexao(authz.org.orgId);
  if (erro) return fail("internal_error", erro, 500, { requestId });
  return ok(estado, { requestId });
}

export async function PUT(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "meta_ads", allowPlatformAdmin: true });
  if (!authz.ok) return authz.response;
  const orgId = authz.org.orgId;

  const corpo = await req.json().catch(() => null);
  const parsed = conectarMetaAdsSchema.safeParse(corpo);
  if (!parsed.success) {
    // `flatten()` só leva as mensagens do esquema, nunca o valor digitado — a chave não volta na resposta.
    return fail("validation_failed", "Confira o número da conta e a chave.", 422, {
      requestId,
      details: parsed.error.flatten().fieldErrors,
    });
  }
  const { ad_account_id: adAccountId, token } = parsed.data;

  // Confere na Meta ANTES de guardar: chave errada é dito na hora, não na primeira sincronização.
  let conta;
  try {
    conta = await lerConta(adAccountId, token);
  } catch (err) {
    const codigo = err instanceof MetaAdsError ? err.codigo : "indisponivel";
    return fail("validation_failed", mensagemDoErro(codigo), codigo === "indisponivel" ? 502 : 422, { requestId });
  }

  const admin = createAdminClient();
  const cifrado = await encryptWebhookSecret(admin, token);
  if (!cifrado) {
    return fail(
      "validation_failed",
      "A cifra não está disponível nesta instalação, então a chave não foi guardada. Fale com quem instalou o sistema.",
      422,
      { requestId },
    );
  }

  const { error } = await admin.from("meta_ads_conexoes").upsert(
    {
      organization_id: orgId,
      ad_account_id: adAccountId,
      account_name: conta.nome,
      currency: conta.moeda,
      token_encrypted: cifrado,
      status: "conectada",
      last_error: null,
      last_synced_at: null,
      updated_at: new Date().toISOString(),
      updated_by: authz.user.id,
    },
    { onConflict: "organization_id" },
  );
  if (error) return fail("internal_error", "Não foi possível guardar a conexão.", 500, { requestId });

  // Sem a chave nem o valor dela: só quem fez e qual conta.
  await audit({
    action: "meta_ads.conectada",
    organizationId: orgId,
    actorUserId: authz.user.id,
    resourceType: "meta_ads_conexao",
    resourceId: orgId,
    requestId,
    metadata: { ad_account_id: adAccountId, moeda: conta.moeda },
  });

  const { estado } = await estadoDaConexao(orgId);
  return ok(estado, { requestId });
}

export async function DELETE(): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "meta_ads", allowPlatformAdmin: true });
  if (!authz.ok) return authz.response;
  const orgId = authz.org.orgId;

  const admin = createAdminClient();
  const { error } = await admin.from("meta_ads_conexoes").delete().eq("organization_id", orgId);
  if (error) return fail("internal_error", "Não foi possível desconectar.", 500, { requestId });

  await audit({
    action: "meta_ads.desconectada",
    organizationId: orgId,
    actorUserId: authz.user.id,
    resourceType: "meta_ads_conexao",
    resourceId: orgId,
    requestId,
  });
  return ok(SEM_CONEXAO, { requestId });
}
