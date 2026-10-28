"use client";

import { Fragment } from "react";
import { toast } from "sonner";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useT } from "@/hooks/i18n/useT";
import { formatCentsBRL } from "@/lib/money";
import { avisosDoQr, type AvisoDoQr } from "@/lib/qr-codes/avisos";
import { mensagemComCodigo } from "@/lib/qr-codes/codigo";
import { linkPublicoDoQr } from "@/lib/qr-codes/link-do-whatsapp";
import type { CanalDoQr, FunilDoQr, QrCodeRow } from "@/lib/schemas/qr-codes";
import { ArrowCounterClockwise, ArrowRight, Archive, Copy, DownloadSimple, PencilSimple, Warning } from "@/lib/ui/icons";
import { cn } from "@/lib/utils";

import { baixarPng, baixarSvg } from "./baixar";
import { ImagemDoQr } from "./ImagemDoQr";

/** Taxa entre duas etapas do funil. `—` quando a etapa anterior é zero: dividir por zero não é "0%". */
function taxa(atual: number, anterior: number): string {
  return anterior === 0 ? "—" : `${Math.round((atual / anterior) * 100)}%`;
}

function Etapa({ id, rotulo, valor, percentual }: { id: string; rotulo: string; valor: number; percentual?: string }) {
  return (
    <div className="flex min-w-[64px] flex-col" data-testid={`funil-${id}`}>
      <span className="text-xs text-text-muted">{rotulo}</span>
      <span className="text-lg font-semibold tabular-nums text-text">{valor.toLocaleString("pt-BR")}</span>
      {/* Espaço fixo (não-quebrável) quando não há taxa: a linha vazia colapsaria e a 1ª etapa ficaria mais baixa. */}
      <span className="text-xs tabular-nums text-text-muted">{percentual ?? " "}</span>
    </div>
  );
}

export function CartaoDoQr({
  qr,
  numero,
  funil,
  onEditar,
  onArquivar,
  onReativar,
}: {
  qr: QrCodeRow;
  /** O número que atende este QR (regra da rota pública), ou `null` se nenhum serve. */
  numero: CanalDoQr | null;
  funil: FunilDoQr | undefined;
  onEditar: () => void;
  onArquivar: () => void;
  onReativar: () => void;
}) {
  const t = useT();
  const arquivado = qr.arquivado_em !== null;
  const origem = typeof window === "undefined" ? "" : window.location.origin;
  const link = linkPublicoDoQr(origem, qr.codigo);
  const f = funil ?? { qr_code_id: qr.id, leituras: 0, conversas: 0, leads: 0, ganhos: 0, valor_ganho_cents: 0 };
  const avisos: AvisoDoQr[] = arquivado
    ? []
    : avisosDoQr({ leituras: f.leituras, conversas: f.conversas, temNumero: numero !== null });

  const copiar = async () => {
    try {
      await navigator.clipboard.writeText(link);
      toast.success(t("Link copiado"));
    } catch {
      toast.error(t("Não foi possível copiar. Selecione o link e copie à mão."));
    }
  };
  const baixar = (qual: "png" | "svg") => async () => {
    try {
      await (qual === "png" ? baixarPng(link, qr.codigo) : baixarSvg(link, qr.codigo));
    } catch {
      toast.error(t("Não foi possível gerar a imagem."));
    }
  };

  return (
    <article
      data-testid="cartao-do-qr"
      className={cn(
        "flex flex-col gap-4 rounded-md border border-border bg-surface p-4 sm:flex-row",
        arquivado && "opacity-70",
      )}
    >
      <ImagemDoQr link={link} rotulo={`${t("QR code")} ${qr.nome}`} />

      <div className="flex min-w-0 flex-1 flex-col gap-3">
        <header className="flex flex-wrap items-center gap-2">
          <h3 className="truncate text-base font-semibold">{qr.nome}</h3>
          <Badge variant="neutral" className="font-mono" data-testid="codigo-do-qr">
            {qr.codigo}
          </Badge>
          {arquivado && <Badge variant="neutral">{t("Arquivado")}</Badge>}
        </header>

        <dl className="grid gap-x-4 gap-y-1 text-sm sm:grid-cols-[auto_1fr]">
          <dt className="text-text-muted">{t("Link")}</dt>
          <dd data-testid="link-do-qr" className="min-w-0 break-all font-mono text-xs text-text">
            {link}
          </dd>
          <dt className="text-text-muted">{t("Mensagem que o cliente envia")}</dt>
          <dd data-testid="mensagem-do-qr" className="min-w-0 break-words text-text">
            {mensagemComCodigo(qr.mensagem, qr.codigo)}
          </dd>
          <dt className="text-text-muted">{t("Número")}</dt>
          <dd className="text-text">
            {numero ? `${numero.nome ?? "WhatsApp"} · ${numero.telefone}` : t("Nenhum número ligado")}
          </dd>
        </dl>

        <div className="flex flex-wrap items-end gap-2" role="group" aria-label={t("Funil do período")}>
          {(
            [
              ["leituras", t("Leituras"), f.leituras, undefined],
              ["conversas", t("Conversas"), f.conversas, taxa(f.conversas, f.leituras)],
              ["leads", t("Leads"), f.leads, taxa(f.leads, f.conversas)],
              ["vendas", t("Vendas"), f.ganhos, taxa(f.ganhos, f.leads)],
            ] as const
          ).map(([id, rotulo, valor, percentual], i) => (
            <Fragment key={id}>
              {i > 0 && <ArrowRight size={14} className="mb-6 text-text-muted" aria-hidden />}
              <Etapa id={id} rotulo={rotulo} valor={valor} percentual={percentual} />
            </Fragment>
          ))}
          {f.valor_ganho_cents > 0 && (
            <span className="mb-1 ml-2 text-sm tabular-nums text-text-muted">{formatCentsBRL(f.valor_ganho_cents)}</span>
          )}
        </div>

        {avisos.map((aviso) => (
          <p
            key={aviso}
            role="status"
            data-testid={`aviso-${aviso}`}
            className="flex items-start gap-2 rounded-md bg-warning-bg px-3 py-2 text-sm text-warning-fg"
          >
            <Warning size={16} className="mt-0.5 shrink-0" aria-hidden />
            {aviso === "sem_numero"
              ? t("Este QR não tem número de WhatsApp ligado — quem ler vê uma página de aviso.")
              : t(
                  "10 leituras ou mais e nenhuma conversa. O cliente pode estar apagando o código da mensagem, ou o número está errado.",
                )}
          </p>
        ))}

        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={baixar("png")}>
            <DownloadSimple size={14} aria-hidden /> {t("Baixar PNG")}
          </Button>
          <Button variant="outline" size="sm" onClick={baixar("svg")}>
            <DownloadSimple size={14} aria-hidden /> {t("Baixar SVG")}
          </Button>
          <Button variant="outline" size="sm" onClick={copiar}>
            <Copy size={14} aria-hidden /> {t("Copiar link")}
          </Button>
          <Button variant="outline" size="sm" onClick={onEditar}>
            <PencilSimple size={14} aria-hidden /> {t("Editar")}
          </Button>
          {arquivado ? (
            <Button variant="outline" size="sm" onClick={onReativar}>
              <ArrowCounterClockwise size={14} aria-hidden /> {t("Reativar")}
            </Button>
          ) : (
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button variant="ghost" size="sm">
                  <Archive size={14} aria-hidden /> {t("Arquivar")}
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>{t("Arquivar este QR code?")}</AlertDialogTitle>
                  <AlertDialogDescription>
                    {t("Quem ler este QR verá que ele não está mais ativo. Os números ficam guardados.")}
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>{t("Cancelar")}</AlertDialogCancel>
                  <AlertDialogAction onClick={onArquivar}>{t("Arquivar")}</AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          )}
        </div>
      </div>
    </article>
  );
}
