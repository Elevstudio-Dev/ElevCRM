/**
 * O RITMO DE ENTRADA do gatilho de silêncio: quantos pacientes entram na fila de
 * follow-up, e com que espaço entre um e outro.
 *
 * Sem ritmo configurado, a varredura inscreve TODOS os contatos parados de uma
 * vez, e o único freio é o pacing do canal. Com ritmo, ela inscreve UM por vez,
 * esperando um intervalo entre 3 e 9 minutos (por exemplo) desde a última
 * inscrição, e para quando o limite das últimas 24 horas é atingido. A fila
 * deixa de ser "todo mundo agora" e passa a ser uma fila de verdade, com ordem
 * (o parado há mais tempo primeiro) e hora prevista para cada um.
 *
 * ⚠️ O INTERVALO É DETERMINÍSTICO, NÃO SORTEADO A CADA VARREDURA. A varredura
 * roda a cada minuto; sortear a cada rodada faria o "intervalo" depender de
 * quantas vezes se tirou o dado (com 1 minuto de tick, quase sempre sairia o
 * mínimo). Aqui o intervalo que vem DEPOIS de uma inscrição é função do id dessa
 * inscrição: o mesmo id dá sempre o mesmo intervalo, não precisa guardar estado
 * novo, e a previsão da tela e o motor concordam.
 *
 * ⚠️ "POR DIA" É JANELA DE 24 HORAS CORRIDAS, não o dia do calendário. O dia do
 * calendário dependeria do fuso da organização e liberaria 25 envios à meia-noite
 * logo depois de 25 às 23h. Janela móvel nunca passa do limite em nenhum
 * período de 24 horas.
 */
import { z } from "zod";

export const ritmoDeEntradaSchema = z
  .strictObject({
    min_minutos: z.number().int().min(1).max(240),
    max_minutos: z.number().int().min(1).max(240),
    limite_por_dia: z.number().int().min(1).max(1000),
  })
  .refine((r) => r.max_minutos >= r.min_minutos, {
    message: "max_minutos precisa ser maior ou igual a min_minutos",
    path: ["max_minutos"],
  });

export type RitmoDeEntrada = z.infer<typeof ritmoDeEntradaSchema>;

export const JANELA_DO_LIMITE_MS = 24 * 60 * 60_000;

/** Quantos minutos esperar DEPOIS da inscrição `idDaUltima`. Sempre em [min, max]. */
export function esperaDepoisDe(idDaUltima: string, ritmo: RitmoDeEntrada): number {
  const faixa = ritmo.max_minutos - ritmo.min_minutos + 1;
  let h = 0;
  for (let i = 0; i < idDaUltima.length; i++) {
    h = (h * 31 + idDaUltima.charCodeAt(i)) >>> 0;
  }
  return ritmo.min_minutos + (h % faixa);
}

export interface EstadoDoRitmo {
  /** Quando e qual foi a última inscrição deste fluxo; `null` = nunca houve. */
  ultimaEm: Date | null;
  ultimaId: string | null;
  /** Inscrições deste fluxo nas últimas 24 horas. */
  nasUltimas24h: number;
}

export type DecisaoDeEntrada =
  | { pode: true }
  | { pode: false; motivo: "limite_do_dia" | "aguardando_intervalo"; liberaEm: Date };

/**
 * Pode entrar mais um agora? Se não, por quê e quando libera.
 *
 * `inicioDaJanela24h` é o instante da inscrição mais antiga que ainda conta no
 * limite — é quando a primeira vaga reabre. `null` quando o limite não foi
 * atingido (não é usado nesse caso).
 */
export function decidirEntrada(
  agora: Date,
  ritmo: RitmoDeEntrada,
  estado: EstadoDoRitmo,
  maisAntigaNaJanela: Date | null,
): DecisaoDeEntrada {
  if (estado.nasUltimas24h >= ritmo.limite_por_dia) {
    const libera = maisAntigaNaJanela
      ? new Date(maisAntigaNaJanela.getTime() + JANELA_DO_LIMITE_MS)
      : new Date(agora.getTime() + JANELA_DO_LIMITE_MS);
    return { pode: false, motivo: "limite_do_dia", liberaEm: libera };
  }
  if (estado.ultimaEm && estado.ultimaId) {
    const libera = new Date(
      estado.ultimaEm.getTime() + esperaDepoisDe(estado.ultimaId, ritmo) * 60_000,
    );
    if (agora.getTime() < libera.getTime()) {
      return { pode: false, motivo: "aguardando_intervalo", liberaEm: libera };
    }
  }
  return { pode: true };
}

/**
 * A hora PREVISTA de entrada de cada um dos próximos `quantos` contatos.
 *
 * É previsão para a tela, não promessa: usa a espera MÉDIA entre inscrições (o
 * id da próxima ainda não existe, então a espera exata não é conhecível) e
 * respeita o limite do dia empurrando o excedente para depois da reabertura
 * da janela. Contato parado que responder antes sai da fila e a lista anda.
 */
export function previsaoDeEntrada(
  agora: Date,
  ritmo: RitmoDeEntrada,
  estado: EstadoDoRitmo,
  inscricoesRecentes: readonly Date[],
  quantos: number,
): Date[] {
  const media = ((ritmo.min_minutos + ritmo.max_minutos) / 2) * 60_000;
  const janela = [...inscricoesRecentes].sort((a, b) => a.getTime() - b.getTime());
  const saida: Date[] = [];

  let cursor = agora.getTime();
  if (estado.ultimaEm && estado.ultimaId) {
    cursor = Math.max(
      cursor,
      estado.ultimaEm.getTime() + esperaDepoisDe(estado.ultimaId, ritmo) * 60_000,
    );
  }

  for (let i = 0; i < quantos; i++) {
    // Tira da janela o que já terá saído das 24h no instante candidato.
    while (janela.length > 0 && janela[0]!.getTime() + JANELA_DO_LIMITE_MS <= cursor) {
      janela.shift();
    }
    if (janela.length >= ritmo.limite_por_dia) {
      cursor = Math.max(cursor, janela[0]!.getTime() + JANELA_DO_LIMITE_MS);
      while (janela.length > 0 && janela[0]!.getTime() + JANELA_DO_LIMITE_MS <= cursor) {
        janela.shift();
      }
    }
    saida.push(new Date(cursor));
    janela.push(new Date(cursor));
    cursor += media;
  }
  return saida;
}
