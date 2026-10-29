"use client";

import { Input } from "@/components/ui/input";
import { useT } from "@/hooks/i18n/useT";
import { periodoPreDefinido } from "@/lib/relatorios/periodo";
import { cn } from "@/lib/utils";

export type ModoDePeriodo = 7 | 30 | 90 | "personalizado";

export interface EstadoDoPeriodo {
  modo: ModoDePeriodo;
  /** `YYYY-MM-DD` no fuso de quem vê. */
  de: string;
  ate: string;
}

const PRE_DEFINIDOS: Array<7 | 30 | 90> = [7, 30, 90];

/** O fuso do navegador de quem lê: "hoje" do gestor é o dele, não o do servidor. */
export function fusoDoNavegador(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "America/Sao_Paulo";
  } catch {
    return "America/Sao_Paulo";
  }
}

export function FiltroDePeriodo({
  valor,
  onChange,
  fuso,
}: {
  valor: EstadoDoPeriodo;
  onChange: (v: EstadoDoPeriodo) => void;
  fuso: string;
}) {
  const t = useT();
  const pilula = (ativa: boolean) =>
    cn(
      "inline-flex h-11 items-center rounded-full border px-4 text-sm transition-colors lg:h-9",
      ativa
        ? "border-accent bg-accent-soft font-medium text-accent"
        : "border-border text-text-muted hover:border-accent hover:text-accent",
    );

  return (
    <div className="flex flex-wrap items-end gap-2" role="group" aria-label={t("Período")}>
      {PRE_DEFINIDOS.map((dias) => (
        <button
          key={dias}
          type="button"
          aria-pressed={valor.modo === dias}
          className={pilula(valor.modo === dias)}
          onClick={() => onChange({ modo: dias, ...periodoPreDefinido(dias, new Date(), fuso) })}
        >
          {dias} {t("dias")}
        </button>
      ))}
      <button
        type="button"
        aria-pressed={valor.modo === "personalizado"}
        className={pilula(valor.modo === "personalizado")}
        onClick={() => onChange({ ...valor, modo: "personalizado" })}
      >
        {t("Personalizado")}
      </button>
      {valor.modo === "personalizado" && (
        <div className="flex flex-wrap items-end gap-2">
          <label className="flex flex-col gap-1 text-xs text-text-muted">
            {t("De")}
            <Input
              type="date"
              value={valor.de}
              max={valor.ate}
              onChange={(e) => onChange({ ...valor, de: e.target.value })}
              className="w-40"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-text-muted">
            {t("Até")}
            <Input
              type="date"
              value={valor.ate}
              min={valor.de}
              onChange={(e) => onChange({ ...valor, ate: e.target.value })}
              className="w-40"
            />
          </label>
        </div>
      )}
    </div>
  );
}
