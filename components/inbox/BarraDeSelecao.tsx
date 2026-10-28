"use client";
import { Button } from "@/components/ui/button";
import { useT } from "@/hooks/i18n/useT";
import { ShareFat } from "@/lib/ui/icons";

/**
 * A barra que toma o lugar do campo de envio enquanto se escolhem as mensagens a encaminhar.
 *
 * O campo de envio NÃO é desmontado (quem monta o esconde): o rascunho digitado sobrevive a um
 * "encaminhar" iniciado no meio da resposta. Aqui só há o que a pessoa precisa para decidir — quantas
 * mensagens marcou, desistir ou seguir.
 */
export function BarraDeSelecao({
  quantidade,
  onCancelar,
  onEncaminhar,
}: {
  quantidade: number;
  onCancelar: () => void;
  onEncaminhar: () => void;
}) {
  const t = useT();
  return (
    <div
      role="toolbar"
      aria-label={t("Encaminhar mensagens")}
      className="flex items-center gap-2 border-t border-border bg-background px-4 py-3"
    >
      <span className="flex-1 text-sm" aria-live="polite">
        {quantidade} {quantidade === 1 ? t("mensagem selecionada") : t("mensagens selecionadas")}
      </span>
      <Button type="button" variant="outline" onClick={onCancelar}>
        {t("Cancelar")}
      </Button>
      <Button type="button" onClick={onEncaminhar} disabled={quantidade === 0}>
        <ShareFat size={14} aria-hidden className="mr-1.5" />
        {t("Encaminhar")}
      </Button>
    </div>
  );
}
