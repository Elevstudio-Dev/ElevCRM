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
  id: string;
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
  /**
   * Cliente que enxerga TODOS os negócios da organização (o `admin`, sempre filtrado por organização). O gatilho
   * do banco esconde os negócios todos, e não só os que o atendente vê (a RLS de `crm_leads` mostra ao atendente os
   * dele e os sem dono): contar pelo cliente da sessão faria o diálogo prometer "2 saem" quando saem 5. Sem ele,
   * conta pelo `supabase` mesmo (os testes e quem já vê tudo).
   */
  contador: SupabaseClient = supabase,
): Promise<PreviaDoMarcador> {
  const mudam = quemMuda(await contatosDaOrganizacao(supabase, organizationId, contactIds), marcar);
  const previa: PreviaDoMarcador = {
    contatos: mudam.length,
    negocios: { abertos: 0, ganhos: 0, perdidos: 0, valor_ganho_cents: 0 },
    aproximado: false,
    valor_parcial: false,
  };
  if (mudam.length === 0) return previa;

  // Ao marcar contam os negócios que ainda aparecem; ao desmarcar, os que estão escondidos e voltariam.
  const consultar = (cliente: SupabaseClient, colunas: string) =>
    cliente
      .from("crm_leads")
      .select(colunas)
      .eq("organization_id", organizationId)
      .in("contact_id", mudam.map((c) => c.id))
      .eq("fora_do_funil", !marcar)
      .limit(LIMITE_DE_LINHAS + 1);

  const { data, error } = await consultar(contador, "id, status, value_cents, currency");
  if (error) throw new Error(error.message);
  const linhas = (data ?? []) as unknown as LinhaDoNegocio[];
  previa.aproximado = linhas.length > LIMITE_DE_LINHAS;
  const contadas = linhas.slice(0, LIMITE_DE_LINHAS);

  // O VALOR das vendas só aparece se quem pediu enxerga todas elas: o atendente não lê o valor do negócio de outro dono.
  let visiveis: Set<string> | null = null;
  if (contador !== supabase) {
    const { data: meus, error: meusErr } = await consultar(supabase, "id");
    if (meusErr) throw new Error(meusErr.message);
    visiveis = new Set(((meus ?? []) as unknown as Array<{ id: string }>).map((l) => l.id));
  }

  for (const n of contadas) {
    if (n.status === "open") previa.negocios.abertos += 1;
    else if (n.status === "lost") previa.negocios.perdidos += 1;
    else if (n.status === "won") {
      previa.negocios.ganhos += 1;
      if (visiveis && !visiveis.has(n.id)) {
        previa.valor_parcial = true;
        continue;
      }
      // Só real: somar dólar em centavos de real mentiria no número que o dono confere.
      if ((n.currency ?? "BRL") === "BRL") previa.negocios.valor_ganho_cents += Number(n.value_cents ?? 0);
    }
  }
  // Valor incompleto é pior que nenhum valor: some, e a frase diz só quantas vendas.
  if (previa.valor_parcial) previa.negocios.valor_ganho_cents = 0;
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
    /** Tipo dos que PASSAM a ficar marcados. `null`/`undefined`: sem tipo — e não mexe no tipo de quem já estava marcado. */
    tipoId?: string | null;
    /** Ver `previaDoMarcador`: cliente que conta todos os negócios da organização. */
    contador?: SupabaseClient;
  },
): Promise<ResultadoDoMarcador> {
  const { organizationId, userId, contactIds, marcar, tipoId, contador } = args;
  const existentes = await contatosDaOrganizacao(supabase, organizationId, contactIds);
  const previa = await previaDoMarcador(supabase, organizationId, contactIds, marcar, contador);
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

  // Quem JÁ estava marcado e vem com um tipo novo: troca só o tipo (a data e quem marcou ficam). Sem tipo escolhido
  // (seleção mista), quem já tinha um tipo o mantém — marcar de novo não apaga a classificação.
  if (marcar && typeof tipoId === "string") {
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
