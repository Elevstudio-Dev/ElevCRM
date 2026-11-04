/**
 * OS TIQUES DE UMA MENSAGEM ENVIADA A UM GRUPO — como o WhatsApp os mostra.
 *
 * ## O que faltava
 *
 * Em conversa 1:1 o WAHA manda `message.ack` (1 → 2 → 3) e o tique anda. Em GRUPO o NOWEB não manda o recibo
 * por esse evento: ele o manda em `message.ack.group`, um evento por participante — e o CRM nem o assinava.
 * Medido na produção (14 dias, `webhook_events_log`): dos acks de grupo que chegaram, 13 de 13 eram `-1`; nenhum
 * recibo de entrega ou leitura. Por isso a mensagem ficava num tique só mesmo quando o grupo já tinha lido.
 *
 * ## Como o WAHA monta o evento (lido no código do WAHA 2026.7.2, NOWEB)
 *
 * - `ack`: 1 quando a pessoa RECEBEU (`receiptTimestamp`), 3 quando LEU, 4 quando OUVIU/ASSISTIU. Em grupo o "1"
 *   é entrega àquela pessoa — não "servidor recebeu", que é o que 1 quer dizer no 1:1.
 * - `id`: `{fromMe}_{grupo}_{idDaMensagem}_{participante}`, mas o participante do `id` é a NOSSA conta quando a
 *   mensagem é nossa; quem recebeu ou leu de verdade vem em `_data.receipt.userJid`.
 *
 * ## A regra (a do WhatsApp, onde o WAHA deixa)
 *
 *   ✓✓ cinza (entregue)  — alguém do grupo recebeu;
 *   ✓✓ azul  (lida)      — TODOS os outros participantes leram.
 *
 * "Entregue a todos" não é calculável: o WAHA descarta eventos repetidos em 60 s usando uma chave que, nas
 * nossas mensagens, é a mesma para todos os participantes — vários recibos iguais no mesmo minuto chegam como
 * um só. A leitura quase nunca é simultânea, então "leram todos" fecha. Se a lista de participantes não puder
 * ser lida, a mensagem NUNCA passa a lida (fica entregue): errar para baixo é mostrar menos, não mentir.
 *
 * ## Onde se guarda quem já recebeu/leu
 *
 * Em `messages.metadata.recibos_de_grupo` (`{ entregues: [...], lidos: [...] }`, endereços do próprio WhatsApp),
 * gravado com compare-and-set em `updated_at`: dois recibos chegando juntos não pisam um no outro.
 */
import { logger } from "@/lib/logger";
import type { createAdminClient } from "@/lib/supabase/admin";
import { decidirAck } from "@/lib/waha/ack";
import type { WahaPayload } from "@/lib/waha/envelope";

type Admin = ReturnType<typeof createAdminClient>;

export interface IdDoAck {
  chatId: string | null;
  mensagemId: string;
  participante: string | null;
}

/**
 * `{fromMe}_{chat}_{mensagem}[_{participante}]`. Chat, mensagem e participante não contêm `_`, então cada
 * parte é uma fatia. Um id sem `_` é o id cru do envio.
 */
export function lerIdDoAck(id: string): IdDoAck {
  const partes = id.split("_");
  if (partes.length < 3) return { chatId: null, mensagemId: id, participante: null };
  return { chatId: partes[1] ?? null, mensagemId: partes[2] ?? id, participante: partes[3] ?? null };
}

export type TipoDeRecibo = "entregue" | "lido";

/** Em grupo: 1 e 2 = chegou àquela pessoa; 3 e 4 = ela leu/ouviu. Erro (-1) e pendente (0) não são recibo. */
export function tipoDoRecibo(ack: number | null | undefined): TipoDeRecibo | null {
  if (ack === 1 || ack === 2) return "entregue";
  if (ack === 3 || ack === 4) return "lido";
  return null;
}

/** Quem recebeu/leu, como o WAHA diz: `_data.receipt.userJid`. */
export function quemMandouORecibo(p: WahaPayload): string | null {
  const dados = p._data as { receipt?: { userJid?: unknown } } | null | undefined;
  const jid = dados?.receipt?.userJid;
  return typeof jid === "string" && jid !== "" ? jid : null;
}

export interface RecibosDeGrupo {
  entregues: string[];
  lidos: string[];
}

function listaDeTextos(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

export function lerRecibos(metadata: unknown): RecibosDeGrupo {
  const bruto =
    metadata && typeof metadata === "object" ? (metadata as { recibos_de_grupo?: unknown }).recibos_de_grupo : null;
  const r = bruto && typeof bruto === "object" ? (bruto as { entregues?: unknown; lidos?: unknown }) : {};
  return { entregues: listaDeTextos(r.entregues), lidos: listaDeTextos(r.lidos) };
}

export function somarRecibo(r: RecibosDeGrupo, jid: string, tipo: TipoDeRecibo): RecibosDeGrupo {
  const campo = tipo === "lido" ? "lidos" : "entregues";
  if (r[campo].includes(jid)) return r;
  return { ...r, [campo]: [...r[campo], jid] };
}

/**
 * O que os recibos dizem. `outros` = quantos participantes além de nós (`null` = não se sabe).
 * Quem leu também recebeu.
 */
export function statusDosRecibos(r: RecibosDeGrupo, outros: number | null): "delivered" | "read" | null {
  const leitores = new Set(r.lidos).size;
  if (outros !== null && outros >= 1 && leitores >= outros) return "read";
  if (new Set([...r.entregues, ...r.lidos]).size >= 1) return "delivered";
  return null;
}

// ─── quantos participantes o grupo tem ───────────────────────────────────────

export interface CanalDeParticipantes {
  getGroupParticipants(session: string, groupId: string): Promise<Array<{ id: string }>>;
}

const TTL_DA_LISTA_MS = 10 * 60_000;
const TTL_DA_FALHA_MS = 60_000;
const cacheDeGrupo = new Map<string, { ate: number; outros: number | null }>();

/** Só para o teste. */
export function esquecerParticipantes(): void {
  cacheDeGrupo.clear();
}

/** Quantos participantes além de nós: a lista menos nós (a conta que envia é sempre membro). `null` se não der para saber. */
export async function outrosParticipantes(d: {
  organizationId: string;
  chatId: string;
  sessionName: string | null | undefined;
  canal: CanalDeParticipantes | null;
  agora?: () => number;
}): Promise<number | null> {
  if (!d.canal || !d.sessionName) return null;
  const agora = (d.agora ?? Date.now)();
  const chave = `${d.organizationId}:${d.chatId}`;
  const guardado = cacheDeGrupo.get(chave);
  if (guardado && agora < guardado.ate) return guardado.outros;
  try {
    const lista = await d.canal.getGroupParticipants(d.sessionName, d.chatId);
    const outros = lista.length >= 2 ? lista.length - 1 : null;
    cacheDeGrupo.set(chave, { ate: agora + TTL_DA_LISTA_MS, outros });
    return outros;
  } catch (e) {
    logger.warn("waha.ack.group: não deu para ler os participantes", { detail: e instanceof Error ? e.message : String(e) });
    cacheDeGrupo.set(chave, { ate: agora + TTL_DA_FALHA_MS, outros: null });
    return null;
  }
}

// ─── aplicar um recibo a uma mensagem ────────────────────────────────────────

export interface SessaoDoRecibo {
  organization_id: string;
  waha_session_name?: string | null;
}

interface LinhaDaMensagem {
  id: string;
  direction: string | null;
  status: string | null;
  metadata: unknown;
  updated_at: string;
}

const TENTATIVAS = 3;

export type ResultadoDoRecibo = "aplicado" | "sem_efeito" | "sem_mensagem";

export async function aplicarReciboDeGrupo(
  admin: Admin,
  session: SessaoDoRecibo,
  p: WahaPayload,
  canal: CanalDeParticipantes | null,
  agora: () => number = Date.now,
): Promise<ResultadoDoRecibo> {
  if (!p.id) return "sem_efeito";
  const tipo = tipoDoRecibo(p.ack);
  if (!tipo) return "sem_efeito";

  const { chatId, mensagemId } = lerIdDoAck(p.id);
  const jid = quemMandouORecibo(p) ?? "desconhecido";
  const candidatos = mensagemId === p.id ? [p.id] : [mensagemId, p.id];
  let achou = false;

  for (let tentativa = 0; tentativa < TENTATIVAS; tentativa++) {
    const { data, error } = await admin
      .from("messages")
      .select("id, direction, status, metadata, updated_at")
      .eq("organization_id", session.organization_id)
      .in("external_id", candidatos);
    if (error) {
      logger.warn("waha.ack.group: não deu para ler a mensagem", { detail: error.message });
      return "sem_efeito";
    }
    const linhas = ((data ?? []) as LinhaDaMensagem[]).filter((l) => l.direction === "outbound");
    if (linhas.length === 0) return achou ? "aplicado" : "sem_mensagem";
    achou = true;

    let perdeuACorrida = false;
    for (const linha of linhas) {
      const antes = lerRecibos(linha.metadata);
      const recibos = somarRecibo(antes, jid, tipo);
      const mudouORecibo = recibos !== antes;

      // Só pergunta o tamanho do grupo quando alguém leu: é a única hora em que ele decide algo.
      const outros =
        recibos.lidos.length > 0 && chatId
          ? await outrosParticipantes({
              organizationId: session.organization_id,
              chatId,
              sessionName: session.waha_session_name,
              canal,
              agora,
            })
          : null;
      const novo = statusDosRecibos(recibos, outros);
      const ackEquivalente = novo === "read" ? 3 : novo === "delivered" ? 2 : null;
      const decisao =
        ackEquivalente === null
          ? ({ aplicar: false } as const)
          : decidirAck({ direction: linha.direction, status: linha.status, grupo: true }, ackEquivalente);

      if (!mudouORecibo && !decisao.aplicar) continue;

      const agoraIso = new Date(agora()).toISOString();
      const metadata = {
        ...(linha.metadata && typeof linha.metadata === "object" ? (linha.metadata as Record<string, unknown>) : {}),
        recibos_de_grupo: recibos,
      };
      const update: Record<string, unknown> = { metadata, updated_at: agoraIso };
      if (decisao.aplicar) {
        update.status = decisao.status;
        update.ack = ackEquivalente;
        if (decisao.status === "delivered" || decisao.status === "read") update.delivered_at = agoraIso;
        if (decisao.status === "read") update.read_at = agoraIso;
        if (decisao.cura) {
          update.error_code = null;
          update.error_message = null;
        }
      }

      // Compare-and-set: só grava se ninguém mexeu na linha desde a leitura (outro recibo, outro ack).
      const { data: gravadas, error: erroDeGravar } = await admin
        .from("messages")
        .update(update)
        .eq("id", linha.id)
        .eq("organization_id", session.organization_id)
        .eq("updated_at", linha.updated_at)
        .select("id");
      if (erroDeGravar) {
        logger.warn("waha.ack.group: update falhou", { detail: erroDeGravar.message, message_id: linha.id });
        continue;
      }
      if (!gravadas || gravadas.length === 0) perdeuACorrida = true;
    }
    if (!perdeuACorrida) return "aplicado";
  }
  logger.warn("waha.ack.group: não consegui gravar o recibo depois de várias tentativas");
  return "sem_efeito";
}
