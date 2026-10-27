import { ImageResponse } from "next/og";

import { DesenhoDoIcone } from "@/lib/branding/elev/desenho-do-icone";
import { marcaDaSaida } from "@/lib/branding/saida";

/**
 * O ícone de quem põe o CRM na tela inicial do iPhone ("Adicionar à Tela de Início").
 *
 * Mesmo desenho e mesmas razões de `app/icon.tsx` — leia o cabeçalho de lá: gerado em RUNTIME (a imagem
 * do self-host é uma só e a cor é da instalação), `force-dynamic` e a cor vinda do resolvedor da marca.
 * Aqui só muda o tamanho: o iOS pede 180×180 e aplica a máscara arredondada dele, então o ladrilho é
 * quadrado e cheio.
 *
 * ⚠️ `/apple-icon` precisa estar em `PUBLIC_PATHS` (`lib/auth/public-paths.ts`), pelo mesmo motivo do
 * `/icon`: o `<head>` aponta para ele em toda página, inclusive as de antes do login.
 */
export const dynamic = "force-dynamic";

export const size = { width: 180, height: 180 };
export const contentType = "image/png";

export default async function AppleIcon() {
  const marca = await marcaDaSaida(null);
  return new ImageResponse(
    <DesenhoDoIcone lado={size.height} fundo={marca.accent} frente={marca.accentFg} />,
    {
      ...size,
      headers: { "cache-control": "public, max-age=60, stale-while-revalidate=600" },
    },
  );
}
