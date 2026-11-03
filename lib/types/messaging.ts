/**
 * Shapes canônicos das tabelas conversations e messages (Spec 03).
 * Espelha o schema do Postgres — atualizar aqui quando a migration mudar.
 */
import type { Mencao } from "@/lib/mencoes/tipos";

export interface Conversation {
  id: string;
  organization_id: string;
  contact_id: string;
  channel_session_id: string;
  channel: string;
  status: string;
  status_changed_at: string;
  assigned_to_user_id: string | null;
  /**
   * Cópia desnormalizada do nome de quem atende (migration 0202), escrita por
   * `fn_conversation_assign` no mesmo UPDATE que grava `assigned_to_user_id`.
   * `null` quando não atribuída, ou quando o backfill/lookup não alcançou —
   * ver `lib/users/com-nome-do-atendente.ts` para o fallback desse caso raro.
   */
  assigned_to_user_name: string | null;
  assignee_kind: string | null;
  assigned_at: string | null;
  /**
   * O SETOR da conversa (migration 0213). `null` até o menu de primeiro
   * contato ou a equipe decidir. Quem escreve é só `fn_conversation_set_sector`.
   */
  sector_id: string | null;
  last_inbound_at: string | null;
  last_outbound_at: string | null;
  last_message_at: string | null;
  last_message_preview: string | null;
  /**
   * O espelho da ÚLTIMA mensagem (migration 0219) — o que a linha da lista precisa
   * para dizer "Você:", trocar o literal `[audio]` por ícone e desenhar os tiques.
   * Opcionais e nuláveis: ausente é resposta em cache de antes das colunas
   * existirem; `null` é conversa sem mensagem (ou ainda sem backfill).
   */
  last_message_direction?: "inbound" | "outbound" | null;
  last_message_type?: string | null;
  last_message_status?: string | null;
  unread_count_for_assignee: number;
  is_group: boolean;
  group_chat_id: string | null;
  tags: string[];
  metadata: Record<string, unknown>;
  snooze_until: string | null;
  /**
   * Até quando o atendimento automático está desligado nesta conversa
   * (`'infinity'` depois de passar para uma pessoa). A tela precisa disto para
   * saber SE existe algo a devolver — sem o campo, o botão de retomar não teria
   * como aparecer só quando faz sentido, e a rota ficaria sem porta.
   */
  bot_silenced_until: string | null;
  /**
   * Campo CALCULADO pelo banco (migration 0203) — não é coluna, e por isso não vem
   * em `select=*`: quem o quiser tem de pedi-lo por nome. Opcional porque a
   * resposta de uma versão anterior, ainda em cache do react-query, não o tem.
   */
  comando_da_conversa?: string | null;
  last_handoff_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface Message {
  id: string;
  organization_id: string;
  conversation_id: string;
  channel_session_id: string;
  contact_id: string;
  external_id: string | null;
  type: string;
  direction: "inbound" | "outbound";
  status: string;
  ack: number | null;
  error_code: string | null;
  error_message: string | null;
  body: string | null;
  media_url: string | null;
  media_mime: string | null;
  media_size_bytes: number | null;
  media_storage_path: string | null;
  /**
   * O texto que o sistema tirou da mídia (a fala de um áudio, a descrição de
   * uma imagem) e o estado dessa derivação: `ready` | `failed` | ausente. Vem
   * da listagem da conversa; opcional porque o envio e as respostas otimistas
   * não o trazem.
   */
  media_derived_text?: string | null;
  media_derived_status?: string | null;
  sent_via: "user" | "ai" | "system";
  sent_by_user_id: string | null;
  sent_at: string;
  delivered_at: string | null;
  read_at: string | null;
  metadata: Record<string, unknown>;
  /**
   * Quando o AUTOR editou no aplicativo (migration 0143). `body` já é a versão
   * nova; este campo existe para a tela poder DIZER que houve edição — ler um
   * combinado sem saber que ele mudou é como o erro começa.
   */
  edited_at: string | null;
  /** Quando o AUTOR apagou para todos. A linha fica; o texto não é mostrado. */
  revoked_at: string | null;
  /** A mensagem que esta responde (citação). `null` = envio solto. */
  reply_to_message_id: string | null;
  created_at: string;
}

/** Nota interna de conversa (Onda 5.2) — nunca vai ao cliente, tabela separada de messages. */
export interface Note {
  id: string;
  conversation_id: string;
  body: string;
  /** Quem foi marcado com @ (migration 0222). Nota antiga: `[]`. */
  mentions?: Mencao[];
  created_by_user_id: string | null;
  created_by_name: string | null;
  created_at: string;
}

/**
 * O que a mensagem grava quando o WAHA devolve ack -1 (ERROR).
 *
 * Código PRÓPRIO, e não `send_timeout`: o `send_timeout` é o carimbo do cron
 * `recover-stuck-messages` ("passaram 5 min e ninguém confirmou") e diz que o
 * silêncio foi nosso. Aqui não houve silêncio — o WhatsApp respondeu, e a
 * resposta foi erro. Dar o mesmo nome aos dois esconde de quem investiga qual
 * dos dois aconteceu (foi exatamente o que escondeu o defeito em grupos).
 *
 * O texto descreve o que o CRM SABE (o WhatsApp não confirmou o envio) e não
 * afirma por quê: o motivo do -1 não vem no evento.
 */
export const ACK_ERRO_DO_CANAL = {
  code: "waha_ack_error",
  message:
    "O WhatsApp não confirmou este envio: devolveu erro para a mensagem. Confira no celular se o cliente recebeu e, se não, envie de novo.",
} as const;

/**
 * Mapeia o ack do WAHA para o status canônico em messages.status.
 *
 *   -1 ERROR   → failed   (o WhatsApp recusou; NÃO é "enviando")
 *    0 PENDING → sending
 *    1 SERVER  → sent
 *    2 DEVICE  → delivered
 *    3 READ    → read
 *    4 PLAYED  → read      (áudio/vídeo ouvido: mais que lido)
 *
 * Qualquer valor negativo é falha. Antes, o -1 caía no último `return` e virava
 * "sending": o relógio rodava até o cron inventar um `send_timeout`.
 */
export function ackToStatus(ack: number | null | undefined): Message["status"] {
  if (ack == null) return "sent";
  if (ack < 0) return "failed";
  if (ack >= 3) return "read";
  if (ack >= 2) return "delivered";
  if (ack >= 1) return "sent";
  return "sending";
}
