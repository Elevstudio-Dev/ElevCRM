"use client";

import { useLocaleDeData } from "@/hooks/i18n/useLocaleDeData";

import type { Locale } from "date-fns";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useT } from "@/hooks/i18n/useT";
import { format, isToday, isYesterday } from "date-fns";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { MessageBubble } from "./MessageBubble";
import { NoteCard } from "./NoteCard";
import { EventoDeResponsavel } from "./EventoDeResponsavel";
import {
  useConversationAssignmentEvents,
  type AssignmentEvent,
} from "@/hooks/inbox/useConversationAssignmentEvents";
import { useMessagesRealtime } from "@/hooks/inbox/useMessagesRealtime";
import { useConversationNotes } from "@/hooks/inbox/useConversationNotes";
import { useDeleteNote } from "@/hooks/inbox/useDeleteNote";
import { useDebugToggle } from "@/hooks/ai/useDebugToggle";
import { useActiveOrg, useUser } from "@/hooks/auth/AuthProvider";
import { ROLE_RANK } from "@/lib/auth/types";
import { podeEncaminhar, TEXTO_DO_MOTIVO } from "@/lib/messaging/encaminhar";
import type { Message, Note } from "@/lib/types/messaging";

interface Props {
  conversationId: string | null;
  /** Escolher uma mensagem para responder. Sobe até o composer. */
  onResponder?: (m: Message) => void;
  /** Começar a encaminhar a partir de uma mensagem (liga o modo de seleção, que mora em quem monta). */
  onEncaminhar?: (m: Message) => void;
  /**
   * O modo de seleção, quando ligado: as mensagens marcadas, como alternar uma e quantas cabem. Em
   * quem monta (e não aqui) porque a barra de baixo e o diálogo precisam do mesmo conjunto.
   */
  selecao?: { ids: ReadonlySet<string>; aoAlternar: (m: Message) => void; maximo: number };
}

/** Onda 5.2: union de item do thread — mensagem real ou nota interna (nunca vai ao cliente). */
export type ThreadItem =
  | { kind: "message"; ts: string; data: Message }
  | { kind: "note"; ts: string; data: Note }
  | { kind: "responsavel"; ts: string; data: AssignmentEvent };

/** Intercala mensagens e notas por timestamp asc (puro, sem I/O — testado em thread-merge.test.ts). */
export function mergeThreadItems(
  messages: Message[],
  notes: Note[],
  eventos: AssignmentEvent[] = [],
): ThreadItem[] {
  const items: ThreadItem[] = [
    ...messages.map((data): ThreadItem => ({ kind: "message", ts: data.sent_at, data })),
    ...notes.map((data): ThreadItem => ({ kind: "note", ts: data.created_at, data })),
    // Terceira fonte da MESMA linha do tempo, e não uma lista ao lado: "Fulano
    // assumiu" só significa alguma coisa no ponto do histórico em que
    // aconteceu. Numa seção separada, a pessoa teria de cruzar horários de
    // cabeça para saber o que veio antes da troca de dono.
    ...eventos.map((data): ThreadItem => ({ kind: "responsavel", ts: data.created_at, data })),
  ];
  // Sort estável (Array#sort é estável no V8/Node): empate mantém a ordem de
  // inserção acima — mensagens antes de notas no mesmo instante.
  items.sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());
  return items;
}

/**
 * O que a bolha precisa saber do modo de seleção: está marcada? dá para marcar? se não, por quê?
 *
 * Uma mensagem que não pode ser encaminhada (apagada, que falhou, de um tipo ainda não suportado) ou
 * que não cabe mais (o teto de mensagens por vez) fica com a caixa desabilitada e o MOTIVO na dica —
 * uma caixa cinza sem explicação parece defeito.
 */
export function selecaoDaBolha(
  m: Message,
  s: NonNullable<Props["selecao"]>,
  t: (texto: string) => string,
) {
  const elegivel = podeEncaminhar(m);
  const marcada = s.ids.has(m.id);
  const semVaga = s.ids.size >= s.maximo && !marcada;
  return {
    marcada,
    podeMarcar: elegivel.ok && !semVaga,
    motivo: !elegivel.ok
      ? t(TEXTO_DO_MOTIVO[elegivel.motivo])
      : semVaga
        ? `${t("No máximo")} ${s.maximo} ${t("mensagens por vez")}`
        : undefined,
    aoAlternar: () => s.aoAlternar(m),
  };
}

function dayLabel(d: Date, t: (texto: string) => string = (texto) => texto, locale: Locale): string {
  if (isToday(d)) return t("Hoje");
  if (isYesterday(d)) return t("Ontem");
  return format(d, "dd/MM/yyyy", { locale: locale });
}

export function ChatThread({ conversationId, onResponder, onEncaminhar, selecao }: Props) {
  const localeDaData = useLocaleDeData();
  const t = useT();
  const q = useMessagesRealtime(conversationId);
  const notes = useConversationNotes(conversationId);
  const eventosDeResponsavel = useConversationAssignmentEvents(conversationId);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const paginasVistas = useRef(0);
  const activeOrg = useActiveOrg();
  const currentUser = useUser();
  const deleteNote = useDeleteNote(conversationId ?? "");
  const canManage = activeOrg != null && ROLE_RANK[activeOrg.role] >= ROLE_RANK.manager;
  const { enabled: debugCitations } = useDebugToggle(activeOrg?.role ?? null);

  const messages: Message[] = useMemo(
    () => q.data?.pages.flatMap((p) => p.data) ?? [],
    [q.data],
  );

  /**
   * As mensagens por id, para resolver a CITADA sem ir ao servidor.
   *
   * Uma consulta por bolha citada seria uma cascata de requisições numa
   * conversa longa. Aqui o fio sai da lista que já está na tela — e quando a
   * citada ficou fora da página carregada, ele simplesmente não aparece, que é
   * melhor que segurar a conversa esperando por um texto de enfeite.
   */
  const porId = useMemo(() => new Map(messages.map((m) => [m.id, m])), [messages]);

  /**
   * IR PARA A MENSAGEM CITADA — rola o fio até ela e a destaca por um instante.
   *
   * A bolha é achada pelo `data-mensagem-id` dentro do PRÓPRIO rolador, e não por um mapa de refs: o
   * fio é o que está montado agora, e o que não está montado (a citada ficou numa página mais antiga
   * que não foi carregada) já nem mostra citação — ver `porId`. Se por algum motivo a bolha não
   * estiver lá, não faz nada, em vez de fingir.
   */
  const [destacadaId, setDestacadaId] = useState<string | null>(null);
  const fimDoDestaque = useRef<ReturnType<typeof setTimeout> | null>(null);
  const irParaMensagem = useCallback((id: string) => {
    const alvo = scrollerRef.current?.querySelector<HTMLElement>(`[data-mensagem-id="${id}"]`);
    if (!alvo) return;
    const semAnimacao = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    alvo.scrollIntoView({ behavior: semAnimacao ? "auto" : "smooth", block: "center" });
    setDestacadaId(id);
    if (fimDoDestaque.current) clearTimeout(fimDoDestaque.current);
    fimDoDestaque.current = setTimeout(() => setDestacadaId(null), 1800);
  }, []);
  useEffect(
    () => () => {
      if (fimDoDestaque.current) clearTimeout(fimDoDestaque.current);
    },
    [],
  );

  const items: ThreadItem[] = useMemo(
    () => mergeThreadItems(messages, notes, eventosDeResponsavel),
    [messages, notes, eventosDeResponsavel],
  );

  const paginas = q.data?.pages.length ?? 0;

  // Conversa nova: a contagem de páginas recomeça, senão a primeira carga da
  // próxima conversa seria confundida com um "carregar mais antigas".
  useEffect(() => {
    paginasVistas.current = 0;
  }, [conversationId]);

  // Rola ao fim na primeira carga e quando chega mensagem/nota nova — mas NÃO
  // quando o crescimento veio do "Carregar mais antigas".
  //
  // A thread pagina para o PASSADO: cada `fetchNextPage` traz mensagens mais
  // antigas, que entram ACIMA das que já estão na tela. Rolar ao fim aqui
  // devolveria o usuário ao rodapé no instante em que ele pediu para subir —
  // o clique parece não ter efeito, embora tenha carregado (medido: thread vai
  // de msg#15..#64 para msg#1..#64 e a viewport volta a 7px do fim).
  //
  // A segunda guarda cobre o outro caso: se o usuário rolou para ler o
  // histórico, mensagem nova não deve arrancá-lo de onde estava.
  useEffect(() => {
    const primeiraCarga = paginasVistas.current === 0;
    const carregouAntigas = !primeiraCarga && paginas > paginasVistas.current;
    paginasVistas.current = paginas;
    if (carregouAntigas) return;

    // A guarda de distância NÃO vale na primeira carga: ali o scroller ainda
    // está no topo por definição, e tratá-lo como "usuário lendo o histórico"
    // abriria a conversa na mensagem mais antiga da página em vez da mais nova
    // (medido: a thread abria em msg#15 em vez de msg#64).
    if (!primeiraCarga) {
      const sc = scrollerRef.current;
      if (sc && sc.scrollHeight - sc.scrollTop - sc.clientHeight > 120) return;
    }

    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [items.length, conversationId, paginas]);

  /**
   * O ESTADO DO CANAL DESTE THREAD, PUBLICADO SEMPRE — inclusive quando não há
   * mensagem nenhuma.
   *
   * ⚠️ A primeira versão punha estes atributos só no caso de SUCESSO, junto com
   * o `data-testid`. Isso os tornava invisíveis exatamente no estado em que
   * mais importam: conversa sem mensagens, esperando a primeira chegar. O canal
   * existe desde que a conversa abre; o sinal dele não pode depender de já
   * haver o que mostrar.
   *
   * Custou uma rodada de CI para aparecer, e por um motivo que vale registrar:
   * na máquina de quem desenvolve a conversa tem histórico acumulado, então o
   * caminho de sucesso é o único que se exercita. No CI o banco é fresco e a
   * conversa nasce vazia — o estado que nunca se vê localmente é o normal lá.
   *
   * Os dois atributos dizem coisas diferentes e nenhum sozinho basta:
   * `-status-mensagens` distingue "assinou" de "nem chegou a assinar";
   * `-divergencias-mensagens` é o que denuncia canal ASSINADO E MUDO, porque só
   * incrementa quando o refetch traz o que o canal não trouxe.
   */
  const sinalDoCanal = {
    "data-testid": "chat-thread",
    "data-realtime-status-mensagens": q.realtimeStatus,
    "data-refetch-divergencias-mensagens": q.seguranca?.divergencias ?? 0,
  } as const;

  if (!conversationId) {
    return (
      <div
        {...sinalDoCanal}
        className="flex h-full items-center justify-center text-sm text-muted-foreground"
      >
        {t("Selecione uma conversa")}
      </div>
    );
  }

  if (q.isLoading) {
    return (
      <div {...sinalDoCanal} className="space-y-3 p-4">
        {[1, 2, 3, 4].map((i) => (
          <Skeleton key={i} className="h-12 w-2/3" />
        ))}
      </div>
    );
  }

  if (q.isError) {
    return (
      <div
        {...sinalDoCanal}
        className="flex h-full flex-col items-center justify-center gap-2 text-sm text-muted-foreground"
      >
        <p>{t("Erro ao carregar mensagens.")}</p>
        <Button size="sm" variant="outline" onClick={() => q.refetch()}>
          {t("Tentar novamente")}
        </Button>
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div
        {...sinalDoCanal}
        className="flex h-full items-center justify-center text-sm text-muted-foreground"
      >
        {t("Nenhuma mensagem nesta conversa.")}
      </div>
    );
  }

  // Group by day for separators (usa o timestamp do item — sent_at pra mensagem, created_at pra nota).
  const groups: { key: string; date: Date; items: ThreadItem[] }[] = [];
  for (const item of items) {
    const d = new Date(item.ts);
    const key = format(d, "yyyy-MM-dd");
    const last = groups[groups.length - 1];
    if (last && last.key === key) last.items.push(item);
    else groups.push({ key, date: d, items: [item] });
  }

  return (
    <div {...sinalDoCanal} className="flex h-full flex-col">
      {/* `overflow-x-hidden`: deslizar uma bolha para responder a empurra para a direita, e sem isto a
          sobra criaria rolagem lateral (o `overflow-y: auto` sozinho já faz o x virar `auto`). */}
      <div ref={scrollerRef} className="inbox-conversa flex-1 overflow-x-hidden overflow-y-auto py-2">
        {q.hasNextPage && (
          <div className="flex justify-center py-2">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => q.fetchNextPage()}
              disabled={q.isFetchingNextPage}
            >
              {q.isFetchingNextPage ? t("Carregando…") : t("Carregar mais antigas")}
            </Button>
          </div>
        )}

        {groups.map((g) => (
          <div key={g.key}>
            <div className="sticky top-0 z-10 flex justify-center py-1.5">
              <span className="rounded-md bg-[var(--chat-in)] px-2.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground shadow-[var(--chat-bolha-sombra)]">
                {dayLabel(g.date, t, localeDaData)}
              </span>
            </div>
            {g.items.map((item, indice) => {
              /**
               * Esta linha ABRE um bloco de falas seguidas?
               *
               * Abre quando é a primeira do dia, quando a anterior é uma nota
               * interna (outro tipo de conteúdo), quando o lado muda, ou quando
               * houve silêncio de mais de cinco minutos.
               *
               * O silêncio entra na conta porque duas falas do mesmo lado com
               * meia hora entre elas não são a mesma fala: sem esse corte, uma
               * conversa de um dia inteiro vira um bloco único com um rabinho
               * lá em cima, e o olho perde onde cada retomada começou. Cinco
               * minutos é a convenção de agrupamento de bate-papo — não tem
               * relação com o piso de SLA de `tempo-sem-resposta`, que responde
               * outra pergunta.
               */
              const anterior = indice > 0 ? g.items[indice - 1] : undefined;
              // Nota e evento de responsável INTERROMPEM o bloco pelo mesmo
              // motivo: os dois são outra coisa no meio da fala. Depois de
              // "Fulano assumiu", a próxima mensagem começa uma fala nova e leva
              // rabinho — sem isso ela colaria no bloco anterior atravessando o
              // aviso, e o agrupamento diria uma coisa que a tela desmente.
              const quebraOBloco = (i: ThreadItem | undefined) =>
                i === undefined || i.kind === "note" || i.kind === "responsavel";
              const primeiraDoGrupo =
                item.kind === "message" &&
                (quebraOBloco(anterior) ||
                  (anterior!.kind === "message" &&
                    (anterior!.data.direction !== item.data.direction ||
                      new Date(item.ts).getTime() - new Date(anterior!.ts).getTime() >
                        5 * 60_000)));

              return item.kind === "responsavel" ? (
                <EventoDeResponsavel key={`resp-${item.data.id}`} evento={item.data} />
              ) : item.kind === "note" ? (
                <NoteCard
                  key={`note-${item.data.id}`}
                  note={item.data}
                  // Só o autor ou manager+ vê o excluir — o backend barra o resto (403),
                  // então não mostramos um botão que daria erro.
                  onDelete={
                    item.data.created_by_user_id === currentUser.id || canManage
                      ? () => deleteNote.mutate(item.data.id)
                      : undefined
                  }
                />
              ) : (
                <MessageBubble
                  key={`msg-${item.data.id}`}
                  message={item.data}
                  debugCitations={debugCitations}
                  onResponder={onResponder}
                  // A citada sai da MESMA lista já carregada: buscar no servidor
                  // por cada citação faria uma consulta por bolha. Quando a
                  // citada é antiga demais e ficou fora da página, o fio some —
                  // que é melhor que segurar a conversa esperando.
                  citada={porId.get(item.data.reply_to_message_id ?? "") ?? null}
                  onIrParaMensagem={irParaMensagem}
                  destacada={destacadaId === item.data.id}
                  onEncaminhar={onEncaminhar}
                  selecao={selecao ? selecaoDaBolha(item.data, selecao, t) : undefined}
                  primeiraDoGrupo={primeiraDoGrupo}
                />
              );
            })}
          </div>
        ))}

        <div ref={bottomRef} />
      </div>
    </div>
  );
}
