import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

/**
 * A TELA DA AGENDA PREENCHE QUANDO CABE E CRESCE QUANDO NÃO CABE.
 *
 * ─── O defeito, visto por quem usa ──────────────────────────────────────────
 *
 * Abrir a Agenda numa janela baixa e não ver o histórico: as quatro abas
 * (próximos, aguardando, passados, cancelados) existiam no DOM com 0px de
 * altura. E a grade virava uma janelinha de ~240px com rolagem própria, onde
 * arrastar um card por várias horas é impossível — o card de origem sai da
 * vista quando o destino entra (`agenda-grade-interativa`, "arrastar para
 * fora da disponibilidade", reprovava 3 em 3). No CI (1280x720, banco limpo)
 * `agenda-tela-do-produto` reprovava; localmente, em janela alta, passava.
 *
 * ─── A causa ────────────────────────────────────────────────────────────────
 *
 * Quando a casca ganhou altura definida (`casca-tem-altura-definida`), o
 * `h-full` da tela da Agenda passou a resolver de verdade e a coluna virou uma
 * caixa de altura fixa. Numa caixa flex, só encolhe abaixo do conteúdo quem tem
 * `min-h-0` — e o histórico era o único filho com `min-h-0` sem `flex-1`, então
 * absorvia o excesso inteiro.
 *
 * ─── O contrato ─────────────────────────────────────────────────────────────
 *
 * UM só: a raiz da tela é `min-h-full`, e não `h-full`. Preenche a janela
 * quando cabe e cresce quando não cabe — a página rola, a grade mostra o dia
 * inteiro, e nada encolhe porque a coluna nunca é menor que o conteúdo.
 *
 * O código carrega dois cintos de segurança que este teste NÃO cobra de
 * propósito — `shrink-0` no histórico e um piso em px na grade —, porque com
 * `min-h-full` eles nunca agem; cobrá-los aqui obrigaria um redesign legítimo
 * (ex.: painel fixo com rolagem interna, como o Google Calendar) a satisfazer
 * três contratos para um comportamento. Se a raiz voltar a `h-full`, este
 * teste é que reprova — e é o suficiente.
 *
 * ─── O que este teste NÃO prova ─────────────────────────────────────────────
 *
 * Ele lê CLASSES, não geometria. A prova de verdade é a E2E
 * (`agenda-tela-do-produto.spec.ts`, histórico visível com as quatro abas;
 * `agenda-grade-interativa.spec.ts`, o arraste). Esta é a rede barata.
 */

const TELA = readFileSync("app/app/agenda/_client.tsx", "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/\/\/.*$/gm, "");

describe("a tela da Agenda numa casca de altura definida", () => {
  it("a raiz é `min-h-full` — preenche quando cabe, cresce quando não cabe", () => {
    // Ancorado no `data-testid` da raiz, não no primeiro `className` do arquivo:
    // um componente auxiliar acima não engana a guarda.
    const raiz = TELA.match(/data-testid="tela-agenda"[\s\S]*?className="([^"]*)"/)?.[1] ?? "";
    expect(raiz, "a raiz da Agenda sumiu ou perdeu a className").not.toBe("");
    expect(raiz, "min-h-full é o contrato: a página rola, a grade mostra o dia inteiro").toMatch(
      /\bmin-h-full\b/,
    );
    expect(raiz, "h-full vira caixa fixa: histórico a 0px e grade de 240px com rolagem própria").not.toMatch(
      /(^|\s)h-full(\s|$)/,
    );
  });
});
