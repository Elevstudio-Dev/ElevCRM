"use client";
import { useT } from "@/hooks/i18n/useT";
import { type ComponentPropsWithoutRef, forwardRef, useEffect, useState } from "react";
import { CaretDown, MagnifyingGlass } from "@/lib/ui/icons";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { channelLabel, useChannelSessions } from "@/hooks/channels/useChannelSessions";
import { useAuth } from "@/hooks/auth/AuthProvider";
import { useConversationTagVocabulary } from "@/hooks/inbox/useConversationTags";
import { useSetores } from "@/hooks/setores/useSetores";
import { useConversationCounts } from "@/hooks/inbox/useConversationCounts";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { apiClient } from "@/lib/api/client";
import { showApiError } from "@/components/feedback/ApiErrorToast";
import { CLASSE_DE_COR } from "@/lib/marcadores/cores";
import { cn } from "@/lib/utils";
import type { Role, VisibilityMode } from "@/lib/auth/types";

export type InboxTab = "unassigned" | "mine" | "all" | "closed" | "ai" | "grupos";

const INBOX_TABS: { value: InboxTab; label: string }[] = [
  { value: "unassigned", label: "Fila" },
  { value: "mine", label: "Minhas" },
  { value: "all", label: "Todas" },
  // "Arquivadas", não "Fechadas": o botão do cabeçalho virou "Arquivar" em
  // 2026-09-04, e duas palavras para a mesma coisa ensinam que são coisas
  // diferentes. O VALOR (`closed`) não muda — ele é contrato de API e de banco.
  { value: "grupos", label: "Grupos" },
  { value: "closed", label: "Arquivadas" },
  // "Automático", não "IA": a palavra deste ator já é contrato em quatro arquivos
  // e no dicionário, e `handoff-por-orcamento.test.ts` usa literalmente "Voltar
  // para a IA" como a sabotagem que deve reprovar. A aba era a última fora do
  // padrão — e ela mudou de significado junto (deixou de filtrar `ai_handling` e
  // passou a perguntar a régua do motor), então o rótulo velho descreveria outra
  // coisa.
  { value: "ai", label: "Automático" },
];

/**
 * Visões visíveis por papel + escopo (G4-02, acceptance 1). 'Todas' fica oculta
 * para `agent` quando visibility_mode ≠ 'all'; viewer/manager/admin sempre veem.
 * É apenas cosmético — a RLS (G4-01) é quem garante o escopo mesmo via ?filter=all.
 */
export function visibleInboxTabs(role: Role, mode: VisibilityMode | undefined): InboxTab[] {
  const hideAll = role === "agent" && mode !== "all";
  return INBOX_TABS.filter((t) => !(t.value === "all" && hideAll)).map((t) => t.value);
}

export interface InboxFiltersValue {
  tab: InboxTab;
  search: string;
  onlyUnread: boolean;
  channel_session_id?: string;
  tag?: string;
  /** Um setor (uuid) ou `"sem"`. Só aparece quando a organização tem setores. */
  sector_id?: string;
}

/** As visões que viram botão à vista; as demais ficam só no menu ▾. */
const CHIPS_DE_VISAO: InboxTab[] = ["unassigned", "mine", "grupos"];

/**
 * Os seletores de número, setor e tag, em pílula: filtro secundário não pode brigar com a busca e
 * os chips pelo olho. `w-auto` — o `SelectTrigger` nasce `w-full`, e três seletores de largura
 * cheia empilhariam de volta o que a pílula veio compactar.
 */
const SELETOR_EM_PILULA =
  "h-7 w-auto max-w-full gap-1.5 rounded-full border-border bg-muted px-3 py-0 text-xs shadow-none";

/**
 * O chip: um botão de pílula que liga e desliga. `aria-pressed` e não `role="tab"` — não há painel
 * associado, e leitor de tela anuncia "botão, pressionado", que é exatamente o que ele é. Aceita o
 * resto das props de botão e o `ref` porque o menu ▾ o usa como gatilho (`asChild`).
 */
const ChipDoInbox = forwardRef<
  HTMLButtonElement,
  { ativo: boolean } & Omit<ComponentPropsWithoutRef<"button">, "className">
>(function ChipDoInbox({ ativo, children, ...props }, ref) {
  return (
    <button
      ref={ref}
      type="button"
      aria-pressed={ativo}
      className={cn(
        "inline-flex h-7 items-center gap-1 rounded-full border px-3 text-[13px] transition-colors",
        "focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring",
        ativo
          ? "border-transparent bg-success-bg font-medium text-success-fg"
          : "border-border bg-muted text-muted-foreground hover:bg-accent hover:text-foreground",
      )}
      {...props}
    >
      {children}
    </button>
  );
});

interface Props {
  value: InboxFiltersValue;
  onChange: (next: InboxFiltersValue) => void;
}

/**
 * Traz para o CRM os grupos que a conta JÁ participa.
 *
 * Mora aqui, e não na tela de Conexões, porque é aqui que a pergunta nasce: a
 * pessoa abre a visão Grupos, vê pouca coisa (ou nada) e quer os seus grupos.
 * Um botão numa tela de configuração que ela não abriu não seria encontrado.
 *
 * Só aparece na visão Grupos — nas outras seria ruído, e um botão que cria
 * dezenas de conversas não deve estar a um clique de distância de quem está
 * atendendo cliente.
 */
function ImportarGrupos() {
  const t = useT();
  const qc = useQueryClient();
  const [importando, setImportando] = useState(false);

  async function importar() {
    setImportando(true);
    try {
      // `{ data: … }` e não o objeto direto: TODA rota deste repo responde pelo
      // envelope de `ok()`. Sem o `.data`, `r.vinculados` é `undefined` — e o
      // toast saiu literalmente "undefined grupos importados" na tela do dono,
      // porque `undefined > 0` e `undefined === 0` são ambos falsos e a mensagem
      // caiu no ramo de sucesso. Os outros hooks do inbox já faziam certo
      // (`apiClient.get<{ data: Note[] }>`); este foi escrito sem olhar para eles.
      const { data: r } = await apiClient.post<{
        data: { encontrados: number; vinculados: number; falharam: number };
      }>("/api/v1/channels/groups/import", {});
      // O texto diz o NÚMERO, não "pronto": quem tem 12 grupos e vê "3
      // importados" precisa saber disso na hora, e não depois de procurar os
      // outros nove na lista.
      if (r.falharam > 0) {
        toast.warning(
          t("Grupos importados com falhas") +
            `: ${r.vinculados}/${r.encontrados}` +
            ` (${r.falharam} ${t("não entraram")})`,
        );
      } else if (r.vinculados === 0) {
        toast.info(t("Nenhum grupo encontrado neste número."));
      } else {
        toast.success(`${r.vinculados} ${t("grupos importados")}`);
      }
      /**
       * `refetchQueries` com `type: "all"`, e não `invalidateQueries`.
       *
       * ⚠️ ESTE CONSERTO É DE CLASSE, NÃO DE CAUSA — e a diferença está escrita
       * aqui porque ela importa para quem vier depois.
       *
       * O relato foi "precisei atualizar a página para os grupos aparecerem".
       * Três coisas foram MEDIDAS e estão certas: o servidor devolve as linhas
       * sob a RLS do usuario (9 de 9); o realtime entrega (assinatura por fora +
       * UPDATE provocado = evento recebido); e o prefixo `["conversations"]`
       * casa com a chave `["conversations", filters]`. A causa exata do lado do
       * navegador não foi reproduzida — não tenho a sessão dele para medir.
       *
       * O que se sabe da ferramenta: `invalidateQueries` marca como obsoleto e
       * só REBUSCA o que estiver ATIVO. Basta a consulta não estar ativa naquele
       * instante para a chamada virar um no-op silencioso. `refetchQueries` com
       * `type: "all"` não depende disso: busca de novo, ativa ou não.
       *
       * A contagem entra junto: o numero ao lado de "Grupos" vem de OUTRA rota,
       * e um badge que discorda da lista é o defeito que
       * `badge-espelha-a-aba.test.ts` existe para impedir.
       */
      await Promise.all([
        qc.refetchQueries({ queryKey: ["conversations"], type: "all" }),
        qc.invalidateQueries({ queryKey: ["conversation-counts"] }),
      ]);
    } catch (err) {
      showApiError(err);
    } finally {
      setImportando(false);
    }
  }

  return (
    <Button
      variant="outline"
      size="sm"
      className="h-8 w-full"
      onClick={importar}
      disabled={importando}
      data-testid="importar-grupos"
    >
      {importando ? t("Importando…") : t("Importar grupos do WhatsApp")}
    </Button>
  );
}

export function InboxFilters({ value, onChange }: Props) {
  const t = useT();
  const [searchInput, setSearchInput] = useState(value.search);
  const { data: channels } = useChannelSessions({ refetchInterval: 30_000 });
  const { data: setores } = useSetores();
  const { activeOrg } = useAuth();
  const { data: tagVocabulary } = useConversationTagVocabulary(activeOrg?.orgId ?? null);
  const { data: counts } = useConversationCounts(activeOrg?.orgId ?? null);

  const tabs = activeOrg
    ? visibleInboxTabs(activeOrg.role, activeOrg.visibility_mode)
    : INBOX_TABS.map((t) => t.value);
  const countFor: Partial<Record<InboxTab, number>> = {
    // `fila` é o nome novo; `unassigned` é o alias que a rota versionada mantém.
    // O `??` cobre a janela em que a página ainda lê um cache de react-query
    // gravado antes do deploy — sem ele o badge sumiria por alguns segundos.
    unassigned: counts?.fila ?? counts?.unassigned,
    // A aba do automático ganhou contador junto com o significado: ela deixou de
    // filtrar `ai_handling` (2 conversas) e passou a mostrar o que o robô conduz
    // (47, na instalação onde isto foi medido). Um número que existe na API e não
    // aparece na tela é trabalho feito que ninguém vê.
    ai: counts?.automatico,
    mine: counts?.mine,
    all: counts?.all,
    grupos: counts?.grupos,
  };
  // Filtrar por um número que saiu da lista (o operador acabou de excluir o
  // canal) deixa o inbox mostrando um subconjunto — às vezes vazio — sem nada na
  // tela dizendo que há filtro. O número some do dropdown junto com o canal, e o
  // alternador inteiro sumiria com ele se sobrasse menos de dois.
  const filtroForaDaLista =
    value.channel_session_id != null &&
    channels != null &&
    !channels.some((c) => c.id === value.channel_session_id);
  // Alternador só aparece com 2+ números — com um só não há o que alternar.
  const showChannelSwitch = (channels?.length ?? 0) >= 2 || filtroForaDaLista;

  // Debounce search input → propagate to parent.
  useEffect(() => {
    const t = setTimeout(() => {
      if (searchInput !== value.search) {
        onChange({ ...value, search: searchInput });
      }
    }, 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchInput]);

  // As visões que ganham um botão à vista. As outras (Todas, Arquivadas, Automático) continuam
  // todas no menu ▾ — decisão do dono de 2026-09-04 ("nenhuma visão invisível") não mudou: o chip
  // é atalho, o menu é a lista completa.
  const visoesEmChip = CHIPS_DE_VISAO.filter((tab) => tabs.includes(tab));
  const visaoAtual = INBOX_TABS.find((x) => x.value === value.tab) ?? {
    value: "unassigned" as const,
    label: "Fila",
  };
  const visaoAtualForaDosChips = !visoesEmChip.includes(value.tab);
  const contagemAtual = countFor[value.tab];
  const temContagemAtual = typeof contagemAtual === "number" && contagemAtual > 0;
  const temSeletores =
    showChannelSwitch || (setores?.length ?? 0) > 0 || (tagVocabulary?.length ?? 0) > 0;

  return (
    <div className="space-y-2 border-b border-border bg-background px-3 py-2">
      {/* A busca em pílula, como a do WhatsApp: fundo próprio, sem borda, canto todo redondo. */}
      <div className="relative">
        <MagnifyingGlass
          size={16}
          weight="regular"
          className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
          aria-hidden
        />
        <Input
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          placeholder={t("Buscar por nome, telefone ou mensagem…")}
          className="h-9 rounded-full border-transparent bg-muted pl-9 pr-4 text-sm hover:border-transparent"
          aria-label={t("Buscar conversas")}
        />
      </div>

      {/*
        CHIPS, e o menu ▾ ao lado. As visões continuam sendo UM menu completo (decisão de dono de
        2026-09-04, abaixo): a fileira de abas que rolava na horizontal escondia opção sem dizer que
        existia. Aqui os atalhos mais usados ficam à vista e NÃO rolam — se não couberem, a fileira
        quebra de linha. O gatilho do menu mantém o testid `visao-do-inbox` e diz, para quem lê a
        tela por leitor, qual é a visão atual e a contagem dela.
      */}
      <div className="flex flex-wrap items-center gap-1.5">
        {visoesEmChip.map((tab) => {
          const meta = INBOX_TABS.find((x) => x.value === tab)!;
          const count = countFor[tab];
          return (
            <ChipDoInbox
              key={tab}
              ativo={tab === value.tab}
              onClick={() => onChange({ ...value, tab })}
              data-testid={`chip-${tab}`}
            >
              {t(meta.label)}
              {typeof count === "number" && count > 0 && (
                <span className="text-[11px] tabular-nums opacity-80">{count}</span>
              )}
            </ChipDoInbox>
          );
        })}

        <ChipDoInbox
          ativo={value.onlyUnread}
          onClick={() => onChange({ ...value, onlyUnread: !value.onlyUnread })}
          data-testid="chip-nao-lidas"
        >
          {t("Não lidas")}
        </ChipDoInbox>

        {/*
          DROPDOWN com TODAS as visões — decisão de dono em 2026-09-04.

          A fila cabia em cinco rótulos e já vinha brigando com a largura: numa primeira versão as
          abas se sobrepunham ("FechadasAutomático"), e o conserto foi deixá-las rolar na
          horizontal. Rolagem horizontal esconde opção sem dizer que existe — quem não arrasta
          nunca descobre "Automático". Num menu, todas as visões ficam na mesma lista, com o
          contador ao lado. Os chips acima são atalhos; este menu é a lista que não esconde nada.
        */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <ChipDoInbox
              ativo={visaoAtualForaDosChips}
              data-testid="visao-do-inbox"
              aria-label={`${t("Todas as visões")} (${t(visaoAtual.label)})`}
            >
              {visaoAtualForaDosChips ? (
                <>
                  {t(visaoAtual.label)}
                  {temContagemAtual && (
                    <span className="text-[11px] tabular-nums opacity-80">{contagemAtual}</span>
                  )}
                </>
              ) : (
                <span className="sr-only">
                  {t(visaoAtual.label)}
                  {temContagemAtual ? ` ${contagemAtual}` : ""}
                </span>
              )}
              <CaretDown size={12} weight="bold" aria-hidden />
            </ChipDoInbox>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-48">
            {tabs.map((tab) => {
              const meta = INBOX_TABS.find((x) => x.value === tab)!;
              const count = countFor[tab];
              return (
                <DropdownMenuItem
                  key={tab}
                  onClick={() => onChange({ ...value, tab })}
                  className="justify-between gap-3"
                >
                  <span className={tab === value.tab ? "font-medium" : undefined}>
                    {t(meta.label)}
                  </span>
                  {typeof count === "number" && count > 0 && (
                    <span className="text-[10px] tabular-nums text-muted-foreground">{count}</span>
                  )}
                </DropdownMenuItem>
              );
            })}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {temSeletores && (
        <div className="flex flex-wrap items-center gap-1.5">
          {showChannelSwitch && (
            <Select
              value={value.channel_session_id ?? "all"}
              onValueChange={(v) =>
                onChange({ ...value, channel_session_id: v === "all" ? undefined : v })
              }
            >
              <SelectTrigger
                className={SELETOR_EM_PILULA}
                aria-label={t("Filtrar por número de WhatsApp")}
              >
                <SelectValue placeholder={t("Todos os números")} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t("Todos os números")}</SelectItem>
                {filtroForaDaLista && value.channel_session_id != null && (
                  <SelectItem value={value.channel_session_id}>{t("Número removido")}</SelectItem>
                )}
                {channels?.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {channelLabel(c)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}

          {(setores?.length ?? 0) > 0 && (
            <Select
              value={value.sector_id ?? "all"}
              onValueChange={(v) => onChange({ ...value, sector_id: v === "all" ? undefined : v })}
            >
              <SelectTrigger className={SELETOR_EM_PILULA} aria-label={t("Filtrar por setor")}>
                <SelectValue placeholder={t("Todos os setores")} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t("Todos os setores")}</SelectItem>
                {setores?.map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    <span className="flex items-center gap-2">
                      <span
                        className={cn("size-2 shrink-0 rounded-full", CLASSE_DE_COR[s.color]?.ponto)}
                        aria-hidden
                      />
                      {s.name}
                    </span>
                  </SelectItem>
                ))}
                <SelectItem value="sem">{t("Sem setor")}</SelectItem>
              </SelectContent>
            </Select>
          )}

          {(tagVocabulary?.length ?? 0) > 0 && (
            <Select
              value={value.tag ?? "all"}
              onValueChange={(v) => onChange({ ...value, tag: v === "all" ? undefined : v })}
            >
              <SelectTrigger className={SELETOR_EM_PILULA} aria-label={t("Filtrar por tag")}>
                <SelectValue placeholder={t("Todas as tags")} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t("Todas as tags")}</SelectItem>
                {tagVocabulary?.map((marcador) => (
                  <SelectItem key={marcador.nome} value={marcador.nome}>
                    <span className="flex items-center gap-2">
                      <span
                        className={cn(
                          "size-2 shrink-0 rounded-full",
                          CLASSE_DE_COR[marcador.cor].ponto,
                        )}
                        aria-hidden
                      />
                      {marcador.nome}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>
      )}

      {value.tab === "grupos" && <ImportarGrupos />}
    </div>
  );
}
