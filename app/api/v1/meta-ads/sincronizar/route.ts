/**
 * POST /api/v1/meta-ads/sincronizar — "Atualizar agora" (gestor+).
 *
 * O cron já atualiza de hora em hora; este botão serve para quem acabou de conectar ou de mexer numa campanha. Duas
 * cercas: a organização vem SEMPRE da organização ativa (nunca do corpo), e um segundo pedido em menos de 2 minutos
 * não chama a Meta de novo — a Meta limita as chamadas por conta, e um botão apertado várias vezes gastaria o limite
 * que o cron precisa.
 */
import { randomUUID } from "node:crypto";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { mensagemDoErro, sincronizarOrganizacao } from "@/lib/meta-ads/sincronizar";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const INTERVALO_MINIMO_MS = 2 * 60_000;

export async function POST(): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "meta_ads", allowPlatformAdmin: true });
  if (!authz.ok) return authz.response;
  const orgId = authz.org.orgId;

  const admin = createAdminClient();
  const { data: con, error } = await admin
    .from("meta_ads_conexoes")
    .select("last_synced_at")
    .eq("organization_id", orgId)
    .maybeSingle();
  if (error) return fail("internal_error", "Não foi possível ler a conexão.", 500, { requestId });
  if (!con) return fail("not_found", "A conta de anúncios ainda não foi conectada.", 404, { requestId });

  const ultima = (con as { last_synced_at: string | null }).last_synced_at;
  if (ultima && Date.now() - Date.parse(ultima) < INTERVALO_MINIMO_MS) {
    return ok({ atualizou: false, jaAtualizado: true, mensagem: null }, { requestId });
  }

  const r = await sincronizarOrganizacao(admin, orgId);
  if (r.ok) return ok({ atualizou: true, jaAtualizado: false, linhas: r.linhas, mensagem: null }, { requestId });
  // Falha da Meta não é falha nossa: 200 com a frase pronta, a mesma que fica gravada na conexão.
  return ok(
    { atualizou: false, jaAtualizado: false, mensagem: r.erro === "sem_conexao" ? null : mensagemDoErro(r.erro) },
    { requestId },
  );
}
