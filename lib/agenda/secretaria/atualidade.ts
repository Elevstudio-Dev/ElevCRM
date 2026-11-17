/**
 * A AGENDA DA SECRETARIA ESTÁ FRESCA? — a decisão que impede a IA de oferecer horário velho.
 *
 * A agenda daqui é um ESPELHO do que a secretaria contou. Espelho envelhece: às 15h, o que ela disse às 8h30 pode
 * já não valer (alguém marcou, alguém faltou). Oferecer um horário que não existe e voltar atrás é pior do que
 * demorar um pouco mais para responder (`crm_find_free_slots` já diz isso). Então a IA só oferece o que foi
 * CONFERIDO recentemente:
 *
 *   conferida há pouco (≤ validade de hoje)            → 'atual'            oferece tudo
 *   conferida há um tempo (≤ validade dos dias futuros) → 'sem_hoje'         oferece de amanhã em diante
 *   mais velha que isso, ou nunca conferida             → 'desatualizada'    não oferece nada; chama o humano
 *
 * Organização que não ligou a secretaria → 'sem_secretaria': a regra simplesmente não existe para ela.
 * A regra é pura (relógio injetado); o `ultimaConferidaDaOrg` é a única parte que lê banco.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { lerConfigDaSecretaria, type ConfigDaSecretaria } from "./config";

export type EstadoDaAgenda = "sem_secretaria" | "atual" | "sem_hoje" | "desatualizada";

const HORA_EM_MS = 3_600_000;

export function decidirAtualidade(entrada: {
  config: ConfigDaSecretaria;
  /** `agenda_relatos.conferido_em` do relato conferido mais recente, ou nulo se nunca houve. */
  ultimaConferidaEm: Date | null;
  /** INJETADO. */
  agora: Date;
}): EstadoDaAgenda {
  const { config, ultimaConferidaEm, agora } = entrada;
  if (!config.ativa) return "sem_secretaria";
  if (ultimaConferidaEm === null) return "desatualizada";

  const idade = agora.getTime() - ultimaConferidaEm.getTime();
  // Relógio da máquina adiantado em relação ao carimbo (idade negativa) não pode virar "super fresca": trata como agora.
  const idadeMs = Math.max(0, idade);
  if (idadeMs <= config.validade_hoje_horas * HORA_EM_MS) return "atual";
  if (idadeMs <= config.validade_futuro_horas * HORA_EM_MS) return "sem_hoje";
  return "desatualizada";
}

/** O instante da última conferência da organização, ou nulo. */
export async function ultimaConferidaDaOrg(supabase: SupabaseClient, organizationId: string): Promise<Date | null> {
  const { data, error } = await supabase
    .from("agenda_relatos")
    .select("conferido_em")
    .eq("organization_id", organizationId)
    .eq("estado", "conferido")
    .order("conferido_em", { ascending: false })
    .limit(1);
  if (error) throw new Error(error.message);
  const quando = (data?.[0] as { conferido_em: string | null } | undefined)?.conferido_em;
  return quando ? new Date(quando) : null;
}

/** A configuração e a última conferência, num passo só — o que a consulta de horários precisa saber. */
export async function situacaoDaAgendaDaSecretaria(
  supabase: SupabaseClient,
  organizationId: string,
  agora: Date,
): Promise<{ estado: EstadoDaAgenda; config: ConfigDaSecretaria }> {
  const { data, error } = await supabase
    .from("organizations")
    .select("settings")
    .eq("id", organizationId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  const config = lerConfigDaSecretaria((data as { settings?: unknown } | null)?.settings);
  if (!config.ativa) return { estado: "sem_secretaria", config };
  const ultimaConferidaEm = await ultimaConferidaDaOrg(supabase, organizationId);
  return { estado: decidirAtualidade({ config, ultimaConferidaEm, agora }), config };
}
