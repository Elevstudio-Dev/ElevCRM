/**
 * POR ONDE O ÁUDIO DO CLIENTE É TRANSCRITO.
 *
 * Transcrever não é tarefa de modelo de conversa — o Claude, por exemplo, não
 * ouve áudio. Quem faz é um serviço de fala-para-texto, e hoje há dois que o
 * produto sabe usar, os dois no formato da OpenAI (`/v1/audio/transcriptions`):
 *
 *  1. a **OpenAI**, direto (`whisper-1`);
 *  2. a **OpenRouter**, que repassa o mesmo Whisper pela mesma chave que a
 *     instalação já usa para a conversa.
 *
 * Antes desta escolha só existia o caminho 1. Numa instalação que escolheu
 * OpenRouter no instalador, o áudio não era transcrito: o worker exigia uma
 * chave OpenAI à parte, e sem ela o agente respondia ao cliente como se o áudio
 * não tivesse chegado.
 *
 * A ordem é a da menor surpresa: quem já tem chave OpenAI continua exatamente
 * como estava (nenhum áudio muda de caminho por causa desta mudança), e só quem
 * NÃO tem cai na OpenRouter.
 *
 * Puro de propósito: as buscas de chave (credencial da organização, depois o
 * `.env`) são injetadas, então a ordem é testável sem banco nem rede.
 */

export type RotaDeTranscricao =
  | { via: "openai"; apiKey: string }
  | { via: "openrouter"; apiKey: string };

export interface EntradaDaRota {
  /** O provedor de CONVERSA da organização e a chave que ele usa. */
  provedorDaOrg: string;
  chaveDoProvedorDaOrg: string;
  /**
   * Procura a chave de um provedor para esta organização (credencial dela,
   * depois o `.env` da instalação). `null` quando não há em lugar nenhum.
   */
  buscarChave(provedor: "openai" | "openrouter"): Promise<string | null>;
}

async function chaveDe(
  provedor: "openai" | "openrouter",
  e: EntradaDaRota,
): Promise<string | null> {
  // O provedor de conversa da organização JÁ É este: a chave dele está na mão,
  // e procurar de novo só daria a mesma resposta (ou, pior, outra credencial).
  const chave =
    e.provedorDaOrg === provedor ? e.chaveDoProvedorDaOrg : await e.buscarChave(provedor);
  return chave && chave.trim() ? chave : null;
}

export async function escolherRotaDeTranscricao(
  e: EntradaDaRota,
): Promise<RotaDeTranscricao | null> {
  const openai = await chaveDe("openai", e);
  if (openai) return { via: "openai", apiKey: openai };

  const openrouter = await chaveDe("openrouter", e);
  if (openrouter) return { via: "openrouter", apiKey: openrouter };

  return null;
}
