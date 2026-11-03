/**
 * O GRUPO PUXA O PRÓPRIO NOME.
 *
 * ## O defeito que isto fecha
 *
 * A ingestão cria o contato de um grupo SEM nome, e isso é certo: o payload de uma mensagem de grupo
 * traz o nome de QUEM ESCREVEU (`notifyName`), não o assunto do grupo — batizar "Time comercial" de
 * "Roberto" seria pior que não batizar. O assunto só vinha de um caminho: o botão "Importar grupos do
 * WhatsApp". Quem não o apertou — e nada na tela manda apertar — via todo grupo como "Sem nome", e
 * concluía que a função não funcionava.
 *
 * ## O que acontece agora
 *
 * Ao ingerir mensagem de um grupo, se o contato dele ainda não tem nome, pergunta o assunto ao canal e
 * grava (pela mesma RPC da importação, `fn_upsert_wa_group_contact`, que NÃO sobrescreve o apelido que
 * uma pessoa tenha dado). A importação continua existindo — é o que traz os grupos parados e os
 * renomeados.
 *
 * ## A conta-gotas
 *
 * Esta consulta ao canal é limitada (o engine padrão responde `rate-overlimit` quando abusam dela), e
 * grupo ativo manda mensagem a cada segundo. Então:
 *
 *   - grupo SEM nome: pergunta no máximo uma vez a cada `INTERVALO_SEM_NOME_MS`, achando o assunto ou
 *     não — a mensagem seguinte não repete uma pergunta que acabou de falhar;
 *   - grupo COM nome: confere no banco no máximo uma vez por hora (para a mensagem seguinte nem ler
 *     o contato).
 *
 * A memória é do PROCESSO: reiniciar zera, e o custo disso é uma pergunta a mais por grupo — barato, e
 * mais simples que uma tabela de tentativas.
 *
 * ## Falha baixo
 *
 * Nada aqui pode derrubar a ingestão: a mensagem do cliente já valeu mais que o nome do grupo. Todo
 * caminho devolve um resultado em vez de lançar, e quem chama não espera esta função.
 */
import { ehIdentificadorTecnico } from "@/lib/contacts/rotulo-do-contato";
import type { createAdminClient } from "@/lib/supabase/admin";

type Admin = ReturnType<typeof createAdminClient>;

/** O que o canal precisa saber responder: o assunto de um grupo. */
export interface CanalQueSabeONomeDoGrupo {
  getGroupSubject(session: string, chatId: string): Promise<string | null>;
}

export type ResultadoDoNome =
  | "nomeado"
  | "ja_tem_nome"
  | "sem_nome_no_canal"
  | "esperando"
  | "sem_canal"
  | "erro";

export interface DepsDoNome {
  admin: Admin;
  organizationId: string;
  contactId: string;
  chatId: string;
  /** O nome da sessão NO TRANSPORTE (`channel_sessions.waha_session_name`). */
  sessionName: string | null | undefined;
  canal: CanalQueSabeONomeDoGrupo | null;
  /** Relógio injetável — o teste anda no tempo sem esperar. */
  agora?: () => number;
}

/** Grupo sem nome: de quanto em quanto tempo vale perguntar de novo. */
export const INTERVALO_SEM_NOME_MS = 10 * 60_000;
/** Grupo com nome: de quanto em quanto tempo vale reconferir o banco. */
export const INTERVALO_COM_NOME_MS = 60 * 60_000;

/** `organização:chatId` → até quando não perguntar de novo. */
const proximaTentativa = new Map<string, number>();

/** Só para o teste: esquece as tentativas. */
export function esquecerTentativasDeNome(): void {
  proximaTentativa.clear();
}

/** Tem nome de verdade? O que uma pessoa escreveu ou o assunto que o canal deu — não um id técnico. */
function temNome(linha: { name: string | null; display_name: string | null } | null): boolean {
  if (!linha) return false;
  return [linha.display_name, linha.name].some((v) => {
    const t = (v ?? "").trim();
    return t !== "" && !ehIdentificadorTecnico(t);
  });
}

export async function nomearGrupoSeFaltar(d: DepsDoNome): Promise<ResultadoDoNome> {
  if (!d.canal || !d.sessionName) return "sem_canal";

  const agora = (d.agora ?? Date.now)();
  const chave = `${d.organizationId}:${d.chatId}`;
  const ate = proximaTentativa.get(chave);
  if (ate !== undefined && agora < ate) return "esperando";

  try {
    const { data: linha } = await d.admin
      .from("contacts")
      .select("name, display_name")
      .eq("id", d.contactId)
      .eq("organization_id", d.organizationId)
      .maybeSingle();

    if (temNome(linha as { name: string | null; display_name: string | null } | null)) {
      proximaTentativa.set(chave, agora + INTERVALO_COM_NOME_MS);
      return "ja_tem_nome";
    }

    // Marca ANTES de perguntar: se o canal demorar, a mensagem seguinte do mesmo grupo não dispara uma
    // segunda pergunta enquanto a primeira ainda está no ar.
    proximaTentativa.set(chave, agora + INTERVALO_SEM_NOME_MS);

    const assunto = (await d.canal.getGroupSubject(d.sessionName, d.chatId))?.trim() ?? "";
    if (assunto === "") return "sem_nome_no_canal";

    const { error } = await d.admin.rpc("fn_upsert_wa_group_contact" as never, {
      p_org: d.organizationId,
      p_group_chat_id: d.chatId,
      p_subject: assunto,
    } as never);
    if (error) return "erro";

    // Já tem nome: a próxima conferência é a da hora, não a de dez minutos.
    proximaTentativa.set(chave, agora + INTERVALO_COM_NOME_MS);
    return "nomeado";
  } catch {
    return "erro";
  }
}
