"use client";
import QRCode from "qrcode";
import { useEffect, useState } from "react";

/**
 * O QR desenhado no navegador (nada sai para serviço externo). Margem 2 e correção M: lê bem impresso pequeno.
 *
 * O fundo é branco nos DOIS temas de propósito: o leitor de QR precisa de contraste claro/escuro real, e um QR
 * "escuro sobre escuro" no tema escuro não é lido pela câmera.
 */
export function ImagemDoQr({ link, tamanho = 160, rotulo }: { link: string; tamanho?: number; rotulo: string }) {
  const [svg, setSvg] = useState<string | null>(null);
  useEffect(() => {
    let vivo = true;
    QRCode.toString(link, { type: "svg", margin: 2, errorCorrectionLevel: "M" })
      .then((s) => {
        if (vivo) setSvg(s);
      })
      .catch(() => {
        if (vivo) setSvg(null);
      });
    return () => {
      vivo = false;
    };
  }, [link]);
  return (
    <div
      role="img"
      aria-label={rotulo}
      className="shrink-0 overflow-hidden rounded-md bg-white p-1 [&>svg]:h-full [&>svg]:w-full"
      style={{ width: tamanho, height: tamanho }}
      // O SVG vem da própria lib a partir de um link nosso — não há HTML de usuário aqui.
      dangerouslySetInnerHTML={svg ? { __html: svg } : undefined}
    />
  );
}
