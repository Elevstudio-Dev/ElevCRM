"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useT } from "@/hooks/i18n/useT";
import { Funnel, Plus, MagnifyingGlass, UploadSimple } from "@/lib/ui/icons";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useContactList } from "@/hooks/contacts/useContactList";
import { useTiposForaDoFunil } from "@/hooks/contatos/useForaDoFunil";
import { ForaDoFunilDialog, type ContatoDoDialogo } from "@/components/contacts/ForaDoFunilDialog";
import { rotuloDoContato } from "@/lib/contacts/rotulo-do-contato";
import type { Contact } from "@/lib/types/contacts";
import { ContactsTable } from "@/components/contacts/ContactsTable";
import { NewContactDialog } from "@/components/contacts/NewContactDialog";
import { ImportContactsDialog } from "@/components/contacts/ImportContactsDialog";
import { EmptyContacts } from "@/components/empty";
import type { ContactOrderBy } from "@/lib/schemas/contacts";

const SOURCE_OPTIONS = [
  { value: undefined, label: "Todas as origens" },
  { value: "manual", label: "Manual" },
  { value: "whatsapp", label: "WhatsApp" },
  { value: "nuvemshop", label: "Nuvemshop" },
  { value: "import_csv", label: "Importado (CSV)" },
];

const PAGE_SIZE_OPTIONS = [25, 50, 100] as const;

export function ContactsListClient() {
  const t = useT();
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [tag, setTag] = useState<string | undefined>(undefined);
  const [source, setSource] = useState<string | undefined>(undefined);
  const [orderBy, setOrderBy] = useState<ContactOrderBy>("last_activity_at");
  const [orderDir, setOrderDir] = useState<"asc" | "desc">("desc");
  const [limit, setLimit] = useState<number>(25);
  const [createOpen, setCreateOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  // "Fora do funil": equipe, prestador, parceiro. Filtro da lista + seleção em massa + o diálogo de marcar.
  const [funil, setFunil] = useState<{ fora_do_funil?: "sim" | "nao"; tipo_id?: string }>({});
  const [selecionados, setSelecionados] = useState<ReadonlySet<string>>(new Set());
  const [dialogo, setDialogo] = useState<{ contatos: ContatoDoDialogo[]; marcar: boolean } | null>(null);
  const tipos = useTiposForaDoFunil();

  useEffect(() => {
    const timer = setTimeout(() => setSearch(searchInput), 250);
    return () => clearTimeout(timer);
  }, [searchInput]);

  const filters = useMemo(
    () => ({ search, tag, source, ...funil, order_by: orderBy, order_dir: orderDir, limit }),
    [search, tag, source, funil, orderBy, orderDir, limit],
  );
  const q = useContactList(filters);

  const allContacts = useMemo(
    () => q.data?.pages.flatMap((p) => p.data) ?? [],
    [q.data],
  );

  const nomeDoContato = useCallback((c: Contact) => rotuloDoContato(c, t), [t]);
  const selecionadosCarregados = useMemo(
    () => allContacts.filter((c) => selecionados.has(c.id)),
    [allContacts, selecionados],
  );
  const alternar = useCallback((id: string) => {
    setSelecionados((atual) => {
      const novo = new Set(atual);
      if (novo.has(id)) novo.delete(id);
      else novo.add(id);
      return novo;
    });
  }, []);
  const alternarTodos = useCallback(
    (marcarTodos: boolean) => {
      setSelecionados((atual) => {
        const novo = new Set(atual);
        for (const c of allContacts) {
          if (marcarTodos) novo.add(c.id);
          else novo.delete(c.id);
        }
        return novo;
      });
    },
    [allContacts],
  );
  const abrirDialogo = useCallback(
    (lista: Contact[], marcar: boolean) => {
      // So entram os que MUDARIAM de estado: pedir "marcar" para quem ja esta marcado nao e acao nenhuma.
      const quem = lista.filter((c) => (c.fora_do_funil_em ? !marcar : marcar));
      if (quem.length === 0) return;
      setDialogo({
        contatos: quem.map((c) => ({ id: c.id, nome: nomeDoContato(c), tipoId: c.fora_do_funil_tipo_id ?? null })),
        marcar,
      });
    },
    [nomeDoContato],
  );
  const filtroDoFunilNoRotulo = funil.tipo_id
    ? (tipos.data?.find((x) => x.id === funil.tipo_id)?.nome ?? t("Tipo"))
    : funil.fora_do_funil === "sim"
      ? t("Fora do funil")
      : funil.fora_do_funil === "nao"
        ? t("Clientes")
        : t("Todos");

  const tagOptions = useMemo(() => {
    const set = new Set<string>();
    for (const c of allContacts) for (const tag of c.tags) set.add(tag);
    return Array.from(set).sort();
  }, [allContacts]);

  const handleSort = useCallback(
    (column: ContactOrderBy) => {
      if (column === orderBy) {
        setOrderDir((d) => (d === "asc" ? "desc" : "asc"));
      } else {
        setOrderBy(column);
        setOrderDir(column === "display_name" ? "asc" : "desc");
      }
    },
    [orderBy],
  );

  return (
    <div className="space-y-4 p-6">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight">{t("Contatos")}</h1>
          <p className="text-sm text-muted-foreground">
            {t("Customer 360 — busque, filtre e gerencie contatos.")}
          </p>
        </div>
        {/*
          A estrutura é a da main (o "Importar CSV" do PR #313); o `shrink-0`
          vem do PR #267, e vale para os DOIS botões agora: numa tela de 390px
          uma linha de dois botões sem isso comprime os rótulos.
        */}
        <div className="flex shrink-0 items-center gap-2">
          <Button variant="outline" onClick={() => setImportOpen(true)}>
            <UploadSimple size={16} weight="bold" aria-hidden />
            <span>{t("Importar CSV")}</span>
          </Button>
          <Button onClick={() => setCreateOpen(true)}>
            <Plus size={16} weight="bold" aria-hidden />
            <span>{t("Novo contato")}</span>
          </Button>
        </div>
      </header>

      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-surface p-2">
        <div className="relative w-full sm:w-72">
          <MagnifyingGlass
            size={16}
            className="absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <Input
            type="search"
            placeholder={t("Buscar por nome, email ou telefone…")}
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            className="h-9 w-full pl-8"
          />
        </div>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm" disabled={tagOptions.length === 0}>
              {tag ? `${t("Tag")}: ${tag}` : `${t("Tag")}: ${t("todas")}`}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuLabel>{t("Tag")}</DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => setTag(undefined)}>{t("Todas")}</DropdownMenuItem>
            {tagOptions.map((tagOption) => (
              <DropdownMenuItem key={tagOption} onClick={() => setTag(tagOption)}>
                {tagOption}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm">
              {t(SOURCE_OPTIONS.find((s) => s.value === source)?.label ?? "Origem")}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            {SOURCE_OPTIONS.map((s) => (
              <DropdownMenuItem key={s.label} onClick={() => setSource(s.value)}>
                {t(s.label)}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm">
              {limit} {t("por página")}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuLabel>{t("Itens por página")}</DropdownMenuLabel>
            <DropdownMenuSeparator />
            {PAGE_SIZE_OPTIONS.map((n) => (
              <DropdownMenuItem key={n} onClick={() => setLimit(n)}>
                {n}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm" data-testid="filtro-do-funil">
              <Funnel size={14} aria-hidden /> {t("Funil")}: {filtroDoFunilNoRotulo}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuLabel>{t("Funil")}</DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => setFunil({})}>{t("Todos")}</DropdownMenuItem>
            <DropdownMenuItem onClick={() => setFunil({ fora_do_funil: "nao" })}>{t("Clientes")}</DropdownMenuItem>
            <DropdownMenuItem data-testid="filtro-fora-do-funil" onClick={() => setFunil({ fora_do_funil: "sim" })}>
              {t("Fora do funil")}
            </DropdownMenuItem>
            {(tipos.data ?? []).map((tp) => (
              <DropdownMenuItem key={tp.id} onClick={() => setFunil({ fora_do_funil: "sim", tipo_id: tp.id })}>
                {t("Fora do funil")} · {tp.nome}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>

        {(search || tag || source || funil.fora_do_funil) && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setSearchInput("");
              setSearch("");
              setTag(undefined);
              setSource(undefined);
              setFunil({});
            }}
          >
            {t("Limpar filtros")}
          </Button>
        )}
      </div>

      {q.isLoading ? (
        <div className="space-y-2">
          {[1, 2, 3, 4, 5].map((i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      ) : q.isError ? (
        <Card className="p-6 text-center">
          <p className="text-sm text-error-fg">{t("Erro ao carregar contatos.")}</p>
          <Button
            size="sm"
            variant="outline"
            className="mt-2"
            onClick={() => q.refetch()}
          >
            {t("Tentar novamente")}
          </Button>
        </Card>
      ) : allContacts.length === 0 ? (
        <Card className="p-2">
          <EmptyContacts />
        </Card>
      ) : (
        <>
          {selecionados.size > 0 && (
            <div
              data-testid="barra-de-selecao-de-contatos"
              className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-surface-elevated p-2 text-sm"
            >
              <span className="px-1 font-medium">
                {selecionados.size} {selecionados.size === 1 ? t("selecionado") : t("selecionados")}
              </span>
              {selecionadosCarregados.some((c) => !c.fora_do_funil_em) && (
                <Button
                  size="sm"
                  variant="outline"
                  data-testid="marcar-selecionados-fora-do-funil"
                  onClick={() => abrirDialogo(selecionadosCarregados, true)}
                >
                  <Funnel size={14} aria-hidden /> {t("Marcar como fora do funil")}
                </Button>
              )}
              {selecionadosCarregados.some((c) => c.fora_do_funil_em) && (
                <Button size="sm" variant="outline" onClick={() => abrirDialogo(selecionadosCarregados, false)}>
                  {t("Voltar ao funil")}
                </Button>
              )}
              <Button size="sm" variant="ghost" onClick={() => setSelecionados(new Set())}>
                {t("Limpar seleção")}
              </Button>
            </div>
          )}
          <Card className="overflow-hidden">
            <ContactsTable
              contacts={allContacts}
              orderBy={orderBy}
              orderDir={orderDir}
              onSort={handleSort}
              selecionados={selecionados}
              onAlternar={alternar}
              onAlternarTodos={alternarTodos}
              onForaDoFunil={(c) => abrirDialogo([c], !c.fora_do_funil_em)}
            />
          </Card>
          <div className="flex flex-col items-center gap-2 sm:flex-row sm:justify-between">
            <p className="text-sm text-muted-foreground">
              {allContacts.length} {allContacts.length === 1 ? t("contato") : t("contatos")}
              {q.hasNextPage ? ` ${t("carregados — há mais resultados")}` : ""}
            </p>
            {q.hasNextPage && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => q.fetchNextPage()}
                disabled={q.isFetchingNextPage}
              >
                {q.isFetchingNextPage ? t("Carregando…") : t("Carregar mais")}
              </Button>
            )}
          </div>
        </>
      )}

      <NewContactDialog open={createOpen} onOpenChange={setCreateOpen} />
      <ImportContactsDialog open={importOpen} onOpenChange={setImportOpen} />
      {dialogo && (
        <ForaDoFunilDialog
          // Um dialogo novo por selecao: o tipo pre-escolhido nasce do contato aberto, nunca do anterior.
          key={`${dialogo.marcar}:${dialogo.contatos.map((c) => c.id).join(",")}`}
          contatos={dialogo.contatos}
          marcar={dialogo.marcar}
          open
          onOpenChange={(aberto) => !aberto && setDialogo(null)}
          onConcluido={() => setSelecionados(new Set())}
        />
      )}
    </div>
  );
}
