/**
 * O QUE A LINHA DA LISTA DE CONVERSAS DIZ, DECIDIDO FORA DO COMPONENTE.
 *
 * A linha do WhatsApp conta quatro coisas além do nome: a hora no formato dele (hora de hoje,
 * "Ontem", dia da semana, data), quem falou por último ("Você:"), o que foi dito (o áudio aparece
 * como 🎤 Áudio, não como o literal `[audio]` que o envio gravava) e em que pé a nossa mensagem
 * está (os tiques). Aqui moram as regras; o componente só desenha — e as regras ficam testáveis
 * sem montar tela.
 *
 * Tudo puro: relógio e tradução entram por argumento.
 */
import { differenceInCalendarDays, format, isValid } from "date-fns";
import type { Locale } from "date-fns";

import { type IconeDaCitacao, midiaDoTipo } from "@/lib/inbox/resumo-da-citacao";

/**
 * A hora da última mensagem, como o WhatsApp a escreve.
 *
 *   hoje          → 14:32
 *   ontem         → Ontem
 *   2 a 6 dias    → o dia da semana ("sábado")
 *   mais velho    → 13/10/2026
 *
 * O formato antigo da nossa lista ("há 3 dias", "13/10") obrigava a fazer conta: o WhatsApp
 * mostra o rótulo que a pessoa já usa para falar do dia. `agora` entra por argumento — a regra
 * não lê o relógio, e o teste não depende da data em que roda.
 */
export function horaDaLinha(
  iso: string | null | undefined,
  agora: Date,
  locale: Locale,
  rotuloOntem: string,
): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (!isValid(d)) return "";
  const dias = differenceInCalendarDays(agora, d);
  if (dias === 0) return format(d, "HH:mm");
  // Relógio do servidor adiantado em relação ao do navegador: o dia é "amanhã" — mostrar "Ontem"
  // ou um dia da semana seria inventar. A data completa não inventa nada.
  if (dias < 0) return format(d, "dd/MM/yyyy");
  if (dias === 1) return rotuloOntem;
  if (dias < 7) return format(d, "EEEE", { locale });
  return format(d, "dd/MM/yyyy");
}

export type Tique = "relogio" | "enviada" | "entregue" | "lida" | "falhou";

/**
 * O tique da ÚLTIMA mensagem, quando ela é nossa.
 *
 * Mensagem do cliente não tem tique (no WhatsApp também não): "entregue" ali seria só o nosso
 * banco confirmando que recebeu. `received` e qualquer valor que esta função não conheça também
 * ficam sem tique — melhor calar do que afirmar um estado que não se sabe.
 */
export function tiqueDaUltima(
  direcao: string | null | undefined,
  status: string | null | undefined,
): Tique | null {
  if (direcao !== "outbound") return null;
  switch (status) {
    case "queued":
    case "sending":
      return "relogio";
    case "sent":
      return "enviada";
    case "delivered":
      return "entregue";
    case "read":
      return "lida";
    case "failed":
      return "falhou";
    default:
      return null;
  }
}

export interface PreviaDaLinha {
  /** Fomos nós que falamos por último: a linha começa com "Você:". */
  voce: boolean;
  icone: IconeDaCitacao | null;
  /** O que a pessoa escreveu (texto ou legenda). `null` = nada escrito. */
  trecho: string | null;
  /** O nome do tipo, ou o aviso de conversa vazia, em português, para `t()`. `null` quando o `trecho` basta. */
  rotulo: string | null;
}

/**
 * Os rótulos que a ingestão de um dos canais grava no preview no lugar do texto, e o literal
 * `[tipo]` que os outros canais e o envio pelo CRM gravam. Nenhum deles é "o que a pessoa
 * escreveu": são o NOME do tipo, e a linha já mostra o nome do tipo, com ícone.
 */
const ROTULOS_AUTOMATICOS = new Set([
  "🎤 Mensagem de voz",
  "🎵 Áudio",
  "📷 Imagem",
  "🎬 Vídeo",
  "📎 Documento",
]);

const LITERAL_DE_TIPO = /^\[([a-z_]+)\]$/;

export function previaDaLinha(c: {
  type: string | null | undefined;
  preview: string | null | undefined;
  direction: string | null | undefined;
}): PreviaDaLinha {
  const texto = c.preview?.trim() ?? "";
  const voce = c.direction === "outbound";

  // Conversa que ainda não tem as colunas novas (cache de antes, ou sem backfill) traz só o
  // preview — e o literal `[audio]` ainda diz o tipo. Sem isto ela mostraria colchetes. SÓ quando
  // o tipo é desconhecido: se o banco diz que é texto, "[audio]" é o que a pessoa digitou.
  const literal = LITERAL_DE_TIPO.exec(texto)?.[1];
  const midia = midiaDoTipo(c.type) ?? (c.type ? null : midiaDoTipo(literal));

  if (midia) {
    const eRotulo = texto === "" || LITERAL_DE_TIPO.test(texto) || ROTULOS_AUTOMATICOS.has(texto);
    // O canal oficial grava o contato como "👤 Maria": o ícone já é o da pessoa, o resto é o nome.
    const legenda = eRotulo ? null : texto.replace(/^👤\s*/u, "").trim() || null;
    return { voce, icone: midia.icone, trecho: legenda, rotulo: legenda ? null : midia.rotulo };
  }

  if (texto === "") return { voce, icone: null, trecho: null, rotulo: "Sem mensagens" };
  return { voce, icone: null, trecho: texto, rotulo: null };
}
