"use client";

import { format } from "date-fns";
import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useT } from "@/hooks/i18n/useT";
import type { RelatorioDeAnuncios } from "@/hooks/relatorios/useRelatorioDeAnuncios";
import { formatarDinheiro, formatarRetorno, type Desempenho } from "@/lib/relatorios/anuncios";
import { formatCentsBRL } from "@/lib/money";
import { Warning } from "@/lib/ui/icons";

const NUM = "text-right tabular-nums";
const TRACO = "—";

function AvisoDaConexao({ conexao }: { conexao: RelatorioDeAnuncios["conexao"] }) {
  const t = useT();
  const link = (
    <Link href="/app/settings/meta-ads" className="font-medium text-accent underline-offset-2 hover:underline">
      {conexao.conectada ? t("Abrir a conexão") : t("Conectar a conta de anúncios")}
    </Link>
  );

  if (!conexao.conectada) {
    return (
      <p className="rounded-md border border-dashed border-border p-3 text-sm text-text-muted" data-testid="aviso-meta">
        {t("Conecte a conta de anúncios da Meta para ver quanto cada anúncio gastou, o custo por contato e o retorno.")}{" "}
        {link}
      </p>
    );
  }
  if (conexao.status === "token_invalido") {
    return (
      <p className="flex items-start gap-2 rounded-md border border-border p-3 text-sm text-text" data-testid="aviso-meta">
        <Warning size={16} aria-hidden className="mt-0.5 shrink-0 text-warning" />
        <span>
          {t("A Meta recusou a chave de acesso, então o gasto parou de atualizar. Os números abaixo são os da última atualização.")}{" "}
          {link}
        </span>
      </p>
    );
  }
  if (conexao.status === "erro") {
    return (
      <p className="flex items-start gap-2 rounded-md border border-border p-3 text-sm text-text" data-testid="aviso-meta">
        <Warning size={16} aria-hidden className="mt-0.5 shrink-0 text-warning" />
        <span>
          {conexao.last_error ?? t("Não foi possível atualizar o gasto agora.")}{" "}
          {t("Os números abaixo são os da última atualização.")}
        </span>
      </p>
    );
  }
  const quando = conexao.last_synced_at ? new Date(conexao.last_synced_at) : null;
  return (
    <p className="text-xs text-text-muted" data-testid="aviso-meta">
      {quando && !Number.isNaN(quando.getTime())
        ? `${t("Gasto atualizado em")} ${format(quando, "dd/MM/yy HH:mm")}.`
        : t("O gasto ainda não foi atualizado. Abra a conexão e use Atualizar agora.")}{" "}
      {t("A Meta conta o dia no fuso da conta de anúncios.")}
    </p>
  );
}

function Numeros({ d, comGasto }: { d: Desempenho; comGasto: boolean }) {
  const moeda = d.moeda;
  return (
    <>
      {comGasto && (
        <TableCell className={NUM}>{d.gastoCents > 0 ? formatarDinheiro(d.gastoCents, moeda) : TRACO}</TableCell>
      )}
      <TableCell className={NUM}>{d.leads.toLocaleString("pt-BR")}</TableCell>
      {comGasto && (
        <TableCell className={NUM}>
          {d.custoPorContatoCents === null ? TRACO : formatarDinheiro(d.custoPorContatoCents, moeda)}
        </TableCell>
      )}
      <TableCell className={NUM}>{d.ganhos.toLocaleString("pt-BR")}</TableCell>
      {comGasto && (
        <TableCell className={NUM}>
          {d.custoPorVendaCents === null ? TRACO : formatarDinheiro(d.custoPorVendaCents, moeda)}
        </TableCell>
      )}
      <TableCell className={NUM}>{formatCentsBRL(d.valorGanhoCents)}</TableCell>
      {comGasto && <TableCell className={NUM}>{formatarRetorno(d.retorno)}</TableCell>}
    </>
  );
}

export function TabelaDeAnuncios({ dados }: { dados: RelatorioDeAnuncios }) {
  const t = useT();
  const { anuncios, total, conexao } = dados;
  const comGasto = conexao.conectada;

  return (
    <div className="flex flex-col gap-3">
      <AvisoDaConexao conexao={conexao} />
      {anuncios.length === 0 ? (
        <p className="rounded-md border border-dashed border-border p-6 text-center text-sm text-text-muted">
          {t("Nenhum anúncio com contato ou gasto neste período.")}
        </p>
      ) : (
        <div className="overflow-x-auto rounded-md border border-border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("Anúncio")}</TableHead>
                {comGasto && <TableHead className={NUM}>{t("Gasto")}</TableHead>}
                <TableHead className={NUM}>{t("Contatos")}</TableHead>
                {comGasto && <TableHead className={NUM}>{t("Custo por contato")}</TableHead>}
                <TableHead className={NUM}>{t("Vendas")}</TableHead>
                {comGasto && <TableHead className={NUM}>{t("Custo por venda")}</TableHead>}
                <TableHead className={NUM}>{t("Valor ganho")}</TableHead>
                {comGasto && (
                  <TableHead className={NUM} title={t("Valor ganho ÷ gasto. 4,20x = R$ 4,20 para cada R$ 1 gasto.")}>
                    {t("Retorno")}
                  </TableHead>
                )}
              </TableRow>
            </TableHeader>
            <TableBody>
              {anuncios.map((a) => (
                <TableRow key={a.chave} data-testid="linha-de-anuncio">
                  <TableCell className="max-w-[320px]">
                    <div className="flex flex-col gap-0.5">
                      <span className="font-medium">{t(a.rotulo)}</span>
                      {(a.campanha || a.conjunto) && (
                        <span className="truncate text-xs text-text-muted">
                          {[a.campanha, a.conjunto].filter(Boolean).join(" › ")}
                        </span>
                      )}
                      {comGasto && a.gastouSemContato && (
                        <Badge variant="outline" className="mt-0.5 h-4 w-fit px-1.5 text-[10px]">
                          {t("Gastou e ninguém chamou")}
                        </Badge>
                      )}
                    </div>
                  </TableCell>
                  <Numeros d={a} comGasto={comGasto} />
                </TableRow>
              ))}
              <TableRow className="border-t-2 font-semibold">
                <TableCell>{t("Total")}</TableCell>
                <Numeros d={total} comGasto={comGasto} />
              </TableRow>
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
