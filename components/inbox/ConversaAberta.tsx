"use client";
import { useEffect, useRef, useState } from "react";

import { useAuth } from "@/hooks/auth/AuthProvider";
import { useT } from "@/hooks/i18n/useT";
import type { ConversationWithContact } from "@/hooks/inbox/useConversationsRealtime";
import { useMarkAsRead } from "@/hooks/inbox/useMarkAsRead";
import { estadoDaJanela, formatarDecorrido } from "@/lib/channels/janela";
import { MAX_MENSAGENS_POR_ENCAMINHAMENTO } from "@/lib/messaging/encaminhar";
import type { Message as ConversationMensagem } from "@/lib/types/messaging";

import { BarraDeSelecao } from "./BarraDeSelecao";
import { ChatThread } from "./ChatThread";
import { Composer, type ComposerHandle } from "./Composer";
import { ConversationHeader } from "./ConversationHeader";
import { EncaminharDialog } from "./EncaminharDialog";
import { JanelaFechadaAviso } from "./JanelaFechadaAviso";
import { RetentionNotice } from "./RetentionNotice";

/**
 * A CONVERSA ABERTA — cabeçalho, mensagens, avisos e o campo de envio.
 *
 * É a coluna do meio do inbox, tirada de lá para ter DOIS lugares: o próprio
 * inbox e o painel que o funil abre ao lado do quadro. Os dois precisam do mesmo
 * comportamento, e o que não pode acontecer é cada um ter a sua cópia da regra:
 * a cópia do funil esqueceria a janela de 24h, ou o contato bloqueado, e o
 * atendente mandaria pelo funil o que o inbox o impede de mandar.
 *
 * Devolve um fragmento: quem monta decide o recipiente (a coluna do inbox, o
 * painel do funil), que precisa ser uma coluna flex de altura definida — o
 * `ChatThread` rola sozinho e o campo de envio fica colado embaixo.
 *
 * ⚠️ Monte com `key={conversation.id}`. A mensagem escolhida para responder
 * mora aqui dentro, e trocar de conversa sem remontar a levaria junto: a
 * resposta sairia citando a mensagem de OUTRO cliente — o pior desfecho desta
 * função, e invisível até acontecer com alguém.
 */
export function ConversaAberta({ conversation }: { conversation: ConversationWithContact }) {
  const t = useT();
  const { user } = useAuth();

  /**
   * A mensagem escolhida para responder "em cima".
   *
   * Mora aqui, e não no composer, porque quem ESCOLHE é a lista de mensagens e
   * quem MOSTRA é o composer — são irmãos, e o estado comum é do pai.
   */
  const [respondendo, setRespondendo] = useState<ConversationMensagem | null>(null);
  const composerRef = useRef<ComposerHandle | null>(null);

  /**
   * O MODO DE SELEÇÃO do encaminhar: `null` = desligado; ligado, o que foi marcado (por id).
   *
   * Mora aqui pelo mesmo motivo da citação: quem marca é o fio de mensagens, quem mostra a contagem é
   * a barra de baixo e quem confirma é o diálogo — três irmãos, e o estado comum é do pai. E some
   * junto com a conversa (a `key`): marcar mensagens de uma conversa e encaminhá-las "da outra" seria
   * mandar o que o cliente A disse como se fosse do cliente B.
   */
  const [selecao, setSelecao] = useState<Map<string, ConversationMensagem> | null>(null);
  /** As mensagens do diálogo, congeladas no clique em "Encaminhar" (a barra pode mudar por baixo). */
  const [paraEncaminhar, setParaEncaminhar] = useState<ConversationMensagem[] | null>(null);

  const comecarASelecionar = (m: ConversationMensagem) => {
    setRespondendo(null);
    setSelecao(new Map([[m.id, m]]));
  };
  const alternarSelecao = (m: ConversationMensagem) =>
    setSelecao((prev) => {
      if (!prev) return prev;
      const next = new Map(prev);
      if (next.has(m.id)) next.delete(m.id);
      else if (next.size < MAX_MENSAGENS_POR_ENCAMINHAMENTO) next.set(m.id, m);
      return next;
    });
  const sairDaSelecao = () => setSelecao(null);

  // Esc desiste da seleção — e só dela: com o diálogo aberto o Esc é do diálogo.
  useEffect(() => {
    if (!selecao || paraEncaminhar) return;
    const aoTeclar = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSelecao(null);
    };
    document.addEventListener("keydown", aoTeclar);
    return () => document.removeEventListener("keydown", aoTeclar);
  }, [selecao, paraEncaminhar]);

  // A leitura da conversa aberta é do upstream e fica: sem ela o contador de
  // não-lidas nunca zera para quem abre a conversa.
  useMarkAsRead(conversation.id, conversation.unread_count_for_assignee ?? 0);

  // A janela vence SOZINHA com a aba aberta. Sem este relógio, quem deixa o
  // inbox aberto a tarde inteira seguiria com o composer liberado numa conversa
  // que já venceu — e o bloqueio só apareceria no próximo recarregamento.
  const [agoraJanela, setAgoraJanela] = useState(() => new Date());
  useEffect(() => {
    const relogio = setInterval(() => setAgoraJanela(new Date()), 30_000);
    return () => clearInterval(relogio);
  }, []);

  // A janela de 24h fecha o composer, e o motivo DIZ há quanto tempo fechou.
  //
  // Antes disto o texto livre saía, o CRM marcava `failed` e o operador via um
  // `131047` — descobrindo a regra pelo erro, uma mensagem por vez. Barrar aqui
  // é o pedido explícito do dono: se não dá para enviar, que não deixe tentar.
  //
  // Reusa o `blockedReason` que já existe (contato bloqueado/anonimizado) em vez
  // de um segundo mecanismo de bloqueio: dois caminhos para desabilitar o mesmo
  // composer divergem, e o segundo esquece de cobrir o áudio ou o anexo.
  const janela = estadoDaJanela(
    conversation.channel_sessions?.provider ?? null,
    conversation.last_inbound_at ?? null,
    agoraJanela,
  );
  const motivoDaJanela =
    janela.tipo === "fechada"
      ? janela.fechadaHaMs === null
        ? t("O cliente ainda não escreveu — a janela de 24h nunca abriu. Só um modelo aprovado sai daqui.")
        : `${t("A janela de 24h fechou há")} ${formatarDecorrido(janela.fechadaHaMs)}. ${t("Só um modelo aprovado sai daqui — texto livre é recusado pela plataforma.")}`
      : null;

  const blockedReason = conversation.contacts?.is_blocked
    ? t("Contato bloqueado — envio de mensagens desabilitado.")
    : conversation.contacts?.is_anonymized
      ? t("Contato anonimizado — não é possível enviar mensagens.")
      : null;

  return (
    <>
      <ConversationHeader conversation={conversation} />
      <div className="min-h-0 flex-1 overflow-hidden">
        <ChatThread
          conversationId={conversation.id}
          onResponder={setRespondendo}
          onEncaminhar={comecarASelecionar}
          selecao={
            selecao
              ? {
                  ids: new Set(selecao.keys()),
                  aoAlternar: alternarSelecao,
                  maximo: MAX_MENSAGENS_POR_ENCAMINHAMENTO,
                }
              : undefined
          }
        />
      </div>
      <RetentionNotice conversationId={conversation.id} />
      {motivoDaJanela && (
        <JanelaFechadaAviso
          conversationId={conversation.id}
          provider={conversation.channel_sessions?.provider ?? null}
          motivo={motivoDaJanela}
        />
      )}
      {/* Durante a seleção o campo de envio é ESCONDIDO, não desmontado: o rascunho digitado
          sobrevive a um "encaminhar" começado no meio de uma resposta. */}
      <div className={selecao ? "hidden" : undefined}>
        <Composer
          ref={composerRef}
          conversationId={conversation.id}
          blockedReason={blockedReason}
          janelaFechada={motivoDaJanela}
          disabled={conversation.status === "closed"}
          contactName={conversation.contacts?.name ?? null}
          attendantName={user.full_name}
          respondendo={respondendo}
          onCancelarResposta={() => setRespondendo(null)}
          currentContactId={conversation.contact_id}
        />
      </div>
      {selecao && (
        <BarraDeSelecao
          quantidade={selecao.size}
          onCancelar={sairDaSelecao}
          onEncaminhar={() =>
            setParaEncaminhar(
              [...selecao.values()].sort(
                (a, b) => a.sent_at.localeCompare(b.sent_at) || a.id.localeCompare(b.id),
              ),
            )
          }
        />
      )}
      {paraEncaminhar && (
        <EncaminharDialog
          mensagens={paraEncaminhar}
          origem={conversation}
          onFechar={() => setParaEncaminhar(null)}
          // Saiu ao menos uma: sai do modo de seleção, mas o diálogo FICA — é nele que se lê o resultado.
          onConcluido={sairDaSelecao}
        />
      )}
    </>
  );
}
