/**
 * MARCAR UM CONTATO COMO "FORA DO FUNIL" — a regra, sem HTTP.
 *
 * Equipe da clínica, prestador de serviço, parceiro: gente que escreve no WhatsApp mas não é cliente. Marcar o
 * contato (1) tira a IA da conversa dele (`decidirElegibilidade`), (2) impede que um negócio nasça para ele
 * (`createLeadHandler`, `garantirLeadDaConversa`) e (3) esconde os negócios que ele já tinha — pelo espelho
 * `crm_leads.fora_do_funil`, que o BANCO mantém (migration 0221). Desmarcar desfaz tudo, inclusive devolvendo os
 * negócios inteiros: nada é apagado.
 *
 * Duas funções, e só duas, para a tela e a API falarem a mesma coisa: `previaDoMarcador` diz o que MUDARIA (o
 * diálogo mostra antes de confirmar) e `aplicarMarcador` muda. Ambas só enxergam a organização informada.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import type { PreviaDoMarcador } from "@/lib/schemas/fora-do-funil";

/** Acima disto a contagem é um piso (o PostgREST corta em 1.000 linhas). */
const LIMITE_DE_LINHAS = 1000;

interface LinhaDoContato {
  id: string;
  fora_do_funil_em: string | null;
}
interface LinhaDoNegocio {
  status: string;
  value_cents: number | null;
  currency: string | null;
}

/** Só os contatos pedidos que EXISTEM nesta organização — id de outra organização nunca entra. */
async function contatosDaOrganizacao(
  supabase: SupabaseClient,
  organizationId: string,
  contactIds: string[],
): Promise<LinhaDoContato[]> {
  const { data, error } = await supabase
    .from("contacts")
    .select("id, fora_do_funil_em")
    .eq("organization_id", organizationId)
    .in("id", contactIds);
  if (error) throw new Error(error.message);
  return (data ?? []) as LinhaDoContato[];
}

/** Os que MUDARIAM de estado: ao marcar, os que ainda não estão; ao desmarcar, os que estão. */
function quemMuda(contatos: LinhaDoContato[], marcar: boolean): LinhaDoContato[] {
  return contatos.filter((c) => (c.fora_do_funil_em === null) === marcar);
}

export async function previaDoMarcador(
  supabase: SupabaseClient,
  organizationId: string,
  contactIds: string[],
  marcar: boolean,
): Promise<PreviaDoMarcador> {
  const mudam = quemMuda(await contatosDaOrganizacao(supabase, organizationId, contactIds), marcar);
  const previa: PreviaDoMarcador = {
    contatos: mudam.length,
    negocios: { abertos: 0, ganhos: 0, perdidos: 0, valor_ganho_cents: 0 },
    aproximado: false,
  };
  if (mudam.length === 0) return previa;

  // Ao marcar contam os negócios que ainda aparecem; ao desmarcar, os que estão escondidos e voltariam.
  const { data, error } = await supabase
    .from("crm_leads")
    .select("status, value_cents, currency")
    .eq("organization_id", organizationId)
    .in("contact_id", mudam.map((c) => c.id))
    .eq("fora_do_funil", !marcar)
    .limit(LIMITE_DE_LINHAS + 1);
  if (error) throw new Error(error.message);

  const linhas = (data ?? []) as LinhaDoNegocio[];
  previa.aproximado = linhas.length > LIMITE_DE_LINHAS;
  for (const n of linhas.slice(0, LIMITE_DE_LINHAS)) {
    if (n.status === "open") previa.negocios.abertos += 1;
    else if (n.status === "lost") previa.negocios.perdidos += 1;
    else if (n.status === "won") {
      previa.negocios.ganhos += 1;
      // Só real: somar dólar em centavos de real mentiria no número que o dono confere.
      if ((n.currency ?? "BRL") === "BRL") previa.negocios.valor_ganho_cents += Number(n.value_cents ?? 0);
    }
  }
  return previa;
}

export interface ResultadoDoMarcador {
  /** Ids que de fato mudaram de estado (já marcados, ao marcar, não contam). */
  alterados: string[];
  /** O que o marcador escondeu ou devolveu, medido ANTES de mudar. */
  previa: PreviaDoMarcador;
}

export async function aplicarMarcador(
  supabase: SupabaseClient,
  args: {
    organizationId: string;
    userId: string;
    contactIds: string[];
    marcar: boolean;
    /** `undefined`: não mexe no tipo de quem já estava marcado. `null`: sem tipo. */
    tipoId?: string | null;
  },
): Promise<ResultadoDoMarcador> {
  const { organizationId, userId, contactIds, marcar, tipoId } = args;
  const existentes = await contatosDaOrganizacao(supabase, organizationId, contactIds);
  const previa = await previaDoMarcador(supabase, organizationId, contactIds, marcar);
  const mudam = quemMuda(existentes, marcar);

  if (mudam.length > 0) {
    const patch = marcar
      ? { fora_do_funil_em: new Date().toISOString(), fora_do_funil_por: userId, fora_do_funil_tipo_id: tipoId ?? null }
      : { fora_do_funil_em: null, fora_do_funil_por: null, fora_do_funil_tipo_id: null };
    const { error } = await supabase
      .from("contacts")
      .update(patch)
      .eq("organization_id", organizationId)
      .in("id", mudam.map((c) => c.id));
    if (error) throw new Error(error.message);
  }

  // Quem JÁ estava marcado e vem com um tipo novo: troca só o tipo (a data e quem marcou ficam).
  if (marcar && tipoId !== undefined) {
    const jaMarcados = existentes.filter((c) => c.fora_do_funil_em !== null).map((c) => c.id);
    if (jaMarcados.length > 0) {
      const { error } = await supabase
        .from("contacts")
        .update({ fora_do_funil_tipo_id: tipoId })
        .eq("organization_id", organizationId)
        .in("id", jaMarcados);
      if (error) throw new Error(error.message);
    }
  }

  return { alterados: mudam.map((c) => c.id), previa };
}
