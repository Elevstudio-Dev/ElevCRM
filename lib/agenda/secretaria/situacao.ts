/**
 * A SITUAÇÃO DA SECRETARIA para a tela de configuração: o que está ligado e QUEM é a secretaria hoje.
 *
 * Lida pelo client de SESSÃO (a RLS vale): quem chama já passou pelo gate de gerente. A pergunta que a tela precisa
 * responder além da configuração é "a IA consegue falar com ela?" — o que depende de a secretaria já ter uma
 * conversa com o número da clínica (a IA não inicia conversa com quem nunca falou com o número).
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { lerConfigDaSecretaria, type ConfigDaSecretaria } from "./config";

export interface SecretariaDaTela {
  id: string;
  nome: string | null;
  /** Já existe uma conversa individual com ela? Sem isso a IA não tem por onde perguntar. */
  tem_conversa: boolean;
}

export interface SituacaoDaSecretaria {
  config: Pick<ConfigDaSecretaria, "ativa" | "dono_da_agenda_user_id" | "duracao_min" | "perguntas" | "dias">;
  secretarias: SecretariaDaTela[];
}

/** Quantas secretarias a tela lista. São poucas por organização; o teto protege uma base mal preenchida. */
const LIMITE_DE_SECRETARIAS = 20;

export async function lerSituacaoDaSecretaria(supabase: SupabaseClient, organizationId: string): Promise<SituacaoDaSecretaria> {
  const { data: orgRow, error } = await supabase.from("organizations").select("settings").eq("id", organizationId).maybeSingle();
  if (error) throw new Error(error.message);
  const c = lerConfigDaSecretaria((orgRow as { settings?: unknown } | null)?.settings);

  const { data: contatos, error: eContatos } = await supabase
    .from("contacts")
    .select("id, display_name")
    .eq("organization_id", organizationId)
    .eq("papel_interno", "secretaria")
    .limit(LIMITE_DE_SECRETARIAS);
  if (eContatos) throw new Error(eContatos.message);
  const lista = (contatos ?? []) as Array<{ id: string; display_name: string | null }>;

  let comConversa = new Set<string>();
  if (lista.length > 0) {
    const { data: conversas, error: eConv } = await supabase
      .from("conversations")
      .select("contact_id")
      .eq("organization_id", organizationId)
      .eq("is_group", false)
      .in(
        "contact_id",
        lista.map((l) => l.id),
      );
    if (eConv) throw new Error(eConv.message);
    comConversa = new Set(((conversas ?? []) as Array<{ contact_id: string }>).map((r) => r.contact_id));
  }

  return {
    config: {
      ativa: c.ativa,
      dono_da_agenda_user_id: c.dono_da_agenda_user_id,
      duracao_min: c.duracao_min,
      perguntas: c.perguntas,
      dias: c.dias,
    },
    secretarias: lista.map((l) => ({ id: l.id, nome: l.display_name, tem_conversa: comConversa.has(l.id) })),
  };
}
