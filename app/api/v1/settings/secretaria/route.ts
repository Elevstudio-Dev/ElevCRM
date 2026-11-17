/**
 * GET   /api/v1/settings/secretaria — a configuração da agenda da secretaria (manager+): o que está em
 *       `organizations.settings.secretaria` e QUEM é a secretaria hoje (os contatos com o papel), com a pergunta que
 *       a tela precisa responder: "a IA consegue falar com ela?" (ela já tem uma conversa com o número?).
 * PATCH /api/v1/settings/secretaria — grava (manager+). Merge não-destrutivo: preserva as demais chaves de
 *       `settings` e as da própria `secretaria` que a tela não conhece (as validades da agenda conferida).
 *
 * Rota v1 dedicada, no molde de `settings/routing`: a escrita em `organizations` vai pelo client administrativo
 * (a única policy de escrita da tabela é a de platform admin; pelo client de sessão o UPDATE casaria zero linhas e
 * a tela diria "salvo" sem gravar), com o gate de papel resolvido de fonte confiável e o filtro de organização
 * explícito.
 *
 * O dono da agenda tem de ser MEMBRO da organização, com papel de atendente ou mais: um UUID qualquer faria a IA
 * consultar a jornada de ninguém e a agenda da clínica ficar sem horário para oferecer.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { ApiError } from "@/lib/api/types";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { configDaSecretariaPatchSchema, lerConfigDaSecretaria } from "@/lib/agenda/secretaria/config";
import { lerSituacaoDaSecretaria } from "@/lib/agenda/secretaria/situacao";
import { validateRequest } from "@/lib/schemas";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "settings_secretaria" });
  if (!authz.ok) return authz.response;
  const orgId = authz.org.orgId;

  try {
    const { config, secretarias } = await lerSituacaoDaSecretaria(await createClient(), orgId);
    return ok({ ...config, secretarias }, { requestId });
  } catch (e) {
    return fail("internal_error", e instanceof Error ? e.message : "Falha ao ler a configuração.", 500, { requestId });
  }
}

export async function PATCH(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "settings_secretaria" });
  if (!authz.ok) return authz.response;
  const { user: authUser, org: activeOrg } = authz;

  let input;
  try {
    input = await validateRequest(configDaSecretariaPatchSchema, req);
  } catch (err) {
    if (err instanceof ApiError) {
      return fail(err.code, err.message, err.status, {
        details: err.details as Record<string, unknown> | undefined,
        requestId,
      });
    }
    throw err;
  }

  const admin = createAdminClient();

  if (input.dono_da_agenda_user_id) {
    const { data: membro, error: eMembro } = await admin
      .from("user_organizations")
      .select("role")
      .eq("organization_id", activeOrg.orgId)
      .eq("user_id", input.dono_da_agenda_user_id)
      .maybeSingle();
    if (eMembro) return fail("internal_error", eMembro.message, 500, { requestId });
    const papel = (membro as { role?: string } | null)?.role;
    if (papel === undefined || papel === "viewer") {
      return fail("validation_failed", "O dono da agenda precisa ser da equipe, com papel de atendente ou mais.", 422, {
        requestId,
      });
    }
  }

  const { data: orgRow, error: readErr } = await admin
    .from("organizations")
    .select("settings")
    .eq("id", activeOrg.orgId)
    .maybeSingle();
  if (readErr) return fail("internal_error", readErr.message, 500, { requestId });

  const currentSettings = (orgRow?.settings as Record<string, unknown> | null) ?? {};
  const secretariaAtual =
    typeof currentSettings.secretaria === "object" && currentSettings.secretaria !== null
      ? (currentSettings.secretaria as Record<string, unknown>)
      : {};
  const secretaria = { ...secretariaAtual, ...input };

  const { error: updErr } = await admin
    .from("organizations")
    .update({ settings: { ...currentSettings, secretaria } })
    .eq("id", activeOrg.orgId);
  if (updErr) return fail("internal_error", updErr.message, 500, { requestId });

  void audit({
    action: "secretaria.config_changed",
    actorUserId: authUser.id,
    organizationId: activeOrg.orgId,
    resourceType: "organization",
    resourceId: activeOrg.orgId,
    requestId,
    metadata: { campos: Object.keys(input), ...(input.ativa !== undefined ? { ativa: input.ativa } : {}) },
  });

  const c = lerConfigDaSecretaria({ secretaria });
  return ok(
    {
      ativa: c.ativa,
      dono_da_agenda_user_id: c.dono_da_agenda_user_id,
      duracao_min: c.duracao_min,
      perguntas: c.perguntas,
      dias: c.dias,
    },
    { requestId },
  );
}
