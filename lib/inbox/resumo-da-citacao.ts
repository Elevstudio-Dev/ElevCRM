/**
 * O QUE A CITAÇÃO DIZ DA MENSAGEM CITADA.
 *
 * Responder "em cima" de um áudio ou de uma foto é o caso comum — no WhatsApp,
 * metade das citações são mídia. A faixa e a bolha mostravam o `body`, que numa
 * mensagem de mídia é nulo, e caíam em "(sem texto)": quem respondia a um áudio
 * via a citação dizer que a mensagem não tinha texto, como se ela estivesse
 * vazia.
 *
 * Aqui decide-se o resumo: a legenda, quando há, ou o nome do tipo (Áudio, Foto,
 * Vídeo…), sempre com o ícone do tipo. Pura, e devolve o RÓTULO em português
 * (a chave de tradução) em vez do texto traduzido — quem desenha chama `t()`.
 */
import type { Message } from "@/lib/types/messaging";

export type IconeDaCitacao =
  | "audio"
  | "imagem"
  | "video"
  | "documento"
  | "figurinha"
  | "contato"
  | "localizacao"
  | "anexo";

export interface ResumoDaCitacao {
  icone: IconeDaCitacao | null;
  /** O que a pessoa escreveu (corpo ou legenda), já sem as sobras de espaço. `null` = nada escrito. */
  trecho: string | null;
  /** O nome do tipo ou o aviso, em português, para `t()`. `null` quando o `trecho` basta. */
  rotulo: string | null;
  /** O autor apagou para todos: o conteúdo NÃO aparece (nem aqui, onde seria o segundo lugar da tela). */
  apagada: boolean;
}

const MIDIAS: Record<string, { icone: IconeDaCitacao; rotulo: string }> = {
  audio: { icone: "audio", rotulo: "Áudio" },
  image: { icone: "imagem", rotulo: "Foto" },
  video: { icone: "video", rotulo: "Vídeo" },
  sticker: { icone: "figurinha", rotulo: "Figurinha" },
  document: { icone: "documento", rotulo: "Documento" },
  contact: { icone: "contato", rotulo: "Contato" },
  location: { icone: "localizacao", rotulo: "Localização" },
};

export function resumoDaCitacao(
  m: Pick<Message, "type" | "body" | "revoked_at" | "media_url" | "media_storage_path">,
): ResumoDaCitacao {
  // A citada pode ter sido apagada, e aí o texto dela não volta: "mostrá-lo seria expor justamente o
  // que o cliente pediu para tirar do ar". O fio permanece; o conteúdo, não.
  if (m.revoked_at) {
    return { icone: null, trecho: null, rotulo: "Esta mensagem foi apagada", apagada: true };
  }

  const trecho = m.body?.trim() || null;
  const midia = MIDIAS[m.type];
  if (midia) return { icone: midia.icone, trecho, rotulo: midia.rotulo, apagada: false };

  // Tipo que este mapa não conhece, mas que carrega arquivo: é um anexo, não "sem texto".
  if (!trecho && (m.media_url || m.media_storage_path)) {
    return { icone: "anexo", trecho: null, rotulo: "Anexo", apagada: false };
  }

  return { icone: null, trecho, rotulo: trecho ? null : "(sem texto)", apagada: false };
}
