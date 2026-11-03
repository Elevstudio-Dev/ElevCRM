"use client";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { format, isToday } from "date-fns";

import { MenuDeMencao } from "@/components/mencoes/MenuDeMencao";
import { TextoComMencoes } from "@/components/mencoes/TextoComMencoes";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useUser } from "@/hooks/auth/AuthProvider";
import {
  useAbrirConversaDireta,
  useCanaisDaEquipe,
  useEnviarMensagemDaEquipe,
  useMarcarCanalLido,
  useMensagensDoCanal,
} from "@/hooks/chat-interno/useChatInterno";
import { useLocaleDeData } from "@/hooks/i18n/useLocaleDeData";
import { useT } from "@/hooks/i18n/useT";
import { useAssignableMembers } from "@/hooks/inbox/useAssignableMembers";
import { useMarcaveisDoCanal } from "@/hooks/mencoes/useMarcaveis";
import { useMencoes } from "@/hooks/mencoes/useMencoes";
import { ROTULO_DO_PAPEL, type Role } from "@/lib/auth/types";
import type { CanalDaEquipe } from "@/lib/chat-interno/canais";
import { candidatosDaEquipe, mencaoDaEquipe } from "@/lib/mencoes/candidatos";
import { CLASSE_DE_COR } from "@/lib/marcadores/cores";
import type { CorDeMarcador } from "@/lib/schemas/settings";
import { ChatsCircle, PaperPlaneTilt, Plus } from "@/lib/ui/icons";
import { cn } from "@/lib/utils";

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  /** Canal a abrir ao montar (o clique num aviso). */
  canalInicial?: string | null;
}

function iniciais(nome: string): string {
  return nome
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((p) => p[0] ?? "")
    .join("")
    .toUpperCase();
}

/**
 * O CHAT DA EQUIPE — um painel à direita, como uma gaveta: canais à esquerda
 * (Geral, os setores, as pessoas), o fio e o campo de escrever à direita.
 *
 * Não é um inbox: ninguém "assume" nem "arquiva". É onde a recepção pergunta
 * ao financeiro se o boleto caiu, sem sair da conversa com o cliente.
 */
export function PainelDoChat({ open, onOpenChange, canalInicial }: Props) {
  const t = useT();
  const canais = useCanaisDaEquipe({ enabled: open });
  const [canalId, setCanalId] = useState<string | null>(canalInicial ?? null);

  const lista = useMemo(() => canais.data ?? [], [canais.data]);
  // Sem escolha, abre o Geral — é a sala em que todo mundo está.
  const canalAtivo = useMemo(
    () => lista.find((c) => c.id === canalId) ?? lista.find((c) => c.kind === "geral") ?? lista[0] ?? null,
    [lista, canalId],
  );

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="flex w-full flex-row gap-0 p-0 sm:max-w-3xl"
        data-testid="painel-do-chat"
      >
        <SheetTitle className="sr-only">{t("Chat da equipe")}</SheetTitle>
        <ListaDeCanais
          canais={lista}
          carregando={canais.isLoading}
          ativoId={canalAtivo?.id ?? null}
          onEscolher={setCanalId}
          className={cn("w-full sm:w-64", canalAtivo && "hidden sm:flex")}
        />
        {canalAtivo ? (
          <Fio canal={canalAtivo} onVoltar={() => setCanalId(null)} />
        ) : (
          <div className="hidden flex-1 items-center justify-center text-sm text-muted-foreground sm:flex">
            {canais.isLoading ? t("Carregando…") : t("Escolha um canal")}
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}

function ListaDeCanais({
  canais,
  carregando,
  ativoId,
  onEscolher,
  className,
}: {
  canais: CanalDaEquipe[];
  carregando: boolean;
  ativoId: string | null;
  onEscolher: (id: string) => void;
  className?: string;
}) {
  const t = useT();
  const eu = useUser();
  const membros = useAssignableMembers(true);
  const abrirDireta = useAbrirConversaDireta();
  const [escolhendo, setEscolhendo] = useState(false);

  const jaTemDireta = new Set(canais.filter((c) => c.kind === "direto").map((c) => c.other_user_id));
  const pessoas = (membros.data ?? []).filter((m) => m.user_id !== eu.id && !jaTemDireta.has(m.user_id));

  return (
    <div className={cn("flex h-full flex-col border-r", className)}>
      <div className="flex h-14 items-center gap-2 border-b px-4">
        <ChatsCircle size={18} weight="duotone" aria-hidden />
        <span className="font-semibold">{t("Chat da equipe")}</span>
      </div>
      <nav className="flex-1 overflow-y-auto p-2" aria-label={t("Canais")}>
        {carregando && canais.length === 0 ? (
          <p className="px-2 py-3 text-xs text-muted-foreground">{t("Carregando…")}</p>
        ) : (
          <ul className="space-y-0.5">
            {canais.map((c) => (
              <li key={c.id}>
                <button
                  type="button"
                  onClick={() => onEscolher(c.id)}
                  aria-current={c.id === ativoId ? "true" : undefined}
                  data-testid="canal-da-equipe"
                  className={cn(
                    "flex w-full items-center gap-2.5 rounded-md px-2 py-2 text-left transition-colors",
                    c.id === ativoId ? "bg-accent text-accent-foreground" : "hover:bg-accent/50",
                  )}
                >
                  <IconeDoCanal canal={c} />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center justify-between gap-2">
                      <span className={cn("truncate text-sm", c.unread > 0 && "font-semibold")}>{c.name}</span>
                      {c.unread > 0 && (
                        <span className="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-semibold text-primary-foreground">
                          {c.unread > 99 ? "99+" : c.unread}
                        </span>
                      )}
                    </span>
                    {c.last_message && (
                      <span className="block truncate text-xs text-muted-foreground">
                        {c.last_message.sender_name ? `${c.last_message.sender_name.split(" ")[0]}: ` : ""}
                        {c.last_message.body}
                      </span>
                    )}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </nav>
      <div className="border-t p-2">
        {escolhendo ? (
          <Select
            onValueChange={(userId) => {
              setEscolhendo(false);
              abrirDireta.mutate(userId, { onSuccess: (r) => onEscolher(r.data.id) });
            }}
            onOpenChange={(aberto) => !aberto && setEscolhendo(false)}
            open
          >
            <SelectTrigger className="h-9" aria-label={t("Com quem?")}>
              <SelectValue placeholder={t("Com quem?")} />
            </SelectTrigger>
            <SelectContent>
              {pessoas.length === 0 ? (
                <div className="px-3 py-2 text-xs text-muted-foreground">{t("Você já conversa com todo mundo.")}</div>
              ) : (
                pessoas.map((p) => (
                  <SelectItem key={p.user_id} value={p.user_id}>
                    {p.full_name || t("Membro")}
                  </SelectItem>
                ))
              )}
            </SelectContent>
          </Select>
        ) : (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="w-full gap-1"
            onClick={() => setEscolhendo(true)}
            disabled={abrirDireta.isPending}
          >
            <Plus size={14} aria-hidden />
            {t("Conversa direta")}
          </Button>
        )}
      </div>
    </div>
  );
}

function IconeDoCanal({ canal }: { canal: CanalDaEquipe }) {
  if (canal.kind === "geral") {
    return (
      <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary/15 text-primary">
        <ChatsCircle size={16} weight="fill" aria-hidden />
      </span>
    );
  }
  if (canal.kind === "setor") {
    const cor = CLASSE_DE_COR[(canal.sector_color ?? "cinza") as CorDeMarcador] ?? CLASSE_DE_COR.cinza;
    return (
      <span className={cn("flex size-8 shrink-0 items-center justify-center rounded-full", cor.fundo, cor.texto)}>
        <span className={cn("size-2.5 rounded-full", cor.ponto)} aria-hidden />
      </span>
    );
  }
  return (
    <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-semibold">
      {iniciais(canal.name)}
    </span>
  );
}

function Fio({ canal, onVoltar }: { canal: CanalDaEquipe; onVoltar: () => void }) {
  const t = useT();
  const eu = useUser();
  const localeDaData = useLocaleDeData();
  const mensagens = useMensagensDoCanal(canal.id);
  const enviar = useEnviarMensagemDaEquipe(canal.id);
  const marcarLido = useMarcarCanalLido();
  const [texto, setTexto] = useState("");
  const fimRef = useRef<HTMLDivElement | null>(null);
  const taRef = useRef<HTMLTextAreaElement | null>(null);

  // O `@`: quem enxerga este canal. Na conversa direta não há a quem marcar (são
  // duas pessoas), então o recurso fica desligado em vez de oferecer um `@` mudo.
  const marcaveis = useMarcaveisDoCanal(canal.id, canal.kind !== "direto");
  const candidatos = useMemo(
    () => candidatosDaEquipe(marcaveis.data ?? [], (r) => t(ROTULO_DO_PAPEL[r as Role] ?? r)),
    [marcaveis.data, t],
  );
  const mencao = useMencoes({ candidatos, paraMencao: mencaoDaEquipe, texto, setTexto, taRef });

  const lista = mensagens.data ?? [];
  const ultimaId = lista[lista.length - 1]?.id ?? null;

  // Lido: ao abrir o canal e a cada mensagem nova que chega com ele aberto.
  useEffect(() => {
    marcarLido.mutate(canal.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canal.id, ultimaId]);

  useEffect(() => {
    fimRef.current?.scrollIntoView({ block: "end" });
  }, [ultimaId, canal.id]);

  function submeter() {
    const body = texto.trim();
    if (!body || enviar.isPending) return;
    // As marcações saem do que o texto AINDA cita, não do que ficou no estado.
    const mentions = mencao.paraEnviar(body);
    setTexto("");
    mencao.limpar();
    enviar.mutate(
      { body, mentions },
      {
        onError: () => {
          setTexto(body);
          mencao.restaurar(mentions);
        },
      },
    );
    requestAnimationFrame(() => taRef.current?.focus());
  }
  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    // Com a lista do `@` aberta, as setas, o Enter, o Tab e o Esc são dela.
    if (mencao.onKeyDown(e)) return;
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submeter();
    }
  }

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col" data-testid="fio-do-chat">
      <div className="flex h-14 items-center gap-2 border-b px-4">
        <Button type="button" variant="ghost" size="sm" className="sm:hidden" onClick={onVoltar}>
          {t("Canais")}
        </Button>
        <IconeDoCanal canal={canal} />
        <div className="min-w-0">
          <div className="truncate font-semibold">{canal.name}</div>
          <div className="text-[11px] text-muted-foreground">
            {canal.kind === "geral" ? t("Toda a equipe") : canal.kind === "setor" ? t("Quem está no setor e a gestão") : t("Só vocês dois")}
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-3">
        {mensagens.isLoading ? (
          <p className="text-center text-xs text-muted-foreground">{t("Carregando…")}</p>
        ) : lista.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">{t("Ninguém escreveu ainda. Seja a primeira pessoa.")}</p>
        ) : (
          <ul className="space-y-1.5">
            {lista.map((m, i) => {
              const minha = m.sender_user_id === eu.id;
              const anterior = lista[i - 1];
              const mesmoAutor = anterior?.sender_user_id === m.sender_user_id;
              const quando = new Date(m.created_at);
              return (
                <li key={m.id} className={cn("flex", minha ? "justify-end" : "justify-start")} data-testid="mensagem-da-equipe">
                  <div
                    className={cn(
                      "max-w-[80%] rounded-2xl px-3 py-1.5 text-sm shadow-[var(--chat-bolha-sombra)]",
                      minha ? "bg-[var(--chat-out)] text-[var(--chat-out-fg,inherit)]" : "bg-[var(--chat-in)]",
                    )}
                  >
                    {!minha && !mesmoAutor && (
                      <div className="text-[11px] font-semibold text-primary">{m.sender_name ?? t("Colega")}</div>
                    )}
                    <TextoComMencoes texto={m.body} mencoes={m.mentions} euId={eu.id} className="block" />
                    <div className="mt-0.5 text-right text-[10px] text-muted-foreground tabular-nums">
                      {isToday(quando) ? format(quando, "HH:mm", { locale: localeDaData }) : format(quando, "dd/MM HH:mm", { locale: localeDaData })}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        <div ref={fimRef} />
      </div>

      <div className="relative border-t p-2">
        <MenuDeMencao
          aberto={mencao.aberto}
          itens={mencao.itens}
          ativo={mencao.ativo}
          onEscolher={mencao.escolher}
          onHover={mencao.onHover}
          detalheDeTodos={t("Avisa quem está neste canal")}
          className="bottom-16 left-2"
        />
        <div className="flex items-end gap-2">
          <div className="flex flex-1 items-end rounded-3xl bg-[var(--chat-in)] px-3 py-1 shadow-[var(--chat-bolha-sombra)]">
            <textarea
              ref={taRef}
              value={texto}
              onChange={mencao.onChange}
              onSelect={mencao.onSelect}
              onKeyDown={onKeyDown}
              rows={1}
              placeholder={t("Escreva para a equipe…")}
              aria-label={t("Mensagem para a equipe")}
              className="min-h-9 max-h-32 flex-1 resize-none border-0 bg-transparent py-2 text-sm placeholder:text-muted-foreground focus:outline-hidden focus:ring-0"
            />
          </div>
          <Button
            type="button"
            size="icon"
            className="size-10 shrink-0 rounded-full"
            onClick={submeter}
            disabled={!texto.trim() || enviar.isPending}
            aria-label={t("Enviar")}
          >
            <PaperPlaneTilt size={16} weight="fill" aria-hidden />
          </Button>
        </div>
      </div>
    </div>
  );
}
