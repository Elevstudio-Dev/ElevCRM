"use client";
import { useMemo } from "react";
import { useT } from "@/hooks/i18n/useT";
import type { InfiniteData, UseInfiniteQueryResult } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useChannelSessions } from "@/hooks/channels/useChannelSessions";
import { useAuth } from "@/hooks/auth/AuthProvider";
import { useConversationTagVocabulary } from "@/hooks/inbox/useConversationTags";

import { useAutomaticoAtivo } from "@/hooks/ai/useAutomaticoAtivo";
import { useLimiteDeResposta } from "@/hooks/inbox/useLimiteDeResposta";

import { ConversationListItem } from "./ConversationListItem";
import { EmptyInbox } from "@/components/empty";
import type {
  ConversationsFilters,
  ConversationWithContact,
} from "@/hooks/inbox/useConversationsRealtime";

interface ListResponse {
  data: ConversationWithContact[];
  meta?: { cursor?: string | null; has_more?: boolean };
}

interface Props {
  /** Query já montada no pai — evita duplicar subscription Realtime + refetch. */
  listQuery: UseInfiniteQueryResult<InfiniteData<ListResponse>, Error>;
  filters: ConversationsFilters;
  selectedId: string | null;
  onSelect: (id: string) => void;
  /** Optional client-side filter (e.g. only-unread). */
  clientFilter?: (c: ConversationWithContact) => boolean;
}

export function ConversationList({
  listQuery: q,
  filters,
  selectedId,
  onSelect,
  clientFilter,
}: Props) {
  const t = useT();
  // Só mostra POR ONDE a conversa entrou quando há mais de um número. Com um
  // só, o rótulo seria a mesma palavra em toda linha — ruído que ensina o olho
  // a ignorar a área onde vivem os avisos que importam.
  //
  // `?? []` e não `undefined`: enquanto a lista de canais carrega, o certo é
  // NÃO mostrar. Mostrar e sumir depois é pior que aparecer um instante tarde.
  const canais = useChannelSessions().data ?? [];
  const maisDeUmCanal = canais.length > 1;

  // Fila (G5-03): a lista já vem ordenada por tempo de espera (server), então a
  // posição é o índice na lista visível. Só mostramos posição/espera nessa visão.
  // A Fila deixou de mandar `assigned_to=unassigned` (agora pede `comando`), e
  // sem esta linha a numeração "1º, 2º…" e o tempo de espera sumiriam da única
  // visão em que servem para alguma coisa — sem erro nenhum, só sumiriam.
  const isQueue =
    filters.comando?.includes("aguardando") ?? filters.assigned_to === "unassigned";
  // Uma leitura por lista, compartilhada por todas as linhas (react-query dedupa
  // com o cabeçalho, que faz a mesma pergunta).
  const automaticoDaOrg = useAutomaticoAtivo();
  const limiteDeResposta = useLimiteDeResposta();
  // O vocabulário de marcadores da empresa, lido UMA vez para a lista inteira: a linha pinta cada
  // tag com a cor do marcador, e o hook por linha seriam 50 leituras da mesma coisa.
  const { activeOrg } = useAuth();
  const { data: vocabularioDeTags } = useConversationTagVocabulary(activeOrg?.orgId ?? null);
  const coresDasTags = useMemo(
    () => new Map((vocabularioDeTags ?? []).map((m) => [m.nome, m.cor] as const)),
    [vocabularioDeTags],
  );

  const items = useMemo(() => {
    const all: ConversationWithContact[] = q.data?.pages.flatMap((p) => p.data) ?? [];
    return clientFilter ? all.filter(clientFilter) : all;
  }, [q.data, clientFilter]);

  /**
   * O badge de atendente só entra quando DISCRIMINA — mesma regra do badge de
   * canal, e pelo mesmo motivo escrito lá: rótulo que se repete em toda linha
   * ensina o olho a ignorar a área onde vivem os avisos que importam.
   *
   * Medido nas abas: "Fila" pede `comando=aguardando` (nenhuma linha tem dono —
   * a régua põe quem tem dono em `humano`), "Minhas" filtra `assigned_to=me`
   * (todas têm o MESMO) e "Automático" pede `comando=automatico` (também sem
   * dono, pela mesma razão). Sobram "Todas" e "Fechadas" — e mesmo nelas, só
   * vale se a página realmente tiver mais de um dono distinto.
   *
   * O `filters.comando` entrou junto com as abas novas: sem ele, a Fila voltaria
   * a repetir o mesmo selo de atendente em cada uma das linhas.
   */
  const mostrarAtendente = useMemo(() => {
    if (filters.assigned_to) return false;
    if (filters.comando && !filters.comando.includes("humano")) return false;
    const donos = new Set(
      items.map((i) => i.assigned_to_user_id).filter((id): id is string => Boolean(id)),
    );
    return donos.size > 1;
  }, [filters.assigned_to, filters.comando, items]);

  if (q.isLoading) {
    return (
      <div className="space-y-3 p-3">
        {[1, 2, 3, 4, 5].map((i) => (
          <Skeleton key={i} className="h-16 w-full" />
        ))}
      </div>
    );
  }

  if (q.isError) {
    return (
      <div className="p-4 text-center text-sm text-muted-foreground">
        <p>Erro ao carregar conversas.</p>
        <Button
          size="sm"
          variant="outline"
          className="mt-2"
          onClick={() => q.refetch()}
        >
          Tentar novamente
        </Button>
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <EmptyInbox />
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex-1 overflow-y-auto">
        {items.map((c, i) => (
          <ConversationListItem
            key={c.id}
            conversation={c}
            isSelected={c.id === selectedId}
            onSelect={onSelect}
            queuePosition={isQueue ? i + 1 : undefined}
            mostrarCanal={maisDeUmCanal}
            mostrarAtendente={mostrarAtendente}
            automaticoDaOrg={automaticoDaOrg.data}
            limiteMinutos={limiteDeResposta}
            coresDasTags={coresDasTags}
          />
        ))}
        {q.hasNextPage && (
          <div className="flex justify-center p-3">
            <Button
              size="sm"
              variant="outline"
              onClick={() => q.fetchNextPage()}
              disabled={q.isFetchingNextPage}
            >
              {q.isFetchingNextPage ? t("Carregando…") : t("Carregar mais")}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
