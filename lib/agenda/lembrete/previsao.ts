/**
 * O QUE A IA PODE PROMETER SOBRE O LEMBRETE — dito pela máquina, não adivinhado.
 *
 * Até a migration 0217 a ferramenta de remarcar dizia ao modelo que "o lembrete é refeito
 * sozinho", e nenhum lembrete existia: o paciente ouvia uma promessa que o sistema não
 * cumpria. Agora o resultado de marcar e de remarcar traz `lembrete`, e a descrição das
 * ferramentas manda prometer SÓ o que ele confirma.
 *
 * ─── Por que `instrucao` e não só o booleano ──────────────────────────────────
 *
 * O modelo repassa o que recebe. Um `sera_enviado: false` sem motivo vira "não vou te
 * lembrar" dito de qualquer jeito — inclusive para quem pediu para não receber mensagens,
 * que não precisa ouvir isso. A frase pronta diz o que fazer em cada caso.
 *
 * ─── O limite desta previsão ──────────────────────────────────────────────────
 *
 * Ela responde "o sistema vai tentar avisar?", não "a mensagem vai chegar". Falta de
 * modelo aprovado no canal oficial, por exemplo, só se descobre na hora de enviar — e aí a
 * equipe é avisada na Central (`appointment_reminder_failed`). Prometer entrega seria
 * repetir o defeito que esta previsão existe para corrigir.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { momentoDevido } from "./decisao";

export type MotivoSemLembrete =
  | "desligado"
  | "contato_pediu_para_nao_receber"
  | "marcado_depois_do_momento_do_lembrete"
  | "sem_contato"
  | "indeterminado";

export interface PrevisaoDoLembrete {
  sera_enviado: boolean;
  /** Só quando `sera_enviado`: quantas horas antes da consulta o aviso sai (arredondado). */
  antecedencia_horas?: number;
  motivo?: MotivoSemLembrete;
  /** O que o modelo deve (e não deve) dizer ao cliente sobre o assunto. */
  instrucao: string;
}

export interface EntradaDaPrevisao {
  ligado: boolean;
  minutosAntes: number;
  temContato: boolean;
  contatoSemMensagens: boolean;
  comecaEm: Date;
  agora: Date;
}

const NAO_PROMETA = "Não prometa aviso nem lembrete ao cliente.";

export function preverLembrete(e: EntradaDaPrevisao): PrevisaoDoLembrete {
  if (!e.temContato) {
    return {
      sera_enviado: false,
      motivo: "sem_contato",
      instrucao: `Este compromisso não está ligado a nenhum contato, então não há para quem mandar lembrete. ${NAO_PROMETA}`,
    };
  }
  if (e.contatoSemMensagens) {
    return {
      sera_enviado: false,
      motivo: "contato_pediu_para_nao_receber",
      instrucao: `O cliente pediu para não receber mensagens: não haverá lembrete. ${NAO_PROMETA}`,
    };
  }
  if (!e.ligado) {
    return {
      sera_enviado: false,
      motivo: "desligado",
      instrucao: `Este tipo de atendimento não tem lembrete automático. ${NAO_PROMETA}`,
    };
  }
  if (e.agora.getTime() >= momentoDevido(e.comecaEm, e.minutosAntes).getTime()) {
    return {
      sera_enviado: false,
      motivo: "marcado_depois_do_momento_do_lembrete",
      instrucao:
        `O horário está tão perto que o lembrete automático não será enviado. ${NAO_PROMETA} ` +
        `Confirme data e hora aqui mesmo na conversa.`,
    };
  }
  const horas = Math.max(1, Math.round(e.minutosAntes / 60));
  return {
    sera_enviado: true,
    antecedencia_horas: horas,
    instrucao:
      `O cliente receberá um lembrete por WhatsApp cerca de ${horas} h antes do horário. ` +
      `Pode avisá-lo disso — e só disso.`,
  };
}

/**
 * A previsão de um compromisso que ACABOU de ser marcado ou remarcado.
 *
 * Lê o tipo e o contato com a organização no filtro (o client da ferramenta é service-role
 * e a RLS não vale). Erro de leitura nunca vira promessa: `indeterminado` manda o modelo
 * não prometer.
 */
export async function preverLembreteDoCompromisso(
  supabase: SupabaseClient,
  organizationId: string,
  alvo: { eventTypeId: string | null; contactId: string | null; comecaEm: Date },
  agora: Date = new Date(),
): Promise<PrevisaoDoLembrete> {
  const indeterminado: PrevisaoDoLembrete = {
    sera_enviado: false,
    motivo: "indeterminado",
    instrucao: `Não consegui verificar se haverá lembrete. ${NAO_PROMETA}`,
  };

  if (!alvo.contactId) {
    return preverLembrete({
      ligado: false,
      minutosAntes: 0,
      temContato: false,
      contatoSemMensagens: false,
      comecaEm: alvo.comecaEm,
      agora,
    });
  }
  if (!alvo.eventTypeId) return indeterminado;

  const [tipo, contato] = await Promise.all([
    supabase
      .from("calendar_event_types")
      .select("reminder_enabled, reminder_minutes_before")
      .eq("organization_id", organizationId)
      .eq("id", alvo.eventTypeId)
      .maybeSingle(),
    supabase
      .from("contacts")
      .select("is_blocked, is_anonymized")
      .eq("organization_id", organizationId)
      .eq("id", alvo.contactId)
      .maybeSingle(),
  ]);
  if (tipo.error || contato.error || !tipo.data || !contato.data) return indeterminado;

  const t = tipo.data as { reminder_enabled: boolean; reminder_minutes_before: number };
  const c = contato.data as { is_blocked: boolean; is_anonymized: boolean };
  return preverLembrete({
    ligado: Boolean(t.reminder_enabled),
    minutosAntes: Number(t.reminder_minutes_before),
    temContato: true,
    contatoSemMensagens: Boolean(c.is_blocked || c.is_anonymized),
    comecaEm: alvo.comecaEm,
    agora,
  });
}
