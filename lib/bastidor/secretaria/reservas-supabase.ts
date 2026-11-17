/**
 * As portas do tick das reservas, ligadas ao banco (cliente administrativo, service role). O roteiro está em
 * `reservas-tick.ts`; aqui só há consulta e escrita. O envio NÃO sai daqui: o cron só enfileira (`bastidor_turn`).
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { conversaDaSecretariaDaOrg, enfileirarTrabalhoDaReserva } from "@/lib/agenda/secretaria/conversa";
import {
  fecharReserva,
  reservasConfirmadasSemCompromisso,
  reservasSemPergunta,
  reservasVencidas,
} from "@/lib/agenda/secretaria/reservas";

import type { PortasDoTickDeReservas } from "./reservas-tick";

export function portasDoTickDeReservasNoSupabase(
  admin: SupabaseClient,
  registrarErro: (contexto: string, e: unknown) => void,
  relogio: () => Date = () => new Date(),
): PortasDoTickDeReservas {
  return {
    agora: relogio,
    registrarErro,
    vencidas: (agora) => reservasVencidas(admin, agora),
    semPergunta: (agora) => reservasSemPergunta(admin, agora),
    confirmadasSemCompromisso: (agora) => reservasConfirmadasSemCompromisso(admin, agora),
    expirar: (r, agora) => fecharReserva(admin, r.organizationId, r.id, "expirada", agora),
    conversaDaSecretaria: (organizationId) => conversaDaSecretariaDaOrg(admin, organizationId),
    enfileirar: (organizationId, conversa, acao, reservaId) =>
      enfileirarTrabalhoDaReserva(admin, organizationId, conversa, acao, reservaId),

    async chamarEquipe(organizationId, pacienteId, aviso) {
      // Um aviso ABERTO por (paciente, título): o mesmo tick não empilha cartões iguais na Central de avisos.
      const { data: aberto } = await admin
        .from("agent_inbox_items")
        .select("id")
        .eq("organization_id", organizationId)
        .eq("kind", "agenda_sem_resposta")
        .eq("status", "open")
        .eq("ref_kind", "contacts")
        .eq("ref_id", pacienteId)
        .eq("title", aviso.titulo)
        .limit(1);
      if ((aberto ?? []).length > 0) return;
      const { error } = await admin.from("agent_inbox_items").insert({
        organization_id: organizationId,
        kind: "agenda_sem_resposta",
        severity: "warn",
        title: aviso.titulo,
        body: aviso.corpo,
        ref_kind: "contacts",
        ref_id: pacienteId,
      });
      if (error) throw new Error(`agent_inbox_items: ${error.message}`);
    },
  };
}
