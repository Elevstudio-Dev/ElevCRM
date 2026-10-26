/**
 * O MODELO DE MENSAGEM QUE UM TIPO DE ATENDIMENTO USA PARA O LEMBRETE.
 *
 * Três perguntas, e as três têm a mesma resposta em dois lugares — a tela que escolhe o
 * modelo e o cron que o envia:
 *
 *   1. dentre as variantes de idioma com esse nome, qual vale? (`escolherLinha`)
 *   2. ela serve para o lembrete? (`avaliarModelo`)
 *   3. o nome que a pessoa salvou ainda serve? (`conferirModeloEscolhido`, na hora de salvar)
 *
 * Uma só função para a escolha da linha evita o desencontro clássico: a tela aprovar o
 * `pt` e o cron enviar o `pt_BR` (que são modelos DISTINTOS na Meta, com corpos e
 * aprovações próprios).
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { isStatusSendable } from "@/lib/channels/meta/template-binding";
import { deriveTemplateContract } from "@/lib/channels/meta/template-contract";

import { problemasDoModelo } from "./valores";

export interface LinhaDeModelo {
  name: string;
  language: string;
  status: string;
  components: unknown;
  parameter_format: string | null;
}

export type AvaliacaoDoModelo =
  | { serve: true }
  | { serve: false; problema: string };

/** Entre as variantes do mesmo nome: aprovada primeiro; entre aprovadas, `pt_BR` antes do resto. */
export function escolherLinha<T extends { language: string; status: string }>(
  linhas: readonly T[],
): T | null {
  const ordenadas = [...linhas].sort(
    (a, b) =>
      Number(isStatusSendable(b.status)) - Number(isStatusSendable(a.status)) ||
      Number(b.language === "pt_BR") - Number(a.language === "pt_BR"),
  );
  return ordenadas[0] ?? null;
}

export function avaliarModelo(l: LinhaDeModelo): AvaliacaoDoModelo {
  if (!isStatusSendable(l.status)) {
    return { serve: false, problema: `ainda não está aprovado (situação: ${l.status})` };
  }
  const contrato = deriveTemplateContract({
    name: l.name,
    language: l.language,
    ...(l.parameter_format ? { parameter_format: l.parameter_format } : {}),
    components: l.components as never,
  });
  const problemas = problemasDoModelo(contrato);
  if (problemas.length === 0) return { serve: true };

  const slots = problemas.map((p) => `{{${p.slot}}}`).join(", ");
  return {
    serve: false,
    problema:
      `usa ${slots}, que o lembrete não sabe preencher ` +
      `(só nome, data, hora, servico, profissional, local e clinica — ou, em modelo posicional, ` +
      `{{1}} a {{6}} nessa ordem — e só no corpo)`,
  };
}

export interface ModeloParaEscolher {
  nome: string;
  idioma: string;
  serve: boolean;
  problema?: string;
}

/** Os modelos da organização, um por nome, já avaliados — o que a tela oferece. */
export async function modelosParaEscolher(
  supabase: SupabaseClient,
  organizationId: string,
): Promise<ModeloParaEscolher[]> {
  const { data } = await supabase
    .from("meta_templates")
    .select("name, language, status, components, parameter_format")
    .eq("organization_id", organizationId);
  const linhas = (data ?? []) as LinhaDeModelo[];

  const porNome = new Map<string, LinhaDeModelo[]>();
  for (const l of linhas) porNome.set(l.name, [...(porNome.get(l.name) ?? []), l]);

  return [...porNome.entries()]
    .map(([nome, variantes]) => {
      const escolhida = escolherLinha(variantes);
      if (!escolhida) return null;
      const a = avaliarModelo(escolhida);
      return {
        nome,
        idioma: escolhida.language,
        serve: a.serve,
        ...(a.serve ? {} : { problema: a.problema }),
      } satisfies ModeloParaEscolher;
    })
    .filter((m): m is ModeloParaEscolher => m !== null)
    .sort((a, b) => a.nome.localeCompare(b.nome, "pt-BR"));
}

/** Na hora de SALVAR o tipo: o nome escolhido existe, está aprovado e o lembrete sabe preenchê-lo? */
export async function conferirModeloEscolhido(
  supabase: SupabaseClient,
  organizationId: string,
  nome: string,
): Promise<{ ok: true } | { ok: false; mensagem: string }> {
  const { data, error } = await supabase
    .from("meta_templates")
    .select("name, language, status, components, parameter_format")
    .eq("organization_id", organizationId)
    .eq("name", nome);
  if (error) return { ok: false, mensagem: "Não consegui conferir o modelo agora. Tente de novo." };

  const escolhida = escolherLinha((data ?? []) as LinhaDeModelo[]);
  if (!escolhida) {
    return {
      ok: false,
      mensagem:
        `O modelo «${nome}» não existe nesta organização. Sincronize os modelos em ` +
        `Conexões → Oficial → Templates e escolha de novo.`,
    };
  }
  const a = avaliarModelo(escolhida);
  return a.serve
    ? { ok: true }
    : { ok: false, mensagem: `O modelo «${nome}» não serve para o lembrete: ${a.problema}.` };
}
