/**
 * GET /api/v1/ai/followups/queue/proximos — a fila ANTES da inscrição (viewer+).
 *
 * Para cada fluxo de silêncio COM ritmo da organização ativa: quem são os
 * próximos contatos parados que vão entrar, na ordem, com a hora prevista, e
 * quantos já entraram nas últimas 24h contra o limite. A fila "de verdade"
 * (inscrições vivas) continua em `/queue`; esta mostra o que vem depois dela.
 *
 * ⚠️ O client de varredura é o service-role (a mesma varredura do cron lê
 * conversas de TODAS as orgs). Por isso o filtro por organização abaixo NÃO é
 * opcional: sem ele um viewer veria a fila de outra clínica. Os nomes dos
 * contatos vêm do client DO USUÁRIO, com RLS, de propósito — duas barreiras.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { rotuloDoContato } from "@/lib/contacts/rotulo-do-contato";
import {
  createSupabaseSilenceSweepDb,
  proximosDaFila,
} from "@/lib/followup/silence-sweep";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const POR_FLUXO = 15;

export async function GET(_req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("viewer", { requestId, resource: "followup_queue" });
  if (!authz.ok) return authz.response;
  const { org: activeOrg } = authz;

  try {
    const db = createSupabaseSilenceSweepDb(createAdminClient());
    const todos = await db.loadActiveSilencePointers();
    const dosMeus = todos.filter(
      (p) => p.organization_id === activeOrg.orgId && p.ritmo !== null,
    );
    if (dosMeus.length === 0) return ok({ fluxos: [] }, { requestId });

    const agora = new Date();
    const supabase = await createClient();

    const { data: nomes } = await supabase
      .from("followup_flow_pointers")
      .select("id, name")
      .eq("organization_id", activeOrg.orgId)
      .in(
        "id",
        dosMeus.map((p) => p.id),
      );
    const nomeDoFluxo = new Map(
      ((nomes ?? []) as Array<{ id: string; name: string }>).map((n) => [n.id, n.name]),
    );

    const fluxos = [];
    for (const p of dosMeus) {
      const [itens, recentes] = await Promise.all([
        proximosDaFila(db, p, () => agora, POR_FLUXO),
        db.loadInscricoesRecentes(p.id, new Date(agora.getTime() - 24 * 60 * 60_000).toISOString()),
      ]);

      const ids = itens.map((i) => i.contactId);
      const { data: contatos } = ids.length
        ? await supabase
            .from("contacts")
            .select("id, name, display_name, phone_number")
            .eq("organization_id", activeOrg.orgId)
            .in("id", ids)
        : { data: [] };
      const porId = new Map(
        (
          (contatos ?? []) as Array<{
            id: string;
            name: string | null;
            display_name: string | null;
            phone_number: string | null;
          }>
        ).map((c) => [c.id, c]),
      );

      fluxos.push({
        pointer_id: p.id,
        nome: nomeDoFluxo.get(p.id) ?? "Follow-up",
        ritmo: p.ritmo,
        usados_24h: recentes.criadasEm.length,
        itens: itens.map((i) => {
          const c = porId.get(i.contactId);
          return {
            posicao: i.posicao,
            contact: { id: i.contactId, name: c ? rotuloDoContato(c) : "Contato removido" },
            entra_em: i.entraEm.toISOString(),
          };
        }),
      });
    }
    return ok({ fluxos }, { requestId });
  } catch {
    return fail("internal_error", "Erro ao montar a fila de próximos.", 500, { requestId });
  }
}
