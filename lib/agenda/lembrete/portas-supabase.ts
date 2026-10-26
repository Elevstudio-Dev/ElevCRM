/**
 * As portas do lembrete ligadas ao banco e ao envio de verdade.
 *
 * A regra mora em `./executar` e `./decisao`; aqui só há tradução: coluna ↔ campo,
 * e as consultas com a organização SEMPRE no filtro (o admin client ignora a RLS, então
 * o `organization_id` de cada consulta é a única fronteira de tenant neste caminho).
 *
 * ⚠️ Toda escrita no compromisso é guardada por `reminder_state = 'pending'` E pelo
 * `reminder_armed_at` lido: remarcar no meio do envio (o trigger da 0217 rearma) faz a
 * escrita casar zero linhas em vez de pisar no lembrete novo.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { sendMessageHandler } from "@/app/api/v1/messages/_handler";
import { nomesDosAtendentes } from "@/lib/users/nome-do-atendente";

import { escolherLinha, type LinhaDeModelo } from "./modelo-do-tipo";
import type {
  Alerta,
  CompromissoDevido,
  ConversaDeEnvio,
  EnvioFeito,
  EnvioPedido,
  LembreteDevido,
  ModeloAprovado,
  PortasDoLembrete,
} from "./executar";

/** Quem aparece como autor da mensagem na trilha. Não é um agente de IA: é o relógio. */
const AUTOR_DO_LEMBRETE = "agenda-lembrete";

interface LinhaDoCompromisso {
  id: string;
  organization_id: string;
  contact_id: string | null;
  conversation_id: string | null;
  starts_at: string;
  time_zone: string;
  location_details: string | null;
  owner_user_id: string | null;
  title: string;
  reminder_attempts: number;
  reminder_armed_at: string;
  reminder_detail: string | null;
  event_type: {
    id: string;
    name: string;
    reminder_minutes_before: number;
    reminder_template_name: string | null;
    location_details: string | null;
  } | null;
  contact: {
    name: string | null;
    display_name: string | null;
    is_blocked: boolean;
    is_anonymized: boolean;
  } | null;
}

interface LinhaDaConversa {
  id: string;
  last_inbound_at: string | null;
  channel_sessions: { id: string; provider: string | null; status: string; archived_at: string | null } | null;
}

const COLUNAS_DA_CONVERSA =
  "id, last_inbound_at, channel_sessions:channel_session_id(id, provider, status, archived_at)";

function paraConversa(l: LinhaDaConversa): ConversaDeEnvio {
  const s = l.channel_sessions;
  return {
    id: l.id,
    canalNoAr: Boolean(s && s.status === "WORKING" && !s.archived_at),
    provedor: s?.provider ?? null,
    ultimaEntradaEm: l.last_inbound_at,
  };
}

export function portasDoSupabase(admin: SupabaseClient, relogio: () => Date = () => new Date()): PortasDoLembrete {
  // O nome da clínica não muda no meio de um tick: uma leitura por organização basta.
  const clinicas = new Map<string, string | null>();

  return {
    agora: relogio,

    async carregar({ id, organizationId }: LembreteDevido): Promise<CompromissoDevido | null> {
      const { data, error } = await admin
        .from("calendar_appointments")
        .select(
          "id, organization_id, contact_id, conversation_id, starts_at, time_zone, location_details, " +
            "owner_user_id, title, reminder_attempts, reminder_armed_at, reminder_detail, " +
            "event_type:calendar_event_types(id, name, reminder_minutes_before, reminder_template_name, location_details), " +
            "contact:contacts(name, display_name, is_blocked, is_anonymized)",
        )
        .eq("id", id)
        .eq("organization_id", organizationId)
        .eq("reminder_state", "pending")
        .in("status", ["pending", "confirmed"])
        .maybeSingle();
      if (error) throw new Error(`lembrete: leitura do compromisso falhou: ${error.message}`);

      const l = data as unknown as LinhaDoCompromisso | null;
      if (!l || !l.event_type || !l.contact_id) return null;

      return {
        id: l.id,
        organizationId: l.organization_id,
        contactId: l.contact_id,
        conversationId: l.conversation_id,
        startsAt: new Date(l.starts_at),
        timeZone: l.time_zone,
        localDoCompromisso: l.location_details?.trim() || null,
        ownerUserId: l.owner_user_id,
        titulo: l.title,
        tentativas: l.reminder_attempts,
        armadoEm: new Date(l.reminder_armed_at),
        armadoEmBruto: l.reminder_armed_at,
        detalheAtual: l.reminder_detail,
        tipo: {
          id: l.event_type.id,
          nome: l.event_type.name,
          minutosAntes: l.event_type.reminder_minutes_before,
          modelo: l.event_type.reminder_template_name?.trim() || null,
          localPadrao: l.event_type.location_details?.trim() || null,
        },
        contato: {
          // `name` antes de `display_name` é a precedência do produto (ver lib/agenda/consulta.ts).
          nome: l.contact?.name ?? l.contact?.display_name ?? null,
          semMensagens: Boolean(l.contact?.is_blocked || l.contact?.is_anonymized),
        },
      };
    },

    async nomeDoProfissional(userId) {
      if (!userId) return null;
      const nomes = await nomesDosAtendentes([userId]);
      return nomes.get(userId) ?? null;
    },

    async nomeDaClinica(organizationId) {
      if (clinicas.has(organizationId)) return clinicas.get(organizationId) ?? null;
      const { data } = await admin
        .from("organizations")
        .select("display_name")
        .eq("id", organizationId)
        .maybeSingle();
      // É o nome da ORGANIZAÇÃO (a clínica), não o de um contato: `organizations.display_name`
      // tem cadeia própria e legítima, e o guarda de `rotulo-do-contato` a isenta pelo nome.
      const organizacao = data as { display_name: string | null } | null;
      const nomeDaOrganizacao = organizacao?.display_name?.trim() || null;
      clinicas.set(organizationId, nomeDaOrganizacao);
      return nomeDaOrganizacao;
    },

    async conversaParaOContato(c: CompromissoDevido): Promise<ConversaDeEnvio | null> {
      // 1. A conversa que o compromisso já aponta, se ainda for do contato e individual.
      if (c.conversationId) {
        const { data } = await admin
          .from("conversations")
          .select(COLUNAS_DA_CONVERSA)
          .eq("id", c.conversationId)
          .eq("organization_id", c.organizationId)
          .eq("contact_id", c.contactId)
          .eq("is_group", false)
          .maybeSingle();
        if (data) {
          const conv = paraConversa(data as unknown as LinhaDaConversa);
          if (conv.canalNoAr) return conv;
        }
      }

      // 2. A conversa individual mais recente do contato; prefere a de canal no ar.
      const { data: lista } = await admin
        .from("conversations")
        .select(COLUNAS_DA_CONVERSA)
        .eq("organization_id", c.organizationId)
        .eq("contact_id", c.contactId)
        .eq("is_group", false)
        .order("last_message_at", { ascending: false, nullsFirst: false })
        .limit(10);
      const conversas = ((lista ?? []) as unknown as LinhaDaConversa[]).map(paraConversa);
      const noAr = conversas.find((x) => x.canalNoAr);
      if (noAr) return noAr;

      // 3. Nunca conversou (paciente importado): abre a conversa pelo canal que está no ar.
      const { data: sessoes } = await admin
        .from("channel_sessions")
        .select("id, provider")
        .eq("organization_id", c.organizationId)
        .eq("status", "WORKING")
        .is("archived_at", null)
        .order("created_at", { ascending: true })
        .limit(1);
      const sessao = (sessoes ?? [])[0] as { id: string; provider: string | null } | undefined;
      if (!sessao) return conversas[0] ?? null;

      const { data: aberta, error } = await admin.rpc("fn_upsert_wa_conversation", {
        p_org: c.organizationId,
        p_contact: c.contactId,
        p_session: sessao.id,
      });
      if (error || !aberta) return conversas[0] ?? null;
      return {
        id: String(aberta),
        canalNoAr: true,
        provedor: sessao.provider,
        ultimaEntradaEm: null,
      };
    },

    async modeloAprovado(organizationId, nome): Promise<ModeloAprovado | null> {
      const { data } = await admin
        .from("meta_templates")
        .select("name, language, status, components, parameter_format")
        .eq("organization_id", organizationId)
        .eq("name", nome);
      // A MESMA escolha que a tela fez ao salvar o tipo (ver `modelo-do-tipo.ts`).
      const l = escolherLinha((data ?? []) as LinhaDeModelo[]);
      if (!l) return null;
      return {
        nome: l.name,
        idioma: l.language,
        status: l.status,
        componentes: l.components,
        formato: l.parameter_format,
      };
    },

    async mensagemDaChave(c, conversaId, chave) {
      const { data } = await admin
        .from("messages")
        .select("id")
        .eq("organization_id", c.organizationId)
        .eq("conversation_id", conversaId)
        .gte("created_at", c.armadoEmBruto)
        .eq("metadata->>idempotency_key", chave)
        .neq("status", "failed")
        .limit(1);
      const m = (data ?? [])[0] as { id: string } | undefined;
      return m ? { id: m.id } : null;
    },

    async reivindicar(c) {
      const { data } = await admin
        .from("calendar_appointments")
        .update({ reminder_attempts: c.tentativas + 1 })
        .eq("id", c.id)
        .eq("organization_id", c.organizationId)
        .eq("reminder_state", "pending")
        .eq("reminder_attempts", c.tentativas)
        .eq("reminder_armed_at", c.armadoEmBruto)
        .select("id");
      return (data ?? []).length === 1;
    },

    async enviar(organizationId: string, pedido: EnvioPedido): Promise<EnvioFeito> {
      const mensagem = await sendMessageHandler(
        admin,
        {
          organization_id: organizationId,
          actor: { type: "ai_agent", id: AUTOR_DO_LEMBRETE, role: "manager" },
          requestId: pedido.chave,
        },
        {
          conversation_id: pedido.conversationId,
          type: pedido.modelo ? "template" : "text",
          body: pedido.corpo,
          ...(pedido.modelo
            ? {
                template_name: pedido.modelo.nome,
                template_language: pedido.modelo.idioma,
                template_values: pedido.modelo.valores,
              }
            : {}),
          metadata: {
            idempotency_key: pedido.chave,
            appointment_id: pedido.compromissoId,
            origin: "appointment_reminder",
          },
        },
      );
      return {
        mensagemId: mensagem.id,
        status: mensagem.status,
        codigoDeErro: mensagem.error_code ?? null,
      };
    },

    async registrar(c, desfecho) {
      const campos =
        desfecho.estado === "sent"
          ? {
              reminder_state: "sent",
              reminder_sent_at: desfecho.em.toISOString(),
              reminder_message_id: desfecho.mensagemId,
              reminder_detail: null,
            }
          : desfecho.estado === "pending"
            ? { reminder_detail: desfecho.detalhe }
            : { reminder_state: desfecho.estado, reminder_detail: desfecho.detalhe };

      const { error } = await admin
        .from("calendar_appointments")
        .update(campos)
        .eq("id", c.id)
        .eq("organization_id", c.organizationId)
        .eq("reminder_state", "pending")
        .eq("reminder_armed_at", c.armadoEmBruto);
      if (error) throw new Error(`lembrete: gravar o desfecho falhou: ${error.message}`);
    },

    async alertar(organizationId: string, alerta: Alerta) {
      const { tipo, id } = alerta.referencia;
      // Um aviso aberto por (tipo de problema, alvo): repetir a cada tick de 5 min
      // enterraria o aviso que pede decisão (mesma lição de `insertInboxItem`).
      const { data: aberto } = await admin
        .from("agent_inbox_items")
        .select("id")
        .eq("organization_id", organizationId)
        .eq("kind", "appointment_reminder_failed")
        .eq("status", "open")
        .eq("ref_kind", tipo)
        .eq("ref_id", id)
        .limit(1);
      if ((aberto ?? []).length > 0) return;

      await admin.from("agent_inbox_items").insert({
        organization_id: organizationId,
        kind: "appointment_reminder_failed",
        severity: "warn",
        title: alerta.titulo,
        body: alerta.corpo,
        ref_kind: tipo,
        ref_id: id,
      });
    },
  };
}
