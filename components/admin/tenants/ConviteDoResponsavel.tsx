"use client";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useT } from "@/hooks/i18n/useT";
import { useTagDeIdioma } from "@/hooks/i18n/useLocaleDeData";
import { copyToClipboard } from "@/lib/clipboard";
import type { ConviteEmitido as Convite } from "@/hooks/useOwnerInvite";

/**
 * O convite que acabou de ser emitido para o responsável de um tenant: se o e-mail saiu,
 * para onde; se NÃO saiu, o link para entregar à mão. É a única tela que mostra o link —
 * ele não fica guardado em lugar nenhum e vale 24h, então tem de ser fácil de copiar.
 *
 * O link sozinho não dá acesso: quem o abre ainda precisa criar a conta (ou entrar) com o
 * MESMO e-mail do convite. Mesmo assim, é uma credencial de entrada na organização —
 * por isso aparece só para o admin de plataforma, uma vez, e não é gravado no navegador.
 */
export function ConviteDoResponsavel({ convite }: { convite: Convite }) {
  const t = useT();
  const tagDeIdioma = useTagDeIdioma();

  async function copiar() {
    // O helper do repo, e não a API crua do navegador: numa instalação servida por http://IP
    // (sem contexto seguro) o navegador nem expõe o objeto, e o helper cai no fallback.
    if (await copyToClipboard(convite.accept_url)) {
      toast.success(t("Link copiado"));
    } else {
      toast.error(t("Não foi possível copiar. Selecione o link e copie à mão."));
    }
  }

  return (
    <div className="space-y-3" data-testid="convite-do-responsavel">
      {convite.email_dispatched ? (
        <p className="text-sm" role="status">
          {t("Enviamos o convite para")} <strong>{convite.email}</strong>.{" "}
          {t("Se ele não chegar, copie o link abaixo e entregue pelo canal que o cliente usa.")}
        </p>
      ) : (
        <p
          className="rounded-md border border-amber-300/60 bg-amber-50 px-3 py-2 text-sm dark:border-amber-500/30 dark:bg-amber-950/20"
          role="alert"
        >
          {t("O e-mail não saiu. Copie o link abaixo e entregue a")} <strong>{convite.email}</strong>{" "}
          {t("pelo canal que o cliente usa (por exemplo, o WhatsApp).")}
        </p>
      )}

      <div className="space-y-1.5">
        <Label htmlFor="link-do-convite">{t("Link do convite")}</Label>
        <div className="flex gap-2">
          <Input
            id="link-do-convite"
            readOnly
            value={convite.accept_url}
            className="font-mono text-xs"
            onFocus={(e) => e.currentTarget.select()}
          />
          <Button type="button" variant="outline" onClick={copiar}>
            {t("Copiar link")}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          {t("Vale até")} {new Date(convite.expires_at).toLocaleString(tagDeIdioma)}.{" "}
          {t("Depois disso, gere outro em «Convidar responsável» na página do tenant.")}
        </p>
      </div>
    </div>
  );
}
