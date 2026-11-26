"use client";
import Link from "next/link";
import { useMemo, useState } from "react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useAcaoDaCampanha, useCampanha } from "@/hooks/campanhas/useCampanhas";
import { useT } from "@/hooks/i18n/useT";
import { useTagDeIdioma } from "@/hooks/i18n/useLocaleDeData";
import type { Situacao } from "@/lib/campanhas/situacao";
import { ArrowLeft } from "@/lib/ui/icons";
import { cn } from "@/lib/utils";

import { ROTULO_DA_SITUACAO, ROTULO_DO_ESTADO, dataHora, jaReceberam, totalDaCampanha } from "../_components/rotulos";

const ORDEM_DOS_FILTROS: Situacao[] = [
  "agendado",
  "enviado",
  "respondeu",
  "pediu_para_sair",
  "conversou_antes",
  "falhou",
  "pausado",
  "cancelado",
  "enviando",
];

export function CampanhaClient({ id }: { id: string }) {
  const t = useT();
  const tagDoIdioma = useTagDeIdioma();
  const campanha = useCampanha(id);
  const acao = useAcaoDaCampanha(id);
  const [filtro, setFiltro] = useState<Situacao | null>(null);
  const [confirmarCancelar, setConfirmarCancelar] = useState(false);

  const visiveis = useMemo(() => {
    const todos = campanha.data?.destinatarios ?? [];
    return filtro ? todos.filter((d) => d.situacao === filtro) : todos;
  }, [campanha.data, filtro]);

  if (campanha.isLoading) {
    return (
      <div className="space-y-3 p-6">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }
  if (campanha.isError || !campanha.data) {
    return (
      <div className="p-6">
        <Card className="p-6 text-sm text-muted-foreground">{t("Campanha não encontrada.")}</Card>
      </div>
    );
  }

  const c = campanha.data;
  const estado = ROTULO_DO_ESTADO[c.estado];
  const total = totalDaCampanha(c.contagem);

  return (
    <div className="space-y-4 p-6">
      <Link
        href="/app/campanhas"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-text focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
      >
        <ArrowLeft size={14} aria-hidden />
        {t("Campanhas")}
      </Link>

      <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight">{c.nome}</h1>
            <Badge variant={estado.variante}>{t(estado.texto)}</Badge>
          </div>
          <p className="text-sm text-muted-foreground">
            {t("Sai pelo número")} {c.canal_nome ?? "—"} · {c.ritmo.por_dia} {t("por dia")} · {t("das")}{" "}
            {c.ritmo.hora_inicio}h {t("às")} {c.ritmo.hora_fim}h
          </p>
        </div>
        <div className="flex shrink-0 gap-2">
          {c.estado === "enviando" ? (
            <Button variant="outline" disabled={acao.isPending} onClick={() => acao.mutate("pausar")}>
              {t("Pausar")}
            </Button>
          ) : null}
          {c.estado === "pausada" ? (
            <Button disabled={acao.isPending} onClick={() => acao.mutate("retomar")}>
              {t("Retomar")}
            </Button>
          ) : null}
          {c.estado === "enviando" || c.estado === "pausada" ? (
            <Button variant="outline" disabled={acao.isPending} onClick={() => setConfirmarCancelar(true)}>
              {t("Cancelar campanha")}
            </Button>
          ) : null}
        </div>
      </header>

      <Card className="space-y-3 p-4">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Numero rotulo={t("Receberam")} valor={jaReceberam(c.contagem)} de={total} />
          <Numero rotulo={t("Responderam")} valor={c.contagem.respondeu} />
          <Numero rotulo={t("Pediram para sair")} valor={c.contagem.pediu_para_sair} />
          <Numero rotulo={t("Na fila")} valor={c.contagem.agendado + c.contagem.enviando} />
        </div>
        {c.estado === "enviando" && c.proximo_envio ? (
          <p className="text-xs text-muted-foreground">
            {t("Próximo envio")}: {dataHora(c.proximo_envio, tagDoIdioma)}
          </p>
        ) : null}
        <details className="text-sm">
          <summary className="cursor-pointer text-muted-foreground">{t("Objetivo e público")}</summary>
          <p className="mt-2 whitespace-pre-wrap">{c.objetivo}</p>
          {c.imagem_url ? (
            // eslint-disable-next-line @next/next/no-img-element -- link assinado temporário do Storage
            <img
              src={c.imagem_url}
              alt={t("Imagem da campanha")}
              className="mt-2 max-h-64 w-auto rounded-md border border-border"
            />
          ) : null}
          <div className="mt-2 flex flex-wrap gap-1">
            {c.etiquetas.map((e) => (
              <Badge key={e} variant="outline" className="font-normal">
                {e}
              </Badge>
            ))}
          </div>
        </details>
      </Card>

      <div className="flex flex-wrap gap-1" role="group" aria-label={t("Filtrar por situação")}>
        <FiltroBotao ativo={filtro === null} onClick={() => setFiltro(null)}>
          {t("Todos")} <span className="tabular-nums">{total}</span>
        </FiltroBotao>
        {ORDEM_DOS_FILTROS.filter((s) => c.contagem[s] > 0).map((s) => (
          <FiltroBotao key={s} ativo={filtro === s} onClick={() => setFiltro(s)}>
            {t(ROTULO_DA_SITUACAO[s].texto)} <span className="tabular-nums">{c.contagem[s]}</span>
          </FiltroBotao>
        ))}
      </div>

      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full min-w-[560px] text-sm">
          <thead className="bg-surface-elevated text-left text-xs text-muted-foreground">
            <tr>
              <th className="px-3 py-2 font-medium">{t("Contato")}</th>
              <th className="px-3 py-2 font-medium">{t("Situação")}</th>
              <th className="px-3 py-2 font-medium">{t("Quando")}</th>
            </tr>
          </thead>
          <tbody>
            {visiveis.map((d) => {
              const s = ROTULO_DA_SITUACAO[d.situacao];
              const quando =
                d.situacao === "respondeu"
                  ? d.respondeu_em
                  : d.enviado_em ?? d.agendado_para ?? null;
              return (
                <tr key={d.contact_id} className="border-t border-border">
                  <td className="px-3 py-2">
                    <Link
                      href={`/app/contacts/${d.contact_id}`}
                      className="font-medium hover:underline focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      {d.nome}
                    </Link>
                    <div className="text-xs tabular-nums text-muted-foreground">{d.telefone ?? "—"}</div>
                  </td>
                  <td className="px-3 py-2">
                    <Badge variant={s.variante}>{t(s.texto)}</Badge>
                    {d.erro ? <div className="mt-1 max-w-xs truncate text-xs text-error-fg">{d.erro}</div> : null}
                  </td>
                  <td className="px-3 py-2 tabular-nums text-muted-foreground">{dataHora(quando, tagDoIdioma)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <AlertDialog open={confirmarCancelar} onOpenChange={setConfirmarCancelar}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("Cancelar a campanha?")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("Quem ainda não recebeu sai da fila e não recebe mais. Quem já recebeu continua a conversa normalmente. Não dá para desfazer.")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("Voltar")}</AlertDialogCancel>
            <AlertDialogAction onClick={() => acao.mutate("cancelar")}>{t("Cancelar campanha")}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function Numero({ rotulo, valor, de }: { rotulo: string; valor: number; de?: number }) {
  return (
    <div>
      <div className="text-xs text-muted-foreground">{rotulo}</div>
      <div className="text-xl font-semibold tabular-nums">
        {valor}
        {de !== undefined ? <span className="text-sm font-normal text-muted-foreground"> / {de}</span> : null}
      </div>
    </div>
  );
}

function FiltroBotao({ ativo, onClick, children }: { ativo: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={ativo}
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring",
        ativo ? "border-accent bg-accent-soft text-accent" : "border-border text-muted-foreground hover:bg-surface-elevated",
      )}
    >
      {children}
    </button>
  );
}
