"use client";

import { Fragment, useState } from "react";

import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useT } from "@/hooks/i18n/useT";
import { formatCentsBRL } from "@/lib/money";
import {
  ROTULO_DO_GRUPO,
  type DetalheDoGrupo,
  type GrupoDeOrigem,
  type GrupoDoRelatorio,
  type Totais,
} from "@/lib/relatorios/origens";
import { CaretDown, CaretRight } from "@/lib/ui/icons";

import { porcentagem } from "./ResumoDoPeriodo";

const NUM = "text-right tabular-nums";

function Numeros({ t }: { t: Totais }) {
  return (
    <>
      <TableCell className={NUM}>{t.leads.toLocaleString("pt-BR")}</TableCell>
      <TableCell className={NUM}>{t.abertos.toLocaleString("pt-BR")}</TableCell>
      <TableCell className={NUM}>{t.ganhos.toLocaleString("pt-BR")}</TableCell>
      <TableCell className={NUM}>{t.perdidos.toLocaleString("pt-BR")}</TableCell>
      <TableCell className={NUM}>{porcentagem(t.conversao)}</TableCell>
      <TableCell className={NUM}>{formatCentsBRL(t.valorGanhoCents)}</TableCell>
    </>
  );
}

/** Só vale expandir quando há algo a mais para ver: um QR, um anúncio, uma campanha — não "WhatsApp direto" de novo. */
function temDetalheUtil(g: GrupoDoRelatorio): boolean {
  return g.detalhes.some((d) => d.rotulo !== ROTULO_DO_GRUPO[g.grupo]);
}

export function TabelaDeOrigens({ grupos, total }: { grupos: GrupoDoRelatorio[]; total: Totais }) {
  const t = useT();
  const [abertos, setAbertos] = useState<Set<GrupoDeOrigem>>(new Set());
  const alternar = (g: GrupoDeOrigem) =>
    setAbertos((atual) => {
      const novo = new Set(atual);
      if (novo.has(g)) novo.delete(g);
      else novo.add(g);
      return novo;
    });

  if (grupos.length === 0) {
    return (
      <p className="rounded-md border border-dashed border-border p-6 text-center text-sm text-text-muted">
        {t("Nenhum lead neste período.")}
      </p>
    );
  }

  return (
    <div className="overflow-x-auto rounded-md border border-border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t("Origem")}</TableHead>
            <TableHead className={NUM}>{t("Leads")}</TableHead>
            <TableHead className={NUM}>{t("Abertos")}</TableHead>
            <TableHead className={NUM}>{t("Vendas")}</TableHead>
            <TableHead className={NUM}>{t("Perdidos")}</TableHead>
            <TableHead className={NUM}>{t("Conversão")}</TableHead>
            <TableHead className={NUM}>{t("Valor ganho")}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {grupos.map((g) => {
            const expansivel = temDetalheUtil(g);
            const aberto = abertos.has(g.grupo);
            const Seta = aberto ? CaretDown : CaretRight;
            return (
              <Fragment key={g.grupo}>
                <TableRow>
                  <TableCell className="font-medium">
                    {expansivel ? (
                      <button
                        type="button"
                        aria-expanded={aberto}
                        onClick={() => alternar(g.grupo)}
                        className="inline-flex min-h-11 items-center gap-2 text-left lg:min-h-0"
                      >
                        <Seta size={14} aria-hidden />
                        {t(ROTULO_DO_GRUPO[g.grupo])}
                      </button>
                    ) : (
                      <span className="inline-flex items-center gap-2 pl-[22px]">{t(ROTULO_DO_GRUPO[g.grupo])}</span>
                    )}
                  </TableCell>
                  <Numeros t={g} />
                </TableRow>
                {aberto &&
                  g.detalhes.map((d: DetalheDoGrupo) => (
                    <TableRow key={`${g.grupo}:${d.chave}`} className="bg-surface-elevated/40 text-text-muted">
                      <TableCell className="pl-10">{t(d.rotulo)}</TableCell>
                      <Numeros t={d} />
                    </TableRow>
                  ))}
              </Fragment>
            );
          })}
          <TableRow className="border-t-2 font-semibold">
            <TableCell>{t("Total")}</TableCell>
            <Numeros t={total} />
          </TableRow>
        </TableBody>
      </Table>
    </div>
  );
}
