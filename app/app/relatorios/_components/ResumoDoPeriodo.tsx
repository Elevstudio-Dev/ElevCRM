"use client";

import { useT } from "@/hooks/i18n/useT";
import { formatCentsBRL } from "@/lib/money";
import type { Totais } from "@/lib/relatorios/origens";

export function porcentagem(v: number | null): string {
  return v === null ? "—" : `${Math.round(v * 100)}%`;
}

function Bloco({ id, rotulo, valor, dica }: { id: string; rotulo: string; valor: string; dica?: string }) {
  return (
    <div
      data-testid={`resumo-${id}`}
      className="flex flex-col gap-1 rounded-md border border-border bg-surface p-4"
      title={dica}
    >
      <span className="text-xs uppercase tracking-wide text-text-muted">{rotulo}</span>
      <span className="text-2xl font-semibold tabular-nums text-text">{valor}</span>
    </div>
  );
}

export function ResumoDoPeriodo({ total }: { total: Totais }) {
  const t = useT();
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <Bloco id="leads" rotulo={t("Leads")} valor={total.leads.toLocaleString("pt-BR")} />
      <Bloco id="vendas" rotulo={t("Vendas")} valor={total.ganhos.toLocaleString("pt-BR")} />
      <Bloco
        id="conversao"
        rotulo={t("Conversão")}
        valor={porcentagem(total.conversao)}
        dica={t("Ganhos ÷ (ganhos + perdidos). Aparece quando algum negócio fechou.")}
      />
      <Bloco id="valor" rotulo={t("Valor ganho")} valor={formatCentsBRL(total.valorGanhoCents)} />
    </div>
  );
}
