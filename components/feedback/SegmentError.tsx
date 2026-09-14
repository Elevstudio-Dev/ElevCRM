"use client";

import * as Sentry from "@sentry/nextjs";
import { useEffect, useState } from "react";
import { useT } from "@/hooks/i18n/useT";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { copyToClipboard } from "@/lib/clipboard";
import { ehErroDeCarregamento, recarregarUmaVez } from "@/lib/feedback/erro-de-carregamento";

export interface SegmentErrorProps {
  error: Error & { digest?: string };
  reset: () => void;
  segment?: string;
}

export function SegmentError({ error, reset, segment }: SegmentErrorProps) {
  const t = useT();
  const [eventId, setEventId] = useState<string | undefined>(undefined);
  const [copied, setCopied] = useState(false);
  const desatualizada = ehErroDeCarregamento(error);

  useEffect(() => {
    // "O sistema foi atualizado com a aba aberta" não é incidente: não vai
    // para o Sentry, e recarrega sozinho (uma vez por minuto — se voltar,
    // a tela abaixo explica e o botão é "Recarregar").
    if (desatualizada) {
      recarregarUmaVez(
        typeof window === "undefined" ? null : window.sessionStorage,
        () => window.location.reload(),
      );
      return;
    }
    const id = Sentry.captureException(error, {
      tags: segment ? { segment } : undefined,
    });
    setEventId(id);
  }, [error, segment, desatualizada]);

  const displayId = eventId ?? error.digest ?? "—";

  function copyId() {
    void copyToClipboard(displayId).then((ok) => {
      if (ok) {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }
    });
  }

  if (desatualizada) {
    return (
      <main className="flex min-h-[60vh] items-center justify-center p-8">
        <Card className="w-full max-w-md p-8 text-center" data-testid="erro-aba-desatualizada">
          <h1 className="text-xl font-semibold">{t("O sistema foi atualizado")}</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {t(
              "Esta aba ficou aberta durante uma atualização e o que ela carregou não bate mais com o servidor. Recarregar resolve; nada do que você fez se perde.",
            )}
          </p>
          <div className="mt-4 flex justify-center">
            <Button type="button" onClick={() => window.location.reload()}>
              {t("Recarregar")}
            </Button>
          </div>
        </Card>
      </main>
    );
  }

  return (
    <main className="flex min-h-[60vh] items-center justify-center p-8">
      <Card className="w-full max-w-md p-8 text-center">
        <h1 className="text-xl font-semibold">{t("Algo deu errado")}</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          {t("Tente novamente em instantes. Se persistir, contate o suporte com o ID abaixo.")}
        </p>
        <div className="mt-4 break-all rounded-md bg-muted px-3 py-2 font-mono text-xs">
          ID: {displayId}
        </div>
        {/* A mensagem do erro, porque o ID sozinho não diz nada a quem não tem
            Sentry ligado — e uma instalação self-host raramente tem. O Next já
            troca a mensagem de erro de servidor por um texto genérico em
            produção, então nada sensível chega aqui. */}
        {error.message ? (
          <p
            className="mt-3 break-words text-left text-xs text-muted-foreground"
            data-testid="erro-mensagem"
          >
            <span className="font-medium">{t("O que aconteceu:")}</span> {error.message}
          </p>
        ) : null}
        <div className="mt-4 flex justify-center gap-2">
          <Button type="button" variant="outline" onClick={copyId}>
            {copied ? t("Copiado!") : t("Copiar ID")}
          </Button>
          <Button type="button" onClick={() => reset()}>
            {t("Tentar de novo")}
          </Button>
        </div>
      </Card>
    </main>
  );
}
