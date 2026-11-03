/**
 * POR QUE UMA MENSAGEM NOSSA FICOU NA FILA — o que a bolha diz sobre isso.
 *
 * O envio (`app/api/v1/messages/_handler.ts`) grava `status: "queued"` quando NÃO tenta mandar: o canal
 * não está configurado, ou o número não está conectado (`channel_session_not_working`). Essas mensagens
 * não saem sozinhas — o resgate de mensagens presas (`redriveQueued`) só olha as da IA. Para quem
 * atende, então, "na fila" é "não saiu", e a bolha não dizia NADA: sem tique, sem aviso. O dono
 * mandou um link para um grupo, ele ficou assim, e a leitura da tela foi "como se não tivesse enviado".
 *
 * Aqui só se decide QUAL é o motivo; o texto (traduzido) é de quem desenha.
 */

export type MotivoDaFila = "numero_desconectado" | "canal_nao_configurado" | "desconhecido";

/** `true` quando a linha é nossa, está na fila e já passou pelo servidor (não é o otimista em voo). */
export function ficouNaFila(m: {
  direction: string;
  status: string;
  metadata?: Record<string, unknown> | null;
}): boolean {
  if (m.direction !== "outbound" || m.status !== "queued") return false;
  // O otimista (`_optimistic`) é a bolha que aparece ANTES de o servidor responder: ainda está saindo.
  return m.metadata?._optimistic !== true;
}

/** O motivo gravado pelo envio em `metadata.queued_reason`. */
export function motivoDaFila(metadata: Record<string, unknown> | null | undefined): MotivoDaFila {
  const razao = metadata?.queued_reason;
  if (typeof razao !== "string") return "desconhecido";
  if (razao === "channel_session_not_working") return "numero_desconectado";
  // `<provider>_not_configured` — o prefixo é do canal (`adapter.codes.notConfigured`), o sufixo é fixo.
  if (razao.endsWith("_not_configured")) return "canal_nao_configurado";
  return "desconhecido";
}
