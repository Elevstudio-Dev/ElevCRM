/**
 * A ARTE DA CAMPANHA, enviada antes da mensagem da IA.
 *
 * A campanha guarda a imagem UMA vez em `{org}/campanhas/…` (bucket
 * `whatsapp-media`). O handler de envio só aceita mídia sob `{org}/{conversa}/` —
 * é a trava que impede alguém mandar o arquivo de outra conversa — e por isso a
 * arte é COPIADA para a pasta da conversa de cada destinatário, num caminho
 * determinístico: o mesmo paciente na mesma campanha dá sempre o mesmo arquivo,
 * e é por ele que se sabe se a arte já saiu (retry do job, job novo depois de
 * um recheck) sem mandar duas vezes.
 *
 * Quem está com um humano (handoff) ou pediu para sair não recebe nada: a
 * checagem é feita aqui porque a imagem não passa pela cadeia de texto do turno.
 * O resto das proteções (janela anti-ban, ritmo) vem da própria campanha, que só
 * agenda envios dentro do horário e no teto do dia.
 */
import type { ChannelSendInput, ChannelSendResult } from '../channel-adapter';

export interface ImagemDaCampanha {
  storage_path: string;
  mime: string;
}

export interface DepsDaImagem {
  /** Copia o objeto no bucket; destino que já existe NÃO é erro. */
  copiar(origem: string, destino: string): Promise<void>;
  /** Já existe mensagem de saída nesta conversa com este arquivo? */
  jaEnviada(conversationId: string, storagePath: string): Promise<boolean>;
  emHandoffOuBloqueado(): Promise<boolean>;
  enviar(input: ChannelSendInput): Promise<ChannelSendResult>;
}

/** Posição fixa no turno: longe do 1..n da mensagem da IA, para não colidir no ledger. */
export const SEQ_DA_IMAGEM = 900;

function hashCurto(texto: string): string {
  let h = 2166136261;
  for (let i = 0; i < texto.length; i++) {
    h ^= texto.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h.toString(36);
}

export function caminhoNaConversa(tenantId: string, conversationId: string, imagem: ImagemDaCampanha): string {
  const ext = imagem.mime === 'image/png' ? 'png' : 'jpg';
  return `${tenantId}/${conversationId}/out-campanha-${hashCurto(imagem.storage_path)}.${ext}`;
}

export type DesfechoDaImagem = 'enviada' | 'ja_enviada' | 'pulada';

export async function enviarImagemDaCampanha(
  deps: DepsDaImagem,
  alvo: { tenantId: string; leadId: string; jobId: string; conversationId: string },
  imagem: ImagemDaCampanha,
): Promise<DesfechoDaImagem> {
  // O caminho vem do grafo publicado, mas é conferido mesmo assim: arquivo de
  // outra organização nunca vira mídia de envio.
  if (!imagem.storage_path.startsWith(`${alvo.tenantId}/campanhas/`)) {
    throw new Error('campanha: a imagem não pertence a esta organização');
  }
  if (await deps.emHandoffOuBloqueado()) return 'pulada';

  const destino = caminhoNaConversa(alvo.tenantId, alvo.conversationId, imagem);
  if (await deps.jaEnviada(alvo.conversationId, destino)) return 'ja_enviada';

  await deps.copiar(imagem.storage_path, destino);
  const r = await deps.enviar({
    tenantId: alvo.tenantId,
    leadId: alvo.leadId,
    jobId: alvo.jobId,
    seq: SEQ_DA_IMAGEM,
    conversationId: alvo.conversationId,
    body: '',
    imagem: { storagePath: destino, mime: imagem.mime },
  });
  switch (r.kind) {
    case 'sent':
    case 'queued':
      return 'enviada';
    case 'already_sent':
      return 'ja_enviada';
    case 'blocked':
      // Pediu para sair entre a checagem e o envio: a mensagem da IA também será vetada.
      return 'pulada';
    case 'failed':
      throw new Error('campanha: o envio da imagem falhou — job re-tentado pela fila');
    case 'unavailable':
      throw new Error(`campanha: canal indisponível ao enviar a imagem (${r.reason})`);
  }
}
