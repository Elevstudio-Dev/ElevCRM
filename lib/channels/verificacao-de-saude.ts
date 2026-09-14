/**
 * O que o health check de um canal DIZ quando o transporte não responde bem.
 *
 * O health check ao vivo (`GET /api/v1/channel-sessions/[id]`) pergunta ao
 * WAHA o status da sessão. Quando a resposta é 404, a sessão não existe lá e
 * o status vira STOPPED — isso sempre existiu. Quando é qualquer OUTRO erro,
 * o status do banco fica (uma oscilação de rede não pode derrubar um canal
 * saudável para a tela) — e aqui estava o buraco: a tela carimbava
 * "Verificado agora" em cima de um status que ninguém verificou.
 *
 * Medido em 2026-09-14: o container do WAHA subiu com a chave errada e
 * respondia 401 para tudo. O card dizia "Conectado · Verificado 15:34", a
 * mensagem enviada não saiu, e só o toast do "Reconectar" (`waha_stop_401`)
 * entregou a verdade. Um canal que o transporte recusa não está "conectado";
 * está em estado desconhecido — e a tela tem que dizer isso e por quê.
 *
 * Dois motivos, guardados em `channel_sessions.status_reason` só enquanto a
 * falha dura (a verificação que passa os apaga):
 *
 *   - `transporte_nao_autorizado` — 401/403: a chave do WAHA está errada ou
 *     trocou. Não é transitório; ninguém conserta reiniciando.
 *   - `transporte_inalcancavel`   — qualquer outro erro (rede, 5xx, timeout).
 */

export const MOTIVOS_DE_VERIFICACAO = ["transporte_nao_autorizado", "transporte_inalcancavel"] as const;
export type MotivoDeVerificacao = (typeof MOTIVOS_DE_VERIFICACAO)[number];

export function ehMotivoDeVerificacao(valor: unknown): valor is MotivoDeVerificacao {
  return typeof valor === "string" && (MOTIVOS_DE_VERIFICACAO as readonly string[]).includes(valor);
}

/**
 * Classifica a mensagem de erro do cliente WAHA (`waha_<op>_<status>: …`,
 * ou o erro de rede) num motivo. 404 NÃO passa por aqui: quem chama já o
 * tratou como "sessão não existe".
 */
export function classificarFalhaDeVerificacao(mensagem: string): MotivoDeVerificacao {
  return /\b40[13]\b/.test(mensagem) ? "transporte_nao_autorizado" : "transporte_inalcancavel";
}

/** O texto que a tela mostra no lugar de "Verificado <hora>". Chaves de `t()`. */
export const TEXTO_DO_MOTIVO: Record<MotivoDeVerificacao, string> = {
  transporte_nao_autorizado: "Não verificado: o transporte do WhatsApp recusou a chave de API (401). Confira a chave no .env da instalação.",
  transporte_inalcancavel: "Não verificado: o transporte do WhatsApp não respondeu. O status é o último conhecido.",
};
