"use client";

import { useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useT } from "@/hooks/i18n/useT";
import { useRelatorioDeOrigens } from "@/hooks/relatorios/useRelatorioDeOrigens";
import { periodoPreDefinido } from "@/lib/relatorios/periodo";

import { FiltroDePeriodo, fusoDoNavegador, type EstadoDoPeriodo } from "./FiltroDePeriodo";
import { GraficoPorDia } from "./GraficoPorDia";
import { ResumoDoPeriodo } from "./ResumoDoPeriodo";
import { TabelaDeOrigens } from "./TabelaDeOrigens";

const DIA_EM_MS = 86_400_000;

/** O período personalizado só consulta quando as datas fazem sentido — o servidor recusa o resto com 422. */
function periodoConsultavel(p: EstadoDoPeriodo): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(p.de) || !/^\d{4}-\d{2}-\d{2}$/.test(p.ate)) return false;
  const dias = (Date.parse(p.ate) - Date.parse(p.de)) / DIA_EM_MS + 1;
  return Number.isFinite(dias) && dias >= 1 && dias <= 366;
}

export function RelatoriosClient() {
  const t = useT();
  const fuso = useMemo(() => fusoDoNavegador(), []);
  const [periodo, setPeriodo] = useState<EstadoDoPeriodo>(() => ({
    modo: 30,
    ...periodoPreDefinido(30, new Date(), fusoDoNavegador()),
  }));
  const consultavel = periodoConsultavel(periodo);
  const q = useRelatorioDeOrigens({ de: periodo.de, ate: periodo.ate, fuso }, { enabled: consultavel });

  return (
    <div className="flex flex-col gap-6">
      <FiltroDePeriodo valor={periodo} onChange={setPeriodo} fuso={fuso} />

      {!consultavel ? (
        <p className="text-sm text-text-muted">
          {t("Escolha um período de até 366 dias, com a data final depois da inicial.")}
        </p>
      ) : q.isPending ? (
        <div className="flex flex-col gap-4" aria-busy="true">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-[84px] w-full" />
            ))}
          </div>
          <Skeleton className="h-48 w-full" />
        </div>
      ) : q.isError ? (
        <div className="flex flex-col items-start gap-3 rounded-md border border-border p-4">
          <p className="text-sm text-text">{t("Não foi possível carregar o relatório.")}</p>
          <Button variant="outline" onClick={() => void q.refetch()}>
            {t("Tentar de novo")}
          </Button>
        </div>
      ) : (
        <>
          <ResumoDoPeriodo total={q.data.total} />
          <section className="flex flex-col gap-3">
            <h2 className="text-lg font-semibold">{t("Leads por origem")}</h2>
            <TabelaDeOrigens grupos={q.data.grupos} total={q.data.total} />
          </section>
          <GraficoPorDia serie={q.data.serie} />
        </>
      )}
    </div>
  );
}
