"use client";
import { format } from "date-fns";
import type { Locale } from "date-fns";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useLocaleDeData } from "@/hooks/i18n/useLocaleDeData";
import { useT } from "@/hooks/i18n/useT";
import { usePuxarHistorico, type ResultadoDaImportacao } from "@/hooks/inbox/usePuxarHistorico";
import { ApiError } from "@/lib/api/types";
import { ClockCounterClockwise, Megaphone } from "@/lib/ui/icons";

function dia(iso: string | null, locale: Locale): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : format(d, "dd/MM/yyyy", { locale });
}

interface DialogProps {
  contactId: string;
  conversationId?: string;
  nomeDoContato: string;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}

/**
 * PUXAR AS MENSAGENS ANTIGAS DESTE CONTATO DO WHATSAPP.
 *
 * O CRM só enxerga o que chegou depois de conectado; aqui a pessoa pede o resto. O diálogo diz, ANTES de
 * confirmar, o que vai e o que não vai acontecer (não responde ao cliente, não aciona a IA, não traz anexos) —
 * porque "puxar histórico" assusta quem teme mensagem automática saindo para conversa de meses atrás.
 *
 * O resultado fica no próprio diálogo (e não num toast): são vários números e, quando o canal não guarda
 * histórico, a explicação pede uma ação da equipe técnica e precisa ficar na tela.
 */
export function PuxarHistoricoDialog({ contactId, conversationId, nomeDoContato, open, onOpenChange }: DialogProps) {
  const t = useT();
  const locale = useLocaleDeData();
  const puxar = usePuxarHistorico(contactId, conversationId);
  const resultado = puxar.data;
  const erro = puxar.error;

  function fechar(v: boolean) {
    if (!v) puxar.reset();
    onOpenChange(v);
  }

  return (
    <Dialog open={open} onOpenChange={fechar}>
      <DialogContent className="sm:max-w-md" data-testid="puxar-historico-dialog">
        <DialogHeader>
          <DialogTitle>{t("Puxar histórico do WhatsApp")}</DialogTitle>
          <DialogDescription>
            {`${t("Busca no WhatsApp as mensagens antigas de")} ${nomeDoContato} ${t("e mostra quais vieram de anúncio.")}`}
          </DialogDescription>
        </DialogHeader>

        {resultado ? (
          <Resultado r={resultado} locale={locale} />
        ) : erro ? (
          <p
            role="alert"
            data-testid="puxar-historico-erro"
            className="rounded-md border border-destructive/40 p-3 text-sm"
          >
            {erro instanceof ApiError ? erro.message : t("Não foi possível puxar o histórico agora.")}
          </p>
        ) : (
          <ul className="list-disc space-y-1 pl-5 text-sm text-text-muted">
            <li>{t("Nada é enviado ao cliente e a IA não responde a conversas antigas.")}</li>
            <li>{t("O que já está no CRM não é duplicado; pode puxar de novo quando quiser.")}</li>
            <li>{t("Fotos, áudios e documentos antigos aparecem sem o arquivo.")}</li>
          </ul>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => fechar(false)}>
            {resultado ? t("Fechar") : t("Cancelar")}
          </Button>
          {!resultado && (
            <Button
              data-testid="puxar-historico-confirmar"
              disabled={puxar.isPending}
              onClick={() => puxar.mutate()}
            >
              {puxar.isPending ? t("Puxando…") : erro ? t("Tentar de novo") : t("Puxar histórico")}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Resultado({ r, locale }: { r: ResultadoDaImportacao; locale: Locale }) {
  const t = useT();
  const periodo = r.primeira_em && r.ultima_em ? `${dia(r.primeira_em, locale)} – ${dia(r.ultima_em, locale)}` : "";
  return (
    <div className="space-y-2 text-sm" data-testid="puxar-historico-resultado">
      {r.encontradas === 0 ? (
        <p>{t("O WhatsApp não tem mensagens antigas deste contato.")}</p>
      ) : (
        <>
          <p>
            <strong>{r.importadas}</strong> {t("mensagens novas trazidas")}
            {periodo && <span className="text-text-muted"> ({periodo})</span>}.{" "}
            {r.ja_existiam > 0 && (
              <span className="text-text-muted">
                {r.ja_existiam} {t("já estavam no CRM.")}
              </span>
            )}
          </p>
          <p className="flex items-center gap-1.5" data-testid="puxar-historico-anuncio">
            <Megaphone size={14} aria-hidden className="shrink-0 text-text-muted" />
            {r.de_anuncio > 0
              ? `${r.de_anuncio} ${t("mensagem(ns) vieram de anúncio e foram identificadas na conversa.")}`
              : t("Nenhuma mensagem veio de anúncio.")}
          </p>
          {r.contato_marcado_como_anuncio && (
            <p className="text-text-muted">{t("O contato foi marcado como vindo de anúncio.")}</p>
          )}
          {r.falharam > 0 && (
            <p className="text-destructive">
              {r.falharam} {t("mensagens não puderam ser gravadas.")}
            </p>
          )}
          {r.limite_atingido && (
            <p className="text-text-muted">{t("A conversa é longa: só as mensagens mais recentes foram trazidas.")}</p>
          )}
        </>
      )}
    </div>
  );
}

/** A seção do painel lateral: o botão que abre o diálogo. */
export function PuxarHistoricoSecao({
  contactId,
  conversationId,
  nomeDoContato,
}: {
  contactId: string;
  conversationId?: string;
  nomeDoContato: string;
}) {
  const t = useT();
  const [aberto, setAberto] = useState(false);
  return (
    <section data-testid="secao-historico">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t("Histórico do WhatsApp")}</h3>
      <Button
        size="sm"
        variant="outline"
        className="mt-2 h-7 px-2 text-xs"
        data-testid="puxar-historico"
        onClick={() => setAberto(true)}
      >
        <ClockCounterClockwise size={12} className="mr-1" weight="regular" aria-hidden />
        {t("Puxar histórico")}
      </Button>
      {aberto && (
        <PuxarHistoricoDialog
          contactId={contactId}
          conversationId={conversationId}
          nomeDoContato={nomeDoContato}
          open
          onOpenChange={setAberto}
        />
      )}
    </section>
  );
}
