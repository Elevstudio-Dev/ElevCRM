"use client";

import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

import { useT } from "@/hooks/i18n/useT";
import { ORDEM_DOS_GRUPOS, ROTULO_DO_GRUPO, type DiaDaSerie, type GrupoDeOrigem } from "@/lib/relatorios/origens";

/** Uma cor por grupo, só pelos tokens do tema: o gráfico acompanha claro/escuro e a marca da instalação. */
const COR_DO_GRUPO: Record<GrupoDeOrigem, string> = {
  qr: "var(--color-accent)",
  anuncio: "var(--color-info)",
  formulario: "var(--color-warning)",
  whatsapp: "var(--color-success)",
  manual: "var(--color-accent-300)",
  importado: "var(--color-neutral-400)",
  ia: "var(--color-info-fg)",
  outros: "var(--color-border-strong)",
};

/** `2026-10-02` → `02/10`, sem passar por `Date` (que deslocaria o dia pelo fuso do navegador). */
function diaMes(dia: string): string {
  return `${dia.slice(8, 10)}/${dia.slice(5, 7)}`;
}

export function GraficoPorDia({ serie }: { serie: DiaDaSerie[] }) {
  const t = useT();
  const presentes = ORDEM_DOS_GRUPOS.filter((g) => serie.some((d) => d[g] > 0));

  if (presentes.length === 0) {
    return (
      <p className="rounded-md border border-dashed border-border p-6 text-center text-sm text-text-muted">
        {t("Nenhum lead neste período.")}
      </p>
    );
  }

  return (
    <div className="rounded-md border border-border bg-surface p-4">
      <h2 className="mb-3 text-sm font-medium text-text-muted">{t("Leads por dia")}</h2>
      <ResponsiveContainer width="100%" height={240}>
        <BarChart data={serie} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--color-border)" />
          <XAxis
            dataKey="dia"
            tickFormatter={diaMes}
            tick={{ fontSize: 11, fill: "var(--color-text-muted)" }}
            tickLine={false}
            axisLine={false}
            interval="preserveStartEnd"
          />
          <YAxis
            allowDecimals={false}
            tick={{ fontSize: 11, fill: "var(--color-text-muted)" }}
            tickLine={false}
            axisLine={false}
            width={32}
          />
          <Tooltip
            labelFormatter={(label) => diaMes(String(label))}
            formatter={(valor, nome) => [String(valor), t(ROTULO_DO_GRUPO[nome as GrupoDeOrigem] ?? String(nome))]}
            contentStyle={{
              borderRadius: "8px",
              fontSize: "12px",
              border: "1px solid var(--color-border)",
              background: "var(--color-surface)",
              color: "var(--color-text)",
            }}
          />
          {/* O texto da legenda NÃO herda a cor da barra: o lavanda sobre branco não tem contraste para ler. */}
          <Legend
            formatter={(nome) => (
              <span style={{ color: "var(--color-text-muted)" }}>
                {t(ROTULO_DO_GRUPO[nome as GrupoDeOrigem] ?? String(nome))}
              </span>
            )}
          />
          {presentes.map((g) => (
            <Bar key={g} dataKey={g} stackId="a" fill={COR_DO_GRUPO[g]} />
          ))}
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
