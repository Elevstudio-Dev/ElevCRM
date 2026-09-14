"use client";

import * as Sentry from "@sentry/nextjs";
import { useEffect, useState } from "react";

import { copyToClipboard } from "@/lib/clipboard";
import { ehErroDeCarregamento, recarregarUmaVez } from "@/lib/feedback/erro-de-carregamento";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const [eventId, setEventId] = useState<string | undefined>(undefined);
  const [copied, setCopied] = useState(false);
  // Sem `useT` aqui de propósito: este é o erro da RAIZ, fora de qualquer
  // provider — textos em português, como o resto do arquivo.
  const desatualizada = ehErroDeCarregamento(error);

  useEffect(() => {
    if (desatualizada) {
      // Aba aberta durante uma atualização: recarrega sozinho (uma vez por
      // minuto); se voltar, a tela abaixo explica. Não é incidente para o Sentry.
      recarregarUmaVez(
        typeof window === "undefined" ? null : window.sessionStorage,
        () => window.location.reload(),
      );
      return;
    }
    const id = Sentry.captureException(error);
    setEventId(id);
  }, [error, desatualizada]);

  const displayId = eventId ?? error.digest ?? "—";

  return (
    <html lang="pt-BR">
      <body
        style={{
          margin: 0,
          fontFamily:
            "ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, sans-serif",
          background: "#fafaf9",
          color: "#1c1917",
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: "2rem",
        }}
      >
        <div
          style={{
            maxWidth: 480,
            width: "100%",
            background: "white",
            border: "1px solid #e7e5e4",
            borderRadius: 12,
            padding: "2rem",
            textAlign: "center",
          }}
        >
          <h1 style={{ fontSize: "1.5rem", margin: "0 0 0.5rem", fontWeight: 600 }}>
            {desatualizada ? "O sistema foi atualizado" : "Algo deu errado"}
          </h1>
          <p style={{ color: "#57534e", margin: "0 0 1.5rem" }}>
            {desatualizada
              ? "Esta aba ficou aberta durante uma atualização e o que ela carregou não bate mais com o servidor. Recarregar resolve; nada do que você fez se perde."
              : "Tente novamente em instantes. Se persistir, contate o suporte com o ID abaixo."}
          </p>
          {desatualizada ? null : (
            <div
              style={{
                fontFamily: "ui-monospace, monospace",
                fontSize: "0.75rem",
                background: "#f5f5f4",
                padding: "0.5rem",
                borderRadius: 6,
                marginBottom: "1rem",
                wordBreak: "break-all",
              }}
            >
              ID: {displayId}
            </div>
          )}
          {!desatualizada && error.message ? (
            <p
              style={{
                color: "#57534e",
                fontSize: "0.75rem",
                textAlign: "left",
                margin: "0 0 1rem",
                wordBreak: "break-word",
              }}
            >
              <strong>O que aconteceu:</strong> {error.message}
            </p>
          ) : null}
          <div style={{ display: "flex", gap: "0.5rem", justifyContent: "center" }}>
            {desatualizada ? null : (
            <button
              type="button"
              onClick={() => {
                void copyToClipboard(displayId).then((ok) => {
                  if (ok) {
                    setCopied(true);
                    setTimeout(() => setCopied(false), 2000);
                  }
                });
              }}
              style={{
                padding: "0.5rem 1rem",
                border: "1px solid #d6d3d1",
                background: "white",
                borderRadius: 6,
                cursor: "pointer",
              }}
            >
              {copied ? "Copiado!" : "Copiar ID"}
            </button>
            )}
            <button
              type="button"
              onClick={() => (desatualizada ? window.location.reload() : reset())}
              style={{
                padding: "0.5rem 1rem",
                border: "1px solid #1c1917",
                background: "#1c1917",
                color: "white",
                borderRadius: 6,
                cursor: "pointer",
              }}
            >
              {desatualizada ? "Recarregar" : "Tentar de novo"}
            </button>
          </div>
        </div>
      </body>
    </html>
  );
}
