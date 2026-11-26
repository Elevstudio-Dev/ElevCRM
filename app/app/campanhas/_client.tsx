"use client";
import Link from "next/link";
import { useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useCampanhas } from "@/hooks/campanhas/useCampanhas";
import { useT } from "@/hooks/i18n/useT";
import { useTagDeIdioma } from "@/hooks/i18n/useLocaleDeData";
import { Megaphone, Plus } from "@/lib/ui/icons";

import { NovaCampanhaDialog } from "./_components/NovaCampanhaDialog";
import { ROTULO_DO_ESTADO, dataHora, jaReceberam, totalDaCampanha } from "./_components/rotulos";

export function CampanhasClient() {
  const t = useT();
  const tagDoIdioma = useTagDeIdioma();
  const campanhas = useCampanhas();
  const [nova, setNova] = useState(false);

  return (
    <div className="space-y-4 p-6">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight">{t("Campanhas")}</h1>
          <p className="text-sm text-muted-foreground">
            {t("Uma mensagem da IA para cada pessoa de uma lista, no ritmo que protege o número.")}
          </p>
        </div>
        <Button className="shrink-0" onClick={() => setNova(true)}>
          <Plus size={16} weight="bold" aria-hidden />
          <span>{t("Nova campanha")}</span>
        </Button>
      </header>

      {campanhas.isLoading ? (
        <div className="space-y-2">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      ) : campanhas.isError ? (
        <Card className="p-6 text-sm text-muted-foreground">
          {t("Não foi possível carregar as campanhas. Tente de novo em instantes.")}
        </Card>
      ) : (campanhas.data ?? []).length === 0 ? (
        <Card className="flex flex-col items-center gap-3 p-10 text-center">
          <Megaphone size={32} className="text-muted-foreground" aria-hidden />
          <div className="space-y-1">
            <p className="font-medium">{t("Nenhuma campanha ainda")}</p>
            <p className="max-w-md text-sm text-muted-foreground">
              {t("Escolha as etiquetas do público, o número de saída e o objetivo. A IA escreve cada mensagem e os envios saem devagar, em horário comercial.")}
            </p>
          </div>
          <Button onClick={() => setNova(true)}>{t("Nova campanha")}</Button>
        </Card>
      ) : (
        <ul className="space-y-2">
          {(campanhas.data ?? []).map((c) => {
            const estado = ROTULO_DO_ESTADO[c.estado];
            const total = totalDaCampanha(c.contagem);
            const receberam = jaReceberam(c.contagem);
            const pct = total > 0 ? Math.round((receberam / total) * 100) : 0;
            return (
              <li key={c.id}>
                <Link
                  href={`/app/campanhas/${c.id}`}
                  className="block rounded-lg border border-border bg-surface p-4 transition-colors hover:bg-surface-elevated focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="truncate font-medium">{c.nome}</span>
                      <Badge variant={estado.variante}>{t(estado.texto)}</Badge>
                    </div>
                    <span className="text-xs text-muted-foreground">
                      {c.estado === "enviando" && c.proximo_envio
                        ? `${t("Próximo envio")}: ${dataHora(c.proximo_envio, tagDoIdioma)}`
                        : `${t("Criada em")} ${dataHora(c.criada_em, tagDoIdioma)}`}
                    </span>
                  </div>
                  <div className="mt-2 flex flex-wrap gap-1">
                    {c.etiquetas.map((e) => (
                      <Badge key={e} variant="outline" className="font-normal">
                        {e}
                      </Badge>
                    ))}
                  </div>
                  <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-surface-elevated" aria-hidden>
                    <div className="h-full rounded-full bg-accent" style={{ width: `${pct}%` }} />
                  </div>
                  <p className="mt-2 text-sm tabular-nums text-muted-foreground">
                    {receberam} {t("de")} {total} {t("receberam")} · {c.contagem.respondeu} {t("responderam")} ·{" "}
                    {c.contagem.pediu_para_sair} {t("pediram para sair")}
                    {c.contagem.falhou > 0 ? ` · ${c.contagem.falhou} ${t("falharam")}` : ""}
                  </p>
                </Link>
              </li>
            );
          })}
        </ul>
      )}

      <NovaCampanhaDialog open={nova} onOpenChange={setNova} />
    </div>
  );
}
