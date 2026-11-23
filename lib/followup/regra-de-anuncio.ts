/**
 * LEAD DE ANÚNCIO NÃO RECEBE FOLLOW-UP AUTOMÁTICO ANTES DA AVALIAÇÃO.
 *
 * Decisão da clínica (23/11/2026): quem chega por anúncio já recebe a conversa da IA; cobrar esse lead todo dia
 * de forma automática estava incomodando. O follow-up desse público passa a ser agendado POR PESSOA (botão
 * "Agendar follow-up", que não passa por aqui) e o automático só começa depois que a avaliação foi feita.
 *
 * Como a regra se liga: é um parâmetro do gatilho de silêncio do fluxo (`trigger_config.params.leads_de_anuncio`),
 * não uma regra global. Fluxo sem o parâmetro se comporta como sempre — outras organizações e outros fluxos não
 * mudam. O parâmetro lista as ETAPAS do funil (pelo `slug`, que não muda quando alguém renomeia a etapa) em que
 * o lead de anúncio passa a poder entrar no automático. Para a clínica: `compareceu`, `orcamento_apresentado` e
 * `em_tratamento` — as três etapas que só existem depois de a pessoa ter sido avaliada.
 *
 * Puro: nada de banco, nada de relógio. Quem lê o banco (o adaptador do varredor) só monta o perfil.
 */
import { z } from "zod";

import { anuncioDoContato } from "@/lib/leads/anuncio-do-contato";

export const regraDeAnuncioSchema = z.strictObject({
  /** Slugs das etapas do funil em que o lead de anúncio já pode entrar no follow-up automático. */
  liberar_nas_etapas: z.array(z.string().trim().min(1).max(80)).min(1).max(20),
});
export type RegraDeAnuncio = z.infer<typeof regraDeAnuncioSchema>;

/** O que o varredor sabe sobre o contato para aplicar a regra. */
export interface PerfilDeOrigem {
  /** `contacts.source`. */
  contatoSource: string | null;
  /** `contacts.source_metadata` (traz `ad_platform` / `ad_raw` quando o clique de anúncio foi carimbado). */
  contatoMetadata: Record<string, unknown> | null;
  /** `crm_leads.source` do lead mais recente: o carimbo do lead pode existir sem o do contato. */
  leadSource: string | null;
  /** `crm_stages.slug` da etapa do lead mais recente; `null` se o contato não tem lead. */
  etapaSlug: string | null;
}

/** O contato chegou por anúncio? Vale o carimbo do contato OU o do lead. */
export function veioDeAnuncio(perfil: PerfilDeOrigem): boolean {
  if (anuncioDoContato(perfil.contatoSource, perfil.contatoMetadata) !== null) return true;
  return perfil.leadSource === "meta_ads" || perfil.leadSource === "google_ads";
}

/**
 * Este contato pode ENTRAR no follow-up automático?
 * - sem regra no fluxo: sim (comportamento de sempre);
 * - não veio de anúncio: sim;
 * - veio de anúncio: só se o lead já está em uma das etapas liberadas (avaliação feita).
 */
export function podeEntrarNoAutomatico(
  perfil: PerfilDeOrigem,
  regra: RegraDeAnuncio | null | undefined,
): boolean {
  if (!regra) return true;
  if (!veioDeAnuncio(perfil)) return true;
  return perfil.etapaSlug !== null && regra.liberar_nas_etapas.includes(perfil.etapaSlug);
}
