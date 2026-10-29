"use client";

import { useMemo, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useT } from "@/hooks/i18n/useT";
import { useEditarQrCode, useFunilDosQrCodes, useQrCodes } from "@/hooks/qr-codes/useQrCodes";
import { canalQueAtendeOQr } from "@/lib/qr-codes/avisos";
import { periodoPreDefinido } from "@/lib/relatorios/periodo";
import type { QrCodeRow } from "@/lib/schemas/qr-codes";
import { Plus, QrCode } from "@/lib/ui/icons";

import {
  FiltroDePeriodo,
  fusoDoNavegador,
  type EstadoDoPeriodo,
} from "../../_components/FiltroDePeriodo";
import { CartaoDoQr } from "./CartaoDoQr";
import { DialogoDoQr } from "./DialogoDoQr";

const DIA_EM_MS = 86_400_000;

function periodoConsultavel(p: EstadoDoPeriodo): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(p.de) || !/^\d{4}-\d{2}-\d{2}$/.test(p.ate)) return false;
  const dias = (Date.parse(p.ate) - Date.parse(p.de)) / DIA_EM_MS + 1;
  return Number.isFinite(dias) && dias >= 1 && dias <= 366;
}

export function QrCodesClient() {
  const t = useT();
  const fuso = useMemo(() => fusoDoNavegador(), []);
  const [periodo, setPeriodo] = useState<EstadoDoPeriodo>(() => ({
    modo: 30,
    ...periodoPreDefinido(30, new Date(), fusoDoNavegador()),
  }));
  const [dialogo, setDialogo] = useState<"novo" | QrCodeRow | null>(null);

  const lista = useQrCodes();
  const consultavel = periodoConsultavel(periodo);
  const funil = useFunilDosQrCodes({ de: periodo.de, ate: periodo.ate, fuso }, { enabled: consultavel });
  const editar = useEditarQrCode();

  const funilPorQr = useMemo(() => new Map((funil.data ?? []).map((f) => [f.qr_code_id, f])), [funil.data]);
  const canais = lista.data?.canais ?? [];
  const ativos = (lista.data?.qr_codes ?? []).filter((q) => q.arquivado_em === null);
  const arquivados = (lista.data?.qr_codes ?? []).filter((q) => q.arquivado_em !== null);

  const arquivar = (qr: QrCodeRow, arquivado: boolean) =>
    editar.mutate(
      { id: qr.id, arquivado },
      { onSuccess: () => toast.success(arquivado ? t("QR code arquivado") : t("QR code reativado")) },
    );

  const cartao = (qr: QrCodeRow) => (
    <CartaoDoQr
      key={qr.id}
      qr={qr}
      numero={canalQueAtendeOQr(qr.channel_session_id, canais)}
      funil={funilPorQr.get(qr.id)}
      onEditar={() => setDialogo(qr)}
      onArquivar={() => arquivar(qr, true)}
      onReativar={() => arquivar(qr, false)}
    />
  );

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <FiltroDePeriodo valor={periodo} onChange={setPeriodo} fuso={fuso} />
        <Button onClick={() => setDialogo("novo")}>
          <Plus size={16} aria-hidden /> {t("Novo QR code")}
        </Button>
      </div>

      {!consultavel && (
        <p className="text-sm text-text-muted">
          {t("Escolha um período de até 366 dias, com a data final depois da inicial.")}
        </p>
      )}

      {lista.isPending ? (
        <div className="flex flex-col gap-4" aria-busy="true">
          <Skeleton className="h-48 w-full" />
          <Skeleton className="h-48 w-full" />
        </div>
      ) : lista.isError ? (
        <div className="flex flex-col items-start gap-3 rounded-md border border-border p-4">
          <p className="text-sm">{t("Não foi possível carregar os QR codes.")}</p>
          <Button variant="outline" onClick={() => void lista.refetch()}>
            {t("Tentar de novo")}
          </Button>
        </div>
      ) : ativos.length === 0 && arquivados.length === 0 ? (
        <div className="flex flex-col items-start gap-4 rounded-md border border-dashed border-border p-6">
          <QrCode size={32} className="text-text-muted" aria-hidden />
          <div className="flex flex-col gap-1">
            <h2 className="text-base font-semibold">{t("Nenhum QR code ainda")}</h2>
            <ol className="list-decimal pl-5 text-sm text-text-muted">
              <li>{t("Crie o QR e imprima.")}</li>
              <li>{t("O cliente lê e o WhatsApp abre com a mensagem pronta.")}</li>
              <li>{t("A conversa e o lead aparecem aqui e no relatório.")}</li>
            </ol>
          </div>
          <Button onClick={() => setDialogo("novo")}>
            <Plus size={16} aria-hidden /> {t("Novo QR code")}
          </Button>
        </div>
      ) : (
        <>
          <div className="flex flex-col gap-4">{ativos.map(cartao)}</div>
          {arquivados.length > 0 && (
            <section className="flex flex-col gap-3">
              <h2 className="text-sm font-medium text-text-muted">{t("Arquivados")}</h2>
              <div className="flex flex-col gap-4">{arquivados.map(cartao)}</div>
            </section>
          )}
        </>
      )}

      {dialogo !== null && (
        <DialogoDoQr
          // Um diálogo novo por QR: o estado dos campos nasce do QR aberto, nunca do anterior.
          key={dialogo === "novo" ? "novo" : dialogo.id}
          qr={dialogo === "novo" ? undefined : dialogo}
          canais={canais}
          onFechar={() => setDialogo(null)}
        />
      )}
    </div>
  );
}
