/**
 * O histórico de UM chat, na forma que o CRM entende — sem nome de provider.
 *
 * O adapter traduz o que o canal devolve para esta forma; quem importa (`lib/inbox/importar-historico.ts`) só
 * conhece isto. É o mesmo desenho de `listGroups`: a capacidade é opcional no adapter, e quem chama testa a
 * presença do método em vez de perguntar QUAL provider é (doutrina `docs/doctrine/restricao-de-canal.md`).
 */
import type { AtribuicaoDeAnuncio } from "@/lib/leads/atribuicao-de-anuncio";

export interface MensagemDoHistorico {
  /** O id sob o qual o canal a conhece — o que a ingestão ao vivo grava em `messages.external_id`. */
  externalId: string;
  /**
   * TODAS as formas sob as quais a MESMA mensagem pode já estar gravada (o id composto do webhook, o id cru que o
   * envio do CRM devolve). É por aqui que a importação não duplica o que já chegou ao vivo ou saiu pelo composer.
   */
  idsEquivalentes: string[];
  direcao: "inbound" | "outbound";
  /** ISO 8601. */
  enviadaEm: string;
  /** Vocabulário de `messages.type` (a constraint `messages_type_check`). */
  tipo: string;
  texto: string | null;
  /** A mensagem tinha anexo. O arquivo em si NÃO é importado (ver `lib/inbox/importar-historico.ts`). */
  temMidia: boolean;
  mediaMime: string | null;
  /** Último recibo conhecido (0 = enviada, 1 = servidor, 2 = entregue, 3 = lida), ou null. */
  ack: number | null;
  /** O nome que a PESSOA usa no WhatsApp (só das mensagens que ela mandou). */
  nomeDoContato: string | null;
  /** O anúncio que esta mensagem carregava (o clique em "Conversar no WhatsApp"), quando houver. */
  anuncio: AtribuicaoDeAnuncio | null;
}

export interface PedidoDeHistorico {
  organizationId: string;
  sessionRef: string;
  /** Endereço do chat, já resolvido por `resolveRecipient`. */
  recipient: string;
  /** Teto de mensagens trazidas (as mais recentes). */
  limite: number;
}

/**
 * O canal NÃO guarda histórico para consultar — não é falha de rede, é uma configuração do transporte.
 *
 * Tipo próprio (e não `Error` com texto) para a rota diferenciar "ligue o armazenamento" de "tente de novo":
 * a primeira pede uma ação do dono do canal, a segunda é só esperar.
 */
export class HistoricoIndisponivel extends Error {
  readonly codigo = "historico_indisponivel" as const;
  constructor(detalhe = "O canal não guarda o histórico das conversas.") {
    super(detalhe);
    this.name = "HistoricoIndisponivel";
  }
}

/** Quantas mensagens, no máximo, uma importação traz. Conversa de anos tem mais — e a mais antiga fica de fora. */
export const LIMITE_DO_HISTORICO = 2_000;
