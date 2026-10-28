"use client";
import { useCallback, useMemo, useState } from "react";
import { useT } from "@/hooks/i18n/useT";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useAuth } from "@/hooks/auth/AuthProvider";
import {
  useConversationsRealtime,
  type ConversationsFilters,
  type ConversationWithContact,
} from "@/hooks/inbox/useConversationsRealtime";
import { useConversation, isNotFound } from "@/hooks/inbox/useConversation";
import { ConversationList } from "./ConversationList";
import { InboxFilters, type InboxFiltersValue, type InboxTab } from "./InboxFilters";
import { ConversaAberta } from "./ConversaAberta";
import { CRMSidePanel } from "./CRMSidePanel";

import { OpenConversationProvider } from "@/hooks/notifications/OpenConversationContext";
// ADR-05: ícone de feature sai do mapa canônico, nunca do pacote direto.
import { CaretLeft, IdentificationCard } from "@/lib/ui/icons";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import { comandosDaFila } from "@/lib/inbox/comando-da-conversa";
import { useAutomaticoAtivo } from "@/hooks/ai/useAutomaticoAtivo";

/**
 * QUAL COLUNA APARECE NO CELULAR — as duas saem da MESMA pergunta.
 *
 * Abaixo do `md` só cabe uma coluna por vez, então a lista e a conversa se
 * alternam. O defeito que esta função existe para tornar impossível é as duas
 * decidirem por dados DIFERENTES: a lista somia com `selectedId` (o id) e a
 * conversa aparecia com `selectedConversation` (o objeto já carregado). Entre
 * uma coisa e a outra existe uma janela em que nenhuma das duas aparece — e
 * essa janela tem dois casos reais no telefone:
 *
 *   1. o deep-link `/inbox/<id>`, enquanto a busca única ainda responde;
 *   2. a conversa fora do acesso, que é estado PERMANENTE — e cuja mensagem
 *      ("Conversa não encontrada") ficava escondida junto, deixando o dono
 *      numa tela branca sem nem o botão de voltar.
 *
 * Com uma pergunta só, "as duas escondidas" deixa de ser representável.
 * `md:flex` em ambas: no desktop as duas colunas convivem e a regra não vale.
 */
export function colunasDoCelular(temSelecao: boolean): { lista: string; conversa: string } {
  return {
    lista: temSelecao ? "hidden md:flex" : "flex",
    conversa: temSelecao ? "flex" : "hidden md:flex",
  };
}

/**
 * O QUE CADA ABA SIGNIFICA. Exportada porque é a definição em si — o defeito
 * que este mapa já teve (Minhas mostrando tudo que o atendente fechou) não
 * aparece em nenhuma tela até alguém reclamar, então vale prender por teste.
 */
export function tabToFilter(
  tab: InboxFiltersValue["tab"],
  automaticoDaOrg?: boolean,
): Partial<ConversationsFilters> {
  // GRUPO SO APARECE NA VISAO DE GRUPO — e o outro lado da mesma decisao.
  //
  // Dar aos grupos uma visao propria sem tira-los das demais seria dar o
  // trabalho e nao o beneficio: um grupo de 40 pessoas produz dezenas de
  // mensagens por hora e empurraria para fora da primeira pagina da Fila
  // justamente o cliente que esta esperando. Por isso toda visao que nao a de
  // Grupos pede `is_group: false` explicitamente, e nao "o que vier".
  if (tab === "grupos") return { is_group: true };
  switch (tab) {
    // Todos os `return` abaixo levam `is_group: false` — ver o comentario acima.
    case "unassigned":
      // A FILA PERGUNTA POR QUEM MANDA, NÃO POR STATUS.
      //
      // Antes ela pedia `assigned_to=unassigned` + os dois estados de espera. Só
      // que "sem dono e aberta" é também a conversa que o robô está atendendo
      // agora — medido na VPS em 2026-08-30, a aba dizia 83 e 47 daquelas tinham
      // o automático no comando. O atendente abria a Fila e via como trabalho
      // dele quase tudo que já estava sendo respondido.
      //
      // `comandosDaFila` é quem cruza isso com o fato org-wide: numa instalação
      // sem nenhum agente no ar, `automatico` também é "esperando gente".
      return { comando: comandosDaFila(automaticoDaOrg), is_group: false };
    case "mine":
      // Sem `exclude_finished` a aba mostra tudo que o atendente JÁ atendeu —
      // `Fechar` muda o status mas não solta o dono (de propósito: quem atendeu
      // é histórico). O lugar de "minhas fechadas" é a aba Fechadas.
      return { assigned_to: "me", exclude_finished: true, is_group: false };
    case "closed":
      return { status: "closed", is_group: false };
    case "ai":
      // `ai_handling` é escrito por UM caminho só em produção (a volta pelo botão
      // "Devolver ao automático"), então a aba vivia mostrando 2 enquanto o robô
      // atendia 47. Agora ela pergunta a régua do MOTOR.
      return { comando: ["automatico"], is_group: false };
    case "all":
    default:
      return { is_group: false };
  }
}

const FILTER_TABS: InboxTab[] = ["unassigned", "mine", "all", "closed", "ai", "grupos"];

/**
 * Lê ?filter= (G4-02, deep-link). ?filter=all é HONRADO mesmo para agent — a
 * lista volta RLS-scoped (a tab só some cosmeticamente); default: fila.
 */
function parseFilterParam(v: string | null): InboxTab {
  return v && FILTER_TABS.includes(v as InboxTab) ? (v as InboxTab) : "unassigned";
}

interface InboxLayoutProps {
  initialSelectedId?: string | null;
}

export function InboxLayout({ initialSelectedId = null }: InboxLayoutProps = {}) {
  const t = useT();
  const { activeOrg } = useAuth();
  const orgId = activeOrg?.orgId ?? null;

  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const tab = parseFilterParam(searchParams.get("filter"));

  // tab vive na URL (?filter=); os demais filtros são estado local de sessão.
  const [aux, setAux] = useState<Omit<InboxFiltersValue, "tab">>({
    search: "",
    onlyUnread: false,
  });
  const filterValue: InboxFiltersValue = { tab, ...aux };
  const setFilterValue = useCallback(
    (next: InboxFiltersValue) => {
      if (next.tab !== tab) {
        const params = new URLSearchParams(searchParams);
        params.set("filter", next.tab);
        router.replace(`${pathname}?${params.toString()}`, { scroll: false });
      }
      const { tab: _t, ...rest } = next;
      setAux(rest);
    },
    [tab, searchParams, router, pathname],
  );

  const [selectedId, setSelectedId] = useState<string | null>(initialSelectedId);
  /** A ficha do contato como painel deslizante — só existe abaixo do `xl`. */
  const [fichaAberta, setFichaAberta] = useState(false);
  // A mensagem escolhida para responder "em cima" mora em `ConversaAberta`, junto
  // do composer que a mostra — e some sozinha ao trocar de conversa (a `key`).

  /**
   * A ORG tem automático de pé? Sobe para cá porque agora é a ABA que precisa —
   * `ConversationList` e `ConversationHeader` continuam lendo o mesmo hook, e o
   * react-query dedupa: segue sendo uma requisição só.
   *
   * `undefined` enquanto carrega, e `comandosDaFila` trata isso como "assume que
   * há" — a mesma convenção da regra. Numa org SEM automático a Fila nasce menor
   * e completa quando a resposta chega; a janela é de ~200ms e o rótulo nunca
   * discorda do filtro, porque os dois usam a mesma convenção.
   */
  const { data: automaticoDaOrg } = useAutomaticoAtivo();

  const filters: ConversationsFilters = useMemo(
    () => ({
      ...tabToFilter(filterValue.tab, automaticoDaOrg),
      search: filterValue.search || undefined,
      channel_session_id: filterValue.channel_session_id,
      tag: filterValue.tag,
      sector_id: filterValue.sector_id,
    }),
    [
      filterValue.tab,
      automaticoDaOrg,
      filterValue.search,
      filterValue.channel_session_id,
      filterValue.tag,
      filterValue.sector_id,
    ],
  );

  const clientFilter = useMemo(
    () =>
      filterValue.onlyUnread
        ? (c: ConversationWithContact) => (c.unread_count_for_assignee ?? 0) > 0
        : undefined,
    [filterValue.onlyUnread],
  );

  // We need the selected conversation object for header / composer / side panel.
  // Source it from the same query the list uses to avoid an extra request.
  const listQ = useConversationsRealtime(filters, orgId);
  const inList = useMemo(() => {
    const all = listQ.data?.pages.flatMap((p) => p.data) ?? [];
    return all.find((c) => c.id === selectedId) ?? null;
  }, [listQ.data, selectedId]);

  // Deep-link para conversa fora do filtro atual (ou fora do escopo do agent):
  // busca única RLS-scoped. 404/vazio ⇒ inacessível ⇒ estado vazio claro (GAP D),
  // nunca stack trace. A RLS (G4-01) é quem garante o não-vazamento.
  const needsFetch = !!selectedId && !inList && !listQ.isLoading;
  const single = useConversation(selectedId, needsFetch);
  const selectedConversation: ConversationWithContact | null = inList ?? single.data ?? null;
  const selectionNotFound =
    needsFetch && !single.isPending && !single.data && isNotFound(single.error);

  const colunas = colunasDoCelular(Boolean(selectedId));

  // Aceita `null`: é o VOLTAR do celular, que limpa a seleção e devolve a lista.
  // É um SUPERCONJUNTO do `handleSelect` do upstream — o tipo dele não aceita
  // `null`, e sem isso o botão de voltar não teria o que chamar.
  //
  // A seleção NÃO vive na URL (só o `?filter=` vive) — então este voltar é
  // estado local, e o botão de voltar do navegador não desfaz a seleção. É a
  // limitação conhecida deste caminho; trocar por URL mudaria o deep-link de
  // conversa, que hoje entra por `initialSelectedId` vindo da rota.
  const handleSelect = useCallback((id: string | null) => {
    setSelectedId(id);
  }, []);
  // `handleClaim` e `handleClose` viviam aqui e SÓ os atalhos de tecla os
  // chamavam. Assumir e arquivar continuam existindo — pelos botões do
  // cabeçalho da conversa, que tem os próprios `useClaimConversation` /
  // `useCloseConversation`. Manter as duas copias mortas aqui seria deixar duas
  // réguas para a mesma ação, esperando divergir.

  // A janela de 24h (e o relógio que a faz vencer sozinha com a aba aberta), o
  // contato bloqueado e a leitura da conversa moram em `ConversaAberta`: o funil
  // abre a MESMA conversa, e as duas telas não podem ter réguas diferentes.

  // A GRADE OCUPA A TELA INTEIRA ABAIXO DA BARRA — de borda a borda.
  //
  // `data-tela-cheia` é o que faz o `<main>` do AppShell abrir mão da moldura
  // de 24px (`[&:has([data-tela-cheia])]:p-0`): a conversa é o produto, e o
  // WhatsApp de onde o atendente vem não tem moldura nenhuma. Por isso a
  // altura desconta SÓ a barra superior:
  //   3.5rem            TopBar (`h-14`, em components/shell/TopBar.tsx)
  //
  // Antes a conta descontava também `2 * var(--space-6)` (o padding do main).
  // Se a moldura voltar um dia, a parcela volta junto — sem ela a grade media
  // 48px a MAIS que a tela e quem pagava era o composer, que nascia
  // parcialmente abaixo da borda, atrapalhando justo na hora de escrever.
  //
  // `dvh` em vez de `vh` porque no celular a `vh` ignora a barra do navegador — o
  // mesmo corte, só que pior e mudando conforme se rola a página.

  // TRÊS COLUNAS QUE CABEM — medido, não estimado.
  //
  // O `xl` do Tailwind dispara em 1280px, e era ali que a terceira coluna
  // nascia. Com o menu lateral (240px) sobravam 1040px, e o grid pedia
  // 300 + 707 + 320 = 1327 — o painel de CRM ficava 311px FORA da viewport.
  // Os 707px eram o `min-content` do `ConversationHeader`; consertado o
  // header, o `1fr` volta a encolher sozinho.
  //
  // SEM o menu lateral (2026-09-10) os 1280 são todos da grade: 300 + 320 de
  // colunas deixam 660px de conversa em 1280 — quase o dobro dos 372 de antes,
  // e 290px de folga sobre o piso do composer (370px). Por isso a faixa
  // compacta (272/296) que existia para o 1280 apertado saiu: ela existia
  // para dividir espaço com uma barra que não está mais lá.
  return (
    <OpenConversationProvider conversationId={selectedId}>
    <div
      data-tela-cheia=""
      className="grid h-[calc(100dvh-3.5rem)] w-full grid-cols-1 md:grid-cols-[300px_1fr] xl:grid-cols-[300px_1fr_320px] 2xl:grid-cols-[340px_1fr_340px]"
      /*
       * O ESTADO DO TEMPO REAL, LEGÍVEL DE FORA — mesmo par que o dossiê do lead
       * já publica (`LeadDossier`), e pela mesma razão: quando a entrega morre,
       * nenhuma tela avisa. Foi o único achado que atravessou o dia intacto
       * quando o realtime quebrou pela primeira vez, e voltou a morder agora.
       *
       * `divergencias` é o que a rede de segurança contou: refetch trouxe estado
       * novo que o canal NÃO tinha entregue. Zero com o canal vivo; subindo é a
       * assinatura de canal que assina e não entrega — o defeito que não grita.
       *
       * ⚠️ `data-realtime-status` vem do STATUS do canal, não de um objeto que
       * existe sempre. A primeira versão desta linha derivava o valor de
       * `listQ.seguranca`, que nunca é nulo — ela diria `ativo` inclusive com o
       * canal morto. Controle decorativo é pior que controle nenhum: mente com
       * cara de instrumento.
       *
       * Atributo de dado e não texto na tela de propósito: quem lê isto é o
       * teste e quem depura, não o atendente. Pôr um aviso permanente na cara de
       * quem atende seria ruído; esconder o sinal do todo é o que custou o dia.
       */
      data-realtime-status={listQ.realtimeStatus}
      data-refetch-divergencias={listQ.seguranca?.divergencias ?? 0}
    >
      {/*
        NO CELULAR, UMA COISA POR VEZ.

        Antes as duas colunas caíam empilhadas em `grid-cols-1`: a lista inteira
        primeiro e a conversa DEPOIS dela. Para responder era preciso rolar a
        lista toda até o fim, e o composer ficava fora da tela — que é o
        "incômodo" relatado por quem atende do telefone.

        Sem media query em JavaScript de propósito: `useMediaQuery` decide DEPOIS
        da hidratação, então a primeira pintura mostra o layout errado e pisca. A
        classe condicional é resolvida pelo CSS, na primeira pintura, e some no
        `md` — onde as duas colunas cabem juntas e a regra não se aplica.
      */}
      <div
        className={cn(
          "h-full min-h-0 flex-col border-r border-border md:flex",
          colunas.lista,
        )}
      >
        <InboxFilters value={filterValue} onChange={setFilterValue} />
        <div className="min-h-0 flex-1 overflow-hidden">
          <ConversationList
            listQuery={listQ}
            filters={filters}
            selectedId={selectedId}
            onSelect={handleSelect}
            clientFilter={clientFilter}
          />
        </div>
      </div>

      {/*
        AS DUAS COLUNAS DECIDEM PELO MESMO DADO — `selectedId`, não o objeto.

        A da lista some quando há `selectedId`; se esta aparecesse só quando a
        conversa já está CARREGADA, a janela entre as duas coisas não mostra
        nenhuma das colunas. No celular isso é a tela em branco, e ela tem dois
        casos reais: o instante do deep-link `/inbox/<id>`, enquanto a busca
        única ainda responde; e o estado permanente de conversa fora do acesso,
        cuja mensagem ("Conversa não encontrada") é justamente o que ficava
        escondido — deixando o dono numa tela vazia, sem sequer o botão de
        voltar, porque ele morava dentro do ramo da conversa carregada.
      */}
      <div
        className={cn(
          "h-full min-h-0 flex-col md:flex",
          colunas.conversa,
        )}
      >
        {/*
          A barra do celular vive FORA do ramo da conversa carregada: o caminho
          de volta tem de existir inclusive quando não há o que mostrar — é aí
          que ele é a única saída. A porta da ficha, essa sim, depende da
          conversa, e só aparece quando há uma.
        */}
        {selectedId && (
          <div className="flex items-center gap-1 border-b border-border px-1 py-1 md:hidden">
            <Button
              variant="ghost"
              size="sm"
              className="h-9 gap-1 px-2"
              onClick={() => handleSelect(null)}
            >
              <CaretLeft size={16} />
              {t("Conversas")}
            </Button>
            <div className="flex-1" />
            {selectedConversation && (
              <Sheet open={fichaAberta} onOpenChange={setFichaAberta}>
                <SheetTrigger asChild>
                  <Button variant="ghost" size="sm" className="h-9 gap-1 px-2 xl:hidden">
                    <IdentificationCard size={16} />
                    {t("Ficha")}
                  </Button>
                </SheetTrigger>
                <SheetContent side="right" className="w-[min(22rem,90vw)] overflow-y-auto p-0">
                  <SheetTitle className="sr-only">{t("Ficha do contato")}</SheetTitle>
                  <CRMSidePanel conversation={selectedConversation} />
                </SheetContent>
              </Sheet>
            )}
          </div>
        )}
        {selectedConversation ? (
          // `key`: trocar de conversa REMONTA, e a citação escolhida não vai junto.
          <ConversaAberta key={selectedConversation.id} conversation={selectedConversation} />
        ) : selectionNotFound ? (
          <div className="flex h-full items-center justify-center px-6 text-center text-sm text-muted-foreground">
            {t("Conversa não encontrada ou fora do seu acesso.")}
          </div>
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            {t("Selecione uma conversa")}
          </div>
        )}
      </div>

      <div className="hidden h-full min-h-0 xl:block">
        <CRMSidePanel conversation={selectedConversation} />
      </div>

      {/*
        OS ATALHOS DE UMA TECLA SAÍRAM EM 2026-09-05, a pedido do dono.
        Eram `j` `k` `r` `a` `e` e `?`, globais na pagina do inbox. O relato foi
        direto: "quando eu aperto E, aparece para fechar a conversa, não quero
        isso".

        O defeito não era o `e` — era a CLASSE. Atalho de uma letra sem
        modificador dispara em qualquer lugar da página que não seja um campo de
        texto, e no inbox a mão está o tempo todo entre a lista e o composer.
        Encostar numa tecla com o foco fora do campo virava uma pergunta
        "Fechar conversa?" que ninguém pediu — e `e` fica ao lado de `r` e `a`,
        que TAMBÉM agiam (focar resposta, assumir).

        O diálogo de ajuda (`?`) saiu junto: ele existia para documentar estes
        atalhos. Enter e Shift+Enter NÃO eram dele — são comportamento do campo
        de texto, continuam valendo, e a dica vive no `title` do próprio campo
        (ver o comentário em `Composer.tsx`).

        `mod+k` (busca) e `mod+shift+l` (tema) ficam: exigem modificador, então
        não disparam sozinhos enquanto alguém trabalha.

        Vigiado por `tests/unit/inbox-sem-atalho-de-uma-tecla.test.ts`.
      */}
    </div>
    </OpenConversationProvider>
  );
}
