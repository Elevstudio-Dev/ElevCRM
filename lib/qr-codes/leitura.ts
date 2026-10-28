/**
 * QUEM CONTA COMO LEITURA.
 *
 * O link do QR circula: colado num grupo, ele é aberto pelo robô de pré-visualização do próprio app de
 * mensagens antes de qualquer pessoa. Contar isso inflaria o funil. Sem user-agent também não conta — a câmera
 * de um celular abre um navegador, e navegador manda user-agent.
 *
 * Nada aqui é gravado: o user-agent só decide SE conta e de que tipo de aparelho veio.
 */
export const DISPOSITIVOS_DE_LEITURA = ["celular", "computador", "outro"] as const;
export type Dispositivo = (typeof DISPOSITIVOS_DE_LEITURA)[number];

const RE_ROBO =
  /bot\b|bot\/|crawler|spider|preview|facebookexternalhit|whatsapp\/|slackbot|telegrambot|discordbot|curl\/|wget\//i;

export function ehLeituraDeRobo(userAgent: string | null | undefined): boolean {
  const ua = (userAgent ?? "").trim();
  if (ua === "") return true;
  return RE_ROBO.test(ua);
}

export function dispositivoDoAgente(userAgent: string | null | undefined): Dispositivo {
  const ua = userAgent ?? "";
  if (ua.trim() === "") return "outro";
  // Celular ANTES de computador: o Android se declara "Linux".
  if (/Mobi|Android|iPhone|iPad|iPod/i.test(ua)) return "celular";
  if (/Windows|Macintosh|X11|Linux|CrOS/i.test(ua)) return "computador";
  return "outro";
}
