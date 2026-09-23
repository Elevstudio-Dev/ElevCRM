import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { agendaDosCrons, periodoDaExpressao, rotasAgendadas } from "@/scripts/agenda-dos-crons";

/**
 * O RELÓGIO DE DESENVOLVIMENTO CHAMA O QUE A PRODUÇÃO CHAMA.
 *
 * ─── O defeito, visto por quem usa ──────────────────────────────────────────
 *
 * "Não está atualizando a foto dos contatos." O `contact-avatars` roda a cada
 * 10 min numa instalação self-host (`docker/scheduler/entrypoint.sh`) e NUNCA
 * rodava na máquina de desenvolvimento: `scripts/dev-crons.ts` tinha uma lista
 * própria com DUAS rotas das vinte e uma. Medido em 2026-09-22: a última
 * varredura de avatar no banco local era de 03/09, e bastou chamar a rota à
 * mão para cinco fotos aparecerem.
 *
 * O modo de falha é o pior que existe: a feature não dá erro, ela só não
 * acontece — e quem testa conclui que o produto está quebrado.
 *
 * ─── O que se guarda ────────────────────────────────────────────────────────
 *
 * Que a agenda é LIDA do arquivo do scheduler (e não digitada de novo), que o
 * parser enxerga todas as linhas, e que a tradução de cadência não afunda um
 * cron de minuto na faixa dos diários — que é o que o relógio pula por padrão.
 */

const SH = readFileSync("docker/scheduler/entrypoint.sh", "utf8");
const RELOGIO = readFileSync("scripts/dev-crons.ts", "utf8");

describe("o relógio local lê a agenda do scheduler", () => {
  it("o parser enxerga a agenda inteira (controle positivo)", () => {
    // Sem isto, um regex que parasse de casar devolveria lista vazia e os casos
    // abaixo passariam por vacuidade.
    const agenda = agendaDosCrons(SH);
    expect(agenda.length).toBeGreaterThan(15);
    expect(rotasAgendadas(SH)).toContain("contact-avatars");
    for (const cron of agenda) {
      expect(cron.caminho.startsWith("/api/v1/cron/")).toBe(true);
      expect(cron.timeoutSegundos).toBeGreaterThan(0);
      expect(cron.periodoMs).toBeGreaterThan(0);
    }
  });

  it("o relógio NÃO mantém uma lista de rotas própria", () => {
    // A regressão que se está prendendo: alguém acrescenta um array de caminhos
    // aqui, e o relógio volta a divergir da produção em silêncio.
    expect(RELOGIO).toContain("agenda-dos-crons");
    expect(
      RELOGIO,
      "o relógio voltou a ter uma lista literal de rotas — ele deve LER a agenda do scheduler",
    ).not.toMatch(/["'`]\/?api\/v1\/cron\/[a-z0-9-]+["'`]/);
  });

  it("o relógio chama pelo MESMO método do scheduler (GET)", () => {
    // O entrypoint usa `curl -fsS` sem `-X`, ou seja GET. Cinco rotas só
    // exportam GET; com POST o relógio levava 405 nelas.
    expect(SH, "o scheduler passou a mandar método explícito — alinhe o relógio").not.toMatch(
      /curl[^\n]*-X\s/,
    );
    expect(RELOGIO).toMatch(/method:\s*"GET"/);
  });

  it("a cadência traduz minuto, intervalo, hora e dia", () => {
    expect(periodoDaExpressao("* * * * *")).toBe(60_000);
    expect(periodoDaExpressao("*/5 * * * *")).toBe(5 * 60_000);
    expect(periodoDaExpressao("*/10 * * * *")).toBe(10 * 60_000);
    expect(periodoDaExpressao("17 * * * *")).toBe(60 * 60_000);
    expect(periodoDaExpressao("0 12 * * *")).toBe(24 * 60 * 60_000);
    expect(periodoDaExpressao("30 3 * * *")).toBe(24 * 60 * 60_000);
  });

  it("as fotos de contato entram na rodada padrão, e os diários ficam de fora", () => {
    // O corte do relógio é 12h: o que roda mais raro que isso é lote pesado
    // (apagar dados, reprocessar acervo) e só sai com `--tudo`.
    const porRota = new Map(agendaDosCrons(SH).map((c) => [c.rota, c.periodoMs]));
    expect(porRota.get("contact-avatars")).toBeLessThanOrEqual(12 * 60 * 60_000);
    expect(porRota.get("data-retention")).toBeGreaterThan(12 * 60 * 60_000);
  });
});
