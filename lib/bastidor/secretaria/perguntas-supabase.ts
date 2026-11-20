/**
 * As portas do tick das perguntas à secretaria, ligadas ao banco (cliente administrativo, service role).
 *
 * O roteiro está em `perguntas-tick.ts` e a regra de horário em `perguntas.ts`; aqui só há consulta e escrita.
 * O envio NÃO sai daqui: `enfileirar` põe um job `bastidor_turn` na fila e quem fala com o WhatsApp é o worker, pela
 * mesma cadeia de proteções de qualquer mensagem (`runBeforeSend`, com `bastidor`). Mesmo desenho do cron do
 * follow-up (`followup-flow-worker`), que também só insere na `job_queue`.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { lerConfigDaSecretaria } from "@/lib/agenda/secretaria/config";
import { ultimaConferidaDaOrg } from "@/lib/agenda/secretaria/atualidade";

import type {
  ConversaDaSecretaria,
  MotivoDoAviso,
  PedidoDeEnvio,
  PortasDaSecretaria,
  PortasDoTick,
  SecretariaAtiva,
} from "./perguntas-tick";
import type { PerguntaFeita } from "./perguntas";

/** Fuso padrão quando nem a jornada do dono nem a organização dizem qual é (o mesmo do handler do worker). */
const FUSO_PADRAO = "America/Sao_Paulo";

function erro(contexto: string, e: { message: string } | null): void {
  if (e) throw new Error(`${contexto}: ${e.message}`);
}

interface LinhaDePergunta {
  dia: string;
  horario: string;
  estado: PerguntaFeita["estado"];
  pedida_em: string;
  lembrete_pedido_em: string | null;
  respondida_em: string | null;
  admin_avisado_em: string | null;
}

const data = (v: string | null): Date | null => (v === null ? null : new Date(v));

export function portasDoTickNoSupabase(
  admin: SupabaseClient,
  registrarErro: (contexto: string, e: unknown) => void,
  relogio: () => Date = () => new Date(),
): PortasDoTick {
  return {
    agora: relogio,
    registrarErro,

    async listarSecretarias(): Promise<SecretariaAtiva[]> {
      // Só quem ligou a agenda da secretaria entra: o filtro é no banco para não varrer a base inteira a cada 5 min.
      const { data: orgs, error: eOrgs } = await admin
        .from("organizations")
        .select("id, timezone, settings")
        .eq("settings->secretaria->>ativa", "true");
      erro("organizations", eOrgs);
      const ativas = (orgs ?? []) as Array<{ id: string; timezone: string | null; settings: unknown }>;
      if (ativas.length === 0) return [];
      const ids = ativas.map((o) => o.id);

      const { data: contatos, error: eContatos } = await admin
        .from("contacts")
        .select("id, organization_id, display_name")
        .eq("papel_interno", "secretaria")
        .eq("is_blocked", false)
        .eq("is_anonymized", false)
        .in("organization_id", ids);
      erro("contacts", eContatos);

      const { data: jornadas, error: eJornadas } = await admin
        .from("attendant_availability")
        .select("organization_id, user_id, schedule")
        .in("organization_id", ids);
      erro("attendant_availability", eJornadas);
      const fusoDoDono = new Map<string, string>();
      for (const j of (jornadas ?? []) as Array<{ organization_id: string; user_id: string; schedule: unknown }>) {
        const tz = (j.schedule as { timezone?: unknown } | null)?.timezone;
        if (typeof tz === "string" && tz.trim() !== "") fusoDoDono.set(`${j.organization_id}:${j.user_id}`, tz);
      }

      const lista: SecretariaAtiva[] = [];
      for (const c of (contatos ?? []) as Array<{ id: string; organization_id: string; display_name: string | null }>) {
        const org = ativas.find((o) => o.id === c.organization_id);
        if (org === undefined) continue;
        const config = lerConfigDaSecretaria(org.settings);
        if (!config.ativa) continue;
        const doDono = config.dono_da_agenda_user_id
          ? fusoDoDono.get(`${org.id}:${config.dono_da_agenda_user_id}`)
          : undefined;
        lista.push({
          organizationId: org.id,
          contactId: c.id,
          nome: c.display_name,
          config,
          fuso: doDono ?? org.timezone ?? FUSO_PADRAO,
        });
      }
      return lista;
    },

    portasDe(sec: SecretariaAtiva): PortasDaSecretaria {
      const { organizationId, contactId } = sec;
      const chave = { organization_id: organizationId, contact_id: contactId };
      return {
        async feitasHoje(dia) {
          const { data: linhas, error: e } = await admin
            .from("agenda_perguntas")
            .select("dia, horario, estado, pedida_em, lembrete_pedido_em, respondida_em, admin_avisado_em")
            .match(chave)
            .eq("dia", dia);
          erro("agenda_perguntas", e);
          return ((linhas ?? []) as LinhaDePergunta[]).map((l) => ({
            dia: l.dia,
            horario: l.horario,
            estado: l.estado,
            pedidaEm: new Date(l.pedida_em),
            lembretePedidoEm: data(l.lembrete_pedido_em),
            respondidaEm: data(l.respondida_em),
            adminAvisadoEm: data(l.admin_avisado_em),
          }));
        },

        ultimaConferidaEm: () => ultimaConferidaDaOrg(admin, organizationId),

        async primeiraRespostaDesde(desde) {
          const { data: conversas, error: eConv } = await admin
            .from("conversations")
            .select("id")
            .match(chave)
            .limit(20);
          erro("conversations", eConv);
          const ids = ((conversas ?? []) as Array<{ id: string }>).map((c) => c.id);
          if (ids.length === 0) return null;
          const { data: msgs, error: eMsg } = await admin
            .from("messages")
            .select("created_at")
            .eq("organization_id", organizationId)
            .in("conversation_id", ids)
            .eq("direction", "inbound")
            .gte("created_at", desde.toISOString())
            .order("created_at", { ascending: true })
            .limit(1);
          erro("messages", eMsg);
          const primeira = (msgs?.[0] as { created_at: string } | undefined)?.created_at;
          return primeira ? new Date(primeira) : null;
        },

        async registrar(dia, horario, estado) {
          const { data: criadas, error: e } = await admin
            .from("agenda_perguntas")
            .upsert(
              { ...chave, dia, horario, estado },
              { onConflict: "organization_id,contact_id,dia,horario", ignoreDuplicates: true },
            )
            .select("id");
          erro("agenda_perguntas", e);
          return (criadas ?? []).length > 0;
        },

        async marcarRespondida(dia, horario, quando) {
          const { error: e } = await admin
            .from("agenda_perguntas")
            .update({ respondida_em: quando.toISOString() })
            .match({ ...chave, dia, horario });
          erro("agenda_perguntas", e);
        },

        async marcarLembrete(dia, horario) {
          const { data: mexidas, error: e } = await admin
            .from("agenda_perguntas")
            .update({ lembrete_pedido_em: relogio().toISOString() })
            .match({ ...chave, dia, horario })
            .is("lembrete_pedido_em", null)
            .select("id");
          erro("agenda_perguntas", e);
          return (mexidas ?? []).length > 0;
        },

        async marcarAdminAvisado(dia, horario) {
          const { data: mexidas, error: e } = await admin
            .from("agenda_perguntas")
            .update({ admin_avisado_em: relogio().toISOString() })
            .match({ ...chave, dia, horario })
            .is("admin_avisado_em", null)
            .select("id");
          erro("agenda_perguntas", e);
          return (mexidas ?? []).length > 0;
        },

        async conversa(): Promise<ConversaDaSecretaria | null> {
          const { data: linhas, error: e } = await admin
            .from("conversations")
            .select("id, channel_session_id")
            .match(chave)
            .eq("is_group", false)
            .order("last_message_at", { ascending: false, nullsFirst: false })
            .limit(1);
          erro("conversations", e);
          const c = linhas?.[0] as { id: string; channel_session_id: string } | undefined;
          return c ? { conversationId: c.id, channelSessionId: c.channel_session_id } : null;
        },

        async enfileirar(pedido: PedidoDeEnvio) {
          const { error: e } = await admin.from("job_queue").insert({
            organization_id: organizationId,
            contact_id: contactId,
            kind: "bastidor_turn",
            payload: {
              conversation_id: pedido.conversa.conversationId,
              contact_id: contactId,
              channel_session_id: pedido.conversa.channelSessionId,
              acao: pedido.acao,
              dia: pedido.dia,
              horario: pedido.horario,
            },
          });
          erro("job_queue", e);
        },

        async resumoPendente() {
          const { data: linhas, error: e } = await admin
            .from("agenda_relatos")
            .select("id, created_at")
            .match(chave)
            .eq("estado", "lido")
            .order("created_at", { ascending: false })
            .limit(1);
          erro("agenda_relatos", e);
          const r = linhas?.[0] as { id: string; created_at: string } | undefined;
          return r ? { relatoId: r.id, criadoEm: new Date(r.created_at) } : null;
        },

        async enfileirarLembreteDaConferencia(relatoId, conversa) {
          // `source_event_id` = o relato: o índice único (organização, source_event_id) da fila é a idempotência de
          // "no máximo UM lembrete por resumo" — duas instâncias do cron, ou dois horários do dia, não mandam dois.
          // A coluna existe para deduplicar evento → job; o relato É o evento que origina este job.
          const { error: e } = await admin.from("job_queue").insert({
            organization_id: organizationId,
            contact_id: contactId,
            kind: "bastidor_turn",
            source_event_id: relatoId,
            payload: {
              conversation_id: conversa.conversationId,
              contact_id: contactId,
              channel_session_id: conversa.channelSessionId,
              acao: "lembrar_conferencia",
              relato_id: relatoId,
            },
          });
          if ((e as { code?: string } | null)?.code === "23505") return false;
          erro("job_queue", e);
          return true;
        },

        async avisarAdmin(motivo: MotivoDoAviso, dia, horario) {
          // Um aviso ABERTO por pergunta: o mesmo tick não empilha cartões iguais na Central de avisos.
          const refId = contactId;
          const titulo =
            motivo === "sem_conversa"
              ? `Não há conversa com a secretaria para perguntar a agenda das ${horario}`
              : `A secretaria não respondeu à pergunta da agenda das ${horario}`;
          const corpo =
            motivo === "sem_conversa"
              ? `${sec.nome ?? "A secretaria"} ainda não tem uma conversa neste número, então a IA não conseguiu perguntar a agenda de ${dia}. Peça para ela mandar uma mensagem ao número da clínica, ou abra a conversa por aqui. Enquanto a agenda não for conferida, a IA não oferece horários aos pacientes.`
              : `${sec.nome ?? "A secretaria"} não respondeu à pergunta e ao lembrete da agenda de ${dia} (${horario}). Enquanto a agenda não for conferida, a IA deixa de oferecer horários aos pacientes e chama a equipe. Confira se ela viu a mensagem.`;
          const { data: aberto } = await admin
            .from("agent_inbox_items")
            .select("id")
            .eq("organization_id", organizationId)
            .eq("kind", "agenda_sem_resposta")
            .eq("status", "open")
            .eq("ref_kind", "contacts")
            .eq("ref_id", refId)
            .limit(1);
          if ((aberto ?? []).length > 0) return;
          const { error: e } = await admin.from("agent_inbox_items").insert({
            organization_id: organizationId,
            kind: "agenda_sem_resposta",
            severity: "warn",
            title: titulo,
            body: corpo,
            ref_kind: "contacts",
            ref_id: refId,
          });
          erro("agent_inbox_items", e);
        },
      };
    },
  };
}
