/**
 * O CICLO DE VIDA DE UM RELATO — registrar, conferir (e aplicar) ou descartar.
 *
 *   lido ──(a secretaria diz "sim")──▶ conferido   (a agenda daqui passa a refletir o relato)
 *   lido ──(ela corrige)────────────▶ corrigido   (o relato errado fica na trilha; um novo nasce)
 *   lido ──(ninguém confirmou)──────▶ descartado
 *
 * Um relato só mexe na agenda ao ser CONFERIDO. Antes disso é só uma leitura da IA guardada para auditoria: se ela
 * entendeu errado e a secretaria corrigiu, nada errado chegou a valer.
 *
 * Cliente de SERVIÇO, sempre filtrando por `organization_id` (a secretaria não é usuária do CRM).
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { lerConfigDaSecretaria } from "./config";
import { aplicarRelato, type ResultadoDaAplicacao } from "./aplicar";
import { relatoLidoSchema, type RelatoLido } from "./relato";

export const FUSO_PADRAO = "America/Sao_Paulo";

function falhou(onde: string, erro: { message: string }): never {
  throw new Error(`${onde}: ${erro.message}`);
}

/** Guarda o que a IA entendeu. A MESMA mensagem não vira dois relatos: a segunda chamada devolve o id que já existe. */
export async function registrarRelato(
  admin: SupabaseClient,
  args: {
    organizationId: string;
    /** A secretaria que mandou. */
    contactId: string;
    /** A mensagem recebida que originou o relato (idempotência). */
    messageId: string | null;
    /** O texto bruto, como ela escreveu. */
    texto: string;
    lido: RelatoLido;
  },
): Promise<{ id: string; duplicado: boolean }> {
  const { organizationId, contactId, messageId, texto, lido } = args;
  const { data, error } = await admin
    .from("agenda_relatos")
    .insert({
      organization_id: organizationId,
      contact_id: contactId,
      message_id: messageId,
      texto,
      lido,
      janela_de: lido.janela.de,
      janela_ate: lido.janela.ate,
      estado: "lido",
    })
    .select("id")
    .single();

  if (!error && data) return { id: (data as { id: string }).id, duplicado: false };

  if (error?.code === "23505" && messageId !== null) {
    const { data: existente, error: erroLeitura } = await admin
      .from("agenda_relatos")
      .select("id")
      .eq("organization_id", organizationId)
      .eq("message_id", messageId)
      .maybeSingle();
    if (erroLeitura) falhou("ler o relato já registrado", erroLeitura);
    if (existente) return { id: (existente as { id: string }).id, duplicado: true };
  }
  return falhou("registrar o relato", error ?? { message: "sem resposta" });
}

export interface ResultadoDaConferencia extends ResultadoDaAplicacao {
  relatoId: string;
  /** O relato JÁ estava conferido: nada foi regravado. */
  jaConferido: boolean;
}

const SEM_MUDANCA: ResultadoDaAplicacao = {
  criados: 0,
  mantidos: 0,
  cancelados: 0,
  diasFechados: 0,
  diasReabertos: 0,
  conflitos: [],
};

/**
 * A secretaria disse "sim": aplica o relato na agenda e só DEPOIS o marca como conferido. Se a aplicação falhar no
 * meio, o relato continua `lido` e rodar de novo é seguro (o plano é recalculado do que já está gravado).
 */
export async function conferirEAplicarRelato(
  admin: SupabaseClient,
  args: {
    organizationId: string;
    relatoId: string;
    agora: Date;
    /**
     * Quando ELA respondeu "sim". O carimbo `conferido_em` é o que decide se a IA de vendas pode oferecer horário
     * (`atualidade.ts`: 6 h para hoje, 24 h para os próximos dias) — e a agenda é tão fresca quanto a resposta dela,
     * não quanto a hora em que o job rodou. Um "sim" processado 20 h depois (worker parado, reprocessamento) não pode
     * fazer uma agenda velha parecer "conferida agora". Ausente = `agora` (o comportamento de antes).
     */
    respondeuEm?: Date | null;
  },
): Promise<ResultadoDaConferencia> {
  const { organizationId, relatoId, agora } = args;
  // Nunca no futuro e nunca depois da resposta.
  const conferidoEm =
    args.respondeuEm != null && args.respondeuEm.getTime() < agora.getTime() ? args.respondeuEm : agora;

  const { data: linha, error: erroRelato } = await admin
    .from("agenda_relatos")
    .select("id, estado, lido")
    .eq("organization_id", organizationId)
    .eq("id", relatoId)
    .maybeSingle();
  if (erroRelato) falhou("ler o relato", erroRelato);
  if (!linha) throw new Error("relato_nao_encontrado");
  const relatoRow = linha as { id: string; estado: string; lido: unknown };

  if (relatoRow.estado === "descartado" || relatoRow.estado === "corrigido") {
    throw new Error(`relato_${relatoRow.estado}`);
  }
  if (relatoRow.estado === "conferido") return { relatoId, jaConferido: true, ...SEM_MUDANCA };

  const lido = relatoLidoSchema.safeParse(relatoRow.lido);
  if (!lido.success) throw new Error("relato_ilegivel");

  const { data: org, error: erroOrg } = await admin
    .from("organizations")
    .select("timezone, settings")
    .eq("id", organizationId)
    .maybeSingle();
  if (erroOrg) falhou("ler a organização", erroOrg);
  const orgRow = org as { timezone?: string | null; settings?: unknown } | null;
  const config = lerConfigDaSecretaria(orgRow?.settings);
  if (!config.dono_da_agenda_user_id) throw new Error("dono_da_agenda_nao_definido");

  // O fuso é o da JORNADA do dono (é nele que os horários livres são calculados); sem ele, o da organização.
  const { data: disp, error: erroDisp } = await admin
    .from("attendant_availability")
    .select("schedule")
    .eq("organization_id", organizationId)
    .eq("user_id", config.dono_da_agenda_user_id)
    .maybeSingle();
  if (erroDisp) falhou("ler a jornada do dono da agenda", erroDisp);
  const fusoDaJornada = (disp as { schedule?: { timezone?: unknown } } | null)?.schedule?.timezone;
  const fuso =
    typeof fusoDaJornada === "string" && fusoDaJornada.trim() !== ""
      ? fusoDaJornada
      : (orgRow?.timezone ?? FUSO_PADRAO);

  const aplicado = await aplicarRelato(admin, {
    organizationId,
    relatoId,
    donoUserId: config.dono_da_agenda_user_id,
    relato: lido.data,
    fuso,
    duracaoMin: config.duracao_min,
    agora,
  });

  const { error: erroMarca } = await admin
    .from("agenda_relatos")
    .update({ estado: "conferido", conferido_em: conferidoEm.toISOString() })
    .eq("organization_id", organizationId)
    .eq("id", relatoId)
    .in("estado", ["lido"]);
  if (erroMarca) falhou("marcar o relato como conferido", erroMarca);

  return { relatoId, jaConferido: false, ...aplicado };
}

/** A secretaria corrigiu: o relato errado fica na trilha, marcado, e nada dele chegou a valer. */
export async function marcarRelatoCorrigido(
  admin: SupabaseClient,
  args: { organizationId: string; relatoId: string },
): Promise<void> {
  const { error } = await admin
    .from("agenda_relatos")
    .update({ estado: "corrigido" })
    .eq("organization_id", args.organizationId)
    .eq("id", args.relatoId)
    .in("estado", ["lido"]);
  if (error) falhou("marcar o relato como corrigido", error);
}

/** Ninguém confirmou e a conversa seguiu: o relato some da fila, mas fica guardado. */
export async function descartarRelato(
  admin: SupabaseClient,
  args: { organizationId: string; relatoId: string },
): Promise<void> {
  const { error } = await admin
    .from("agenda_relatos")
    .update({ estado: "descartado" })
    .eq("organization_id", args.organizationId)
    .eq("id", args.relatoId)
    .in("estado", ["lido"]);
  if (error) falhou("descartar o relato", error);
}
