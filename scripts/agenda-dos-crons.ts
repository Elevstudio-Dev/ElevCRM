/**
 * A AGENDA DOS CRONS — uma leitura, para quem quer que precise dela.
 *
 * `docker/scheduler/entrypoint.sh` é a fonte da verdade do que roda e de quando
 * roda numa instalação self-host: uma linha por cron, no formato
 * `<expressão cron>|<timeout em s>|api/v1/cron/<rota>`. Dois consumidores leem
 * isso — a cerca `tests/unit/cron-routes-scheduled.test.ts` (rota sem
 * agendamento reprova o CI) e o relógio de desenvolvimento
 * `scripts/dev-crons.ts` — e até 2026-09-22 o segundo NÃO lia: ele tinha uma
 * lista própria, com 2 das 21 rotas.
 *
 * O preço disso apareceu na tela: o `contact-avatars` roda a cada 10 min em
 * produção e NUNCA rodava aqui, então a foto dos contatos não atualizava na
 * máquina de desenvolvimento. Sem erro, sem log — a feature simplesmente não
 * acontecia, que é o mesmo modo de falha que a cerca existe para evitar do
 * lado do self-host.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

export const CRONTAB = path.join(process.cwd(), "docker", "scheduler", "entrypoint.sh");

export interface CronAgendado {
  /** A expressão como está no arquivo: `* * * * *`, `*\/10 * * * *`, `0 12 * * *`. */
  expressao: string;
  /** Timeout em segundos que o scheduler dá àquela chamada. */
  timeoutSegundos: number;
  /** Caminho completo, com barra inicial: `/api/v1/cron/contact-avatars`. */
  caminho: string;
  /** Só o nome da rota: `contact-avatars`. */
  rota: string;
  /**
   * Período aproximado em ms. O relógio de desenvolvimento não implementa cron:
   * ele traduz a expressão para "de quanto em quanto tempo", que é o que um
   * laço de `setInterval` sabe respeitar.
   */
  periodoMs: number;
}

const MINUTO = 60_000;

/** Traduz a expressão para um período aproximado. Desconhecida → de hora em hora. */
export function periodoDaExpressao(expressao: string): number {
  const campos = expressao.trim().split(/\s+/);
  const [minuto, hora] = campos;
  if (minuto === "*") return MINUTO;
  const cada = /^\*\/(\d+)$/.exec(minuto ?? "");
  if (cada) return Number(cada[1]) * MINUTO;
  // Minuto fixo com hora livre (`17 * * * *`) = uma vez por hora.
  if (hora === "*") return 60 * MINUTO;
  // Minuto e hora fixos (`0 12 * * *`) = uma vez por dia.
  return 24 * 60 * MINUTO;
}

/** As linhas de cron do entrypoint do scheduler, na ordem em que aparecem. */
export function agendaDosCrons(sh: string = readFileSync(CRONTAB, "utf8")): CronAgendado[] {
  const linhas = sh.split("\n");
  const agenda: CronAgendado[] = [];
  for (const linha of linhas) {
    // `<expressão>|<timeout>|api/v1/cron/<rota>` — e nada mais na linha.
    const m = /^([^|#]+)\|(\d+)\|(api\/v1\/cron\/[a-z0-9-]+(?:\?[^\s|]*)?)\s*$/.exec(linha.trim());
    if (!m) continue;
    const expressao = m[1]!.trim();
    const caminhoCru = m[3]!;
    const rota = /api\/v1\/cron\/([a-z0-9-]+)/.exec(caminhoCru)![1]!;
    agenda.push({
      expressao,
      timeoutSegundos: Number(m[2]),
      caminho: `/${caminhoCru}`,
      rota,
      periodoMs: periodoDaExpressao(expressao),
    });
  }
  return agenda;
}

/** Só os nomes de rota, únicos e ordenados — o que a cerca compara com o disco. */
export function rotasAgendadas(sh?: string): string[] {
  return [...new Set(agendaDosCrons(sh).map((c) => c.rota))].sort();
}
