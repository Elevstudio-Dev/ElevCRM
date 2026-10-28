/**
 * O QUE O CARTÃO DO QR AVISA — o laço de retorno da funcionalidade.
 *
 * Um QR que não funciona não dá erro em lugar nenhum: o cartaz continua na parede e ninguém conversa. Estes dois
 * avisos são o que muda na tela quando isso acontece, para o gestor corrigir o número ou a mensagem.
 */
export type AvisoDoQr = "sem_numero" | "leituras_sem_conversa";

/** Abaixo disso é cedo demais para concluir: três pessoas podem só não ter enviado ainda. */
export const LIMIAR_DE_LEITURAS_SEM_CONVERSA = 10;

/**
 * O número que atende o QR — a MESMA regra da rota pública (`app/q/[codigo]/route.ts`): o canal escolhido, se tem
 * telefone; senão o primeiro canal conectado com telefone. `null` = quem ler verá a página "QR sem número".
 */
export function canalQueAtendeOQr<C extends { id: string; telefone: string | null; conectado: boolean }>(
  channelSessionId: string | null,
  canais: C[],
): C | null {
  const escolhido = canais.find((c) => c.id === channelSessionId && c.telefone);
  if (escolhido) return escolhido;
  return canais.find((c) => c.conectado && c.telefone) ?? null;
}

export function avisosDoQr(v: { leituras: number; conversas: number; temNumero: boolean }): AvisoDoQr[] {
  const avisos: AvisoDoQr[] = [];
  if (!v.temNumero) avisos.push("sem_numero");
  if (v.leituras >= LIMIAR_DE_LEITURAS_SEM_CONVERSA && v.conversas === 0) avisos.push("leituras_sem_conversa");
  return avisos;
}
