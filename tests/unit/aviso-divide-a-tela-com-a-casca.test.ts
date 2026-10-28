import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

/**
 * O AVISO NO TOPO DIVIDE A TELA COM A CASCA — ele não empurra o fim da página para baixo da dobra.
 *
 * ─── O defeito, visto por quem usa ──────────────────────────────────────────
 *
 * Com a faixa "WhatsApp está desconectado" (ou a de impersonate) no ar, a janela
 * rolava 47px: o fim de toda página, e a barra de rolagem lateral do quadro do
 * funil, ficavam abaixo da dobra. Medido (Chromium 1920x990): `scrollHeight` 1037
 * contra `innerHeight` 990. Sem aviso, 990 = 990.
 *
 * ─── A causa ────────────────────────────────────────────────────────────────
 *
 * Os avisos eram irmãos ACIMA da casca, e a raiz da casca é `h-dvh`: ela
 * começava embaixo do aviso e terminava 47px abaixo da tela. As alturas somavam
 * porque ninguém tinha a conta de que são UMA tela só.
 *
 * ─── O conserto, e o que cada peça segura ───────────────────────────────────
 *
 *   layout        coluna `h-dvh flex-col` com os avisos e a casca dentro — a
 *                 altura é definida, e quem soma é o CSS
 *   avisos        `shrink-0`: ficam com a altura que têm (no celular quebram em
 *                 mais de uma linha; um número fixo não acompanharia)
 *   AppShell      `min-h-0` ao lado do `h-dvh`: a casca encolhe o que sobrar
 *   InboxLayout   `max-h-full`: a conta `100dvh - 3.5rem` não sabe do aviso, e
 *                 sem o teto o composer nascia 47px abaixo do fim do `main`
 *
 * ─── O que este teste NÃO prova ─────────────────────────────────────────────
 *
 * Ele lê CLASSES, não geometria. A prova de verdade é a E2E
 * `aviso-no-topo-nao-estoura-a-tela.spec.ts` (janela medida COM e SEM o aviso,
 * mouse real). Esta é a rede barata: impede a volta da estrutura que causou o
 * defeito — e é a única que cobre o aviso de IMPERSONATE, que a E2E não alcança
 * (o `.env.e2e` não define `IMPERSONATE_COOKIE_SECRET`).
 */

const SEM_COMENTARIO = (caminho: string): string =>
  readFileSync(caminho, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

const LAYOUT = SEM_COMENTARIO("app/app/layout.tsx");
const CASCA = SEM_COMENTARIO("app/app/_components/AppShell.tsx");
const INBOX = SEM_COMENTARIO("components/inbox/InboxLayout.tsx");

const classes = (s: string | undefined): string[] => (s ?? "").split(/\s+/).filter(Boolean);

describe("os avisos e a casca dividem os 100dvh", () => {
  it("o layout põe os avisos e a casca numa coluna de altura DEFINIDA", () => {
    const coluna = LAYOUT.match(/<div className="([^"]*\bflex-col\b[^"]*)">/);
    expect(coluna, "a coluna que reúne os avisos e a casca sumiu do layout").not.toBeNull();
    const c = classes(coluna?.[1]);
    expect(c, "sem `h-dvh` a coluna não tem contra o que dividir").toContain("h-dvh");
    expect(c).toContain("flex");

    // A ordem: marcador da marca > coluna > os dois avisos > o gate. A coluna fica DENTRO do
    // `contents` (o teste da marca exige o literal) e os avisos ficam DENTRO da coluna.
    const marcador = LAYOUT.indexOf("data-marca-org");
    const abre = LAYOUT.indexOf(coluna![0]);
    const impersonate = LAYOUT.indexOf("<ImpersonateBanner");
    const conexao = LAYOUT.indexOf("<ConexaoCaidaBanner");
    const gate = LAYOUT.indexOf("<MfaEnrollGate");
    expect(marcador).toBeGreaterThan(-1); // vacuidade: sem isto `-1 < x` seria verde sem ordenar nada
    expect(abre).toBeGreaterThan(marcador);
    expect(impersonate).toBeGreaterThan(abre);
    expect(conexao).toBeGreaterThan(abre);
    expect(gate).toBeGreaterThan(impersonate);
    expect(gate).toBeGreaterThan(conexao);
  });

  it("os avisos continuam FORA do gate de MFA", () => {
    // O gate bloqueando troca os children por um `fixed inset-0`. Se um aviso morasse dentro
    // dele, o impersonate sumiria justamente enquanto o gate bloqueia.
    const gate = LAYOUT.match(/<MfaEnrollGate[^>]*>([\s\S]*?)<\/MfaEnrollGate>/);
    expect(gate, "o gate de MFA sumiu do layout").not.toBeNull();
    expect(gate![1]).not.toMatch(/Banner/);
  });

  it("os dois avisos têm a altura que têm: `shrink-0`", () => {
    for (const arquivo of ["components/app/ImpersonateBanner.tsx", "components/app/ConexaoCaidaBanner.tsx"]) {
      const fonte = SEM_COMENTARIO(arquivo);
      const raiz = fonte.match(/role="alert"[\s\S]*?className="([^"]*)"/)?.[1];
      expect(raiz, `${arquivo}: o elemento do aviso mudou de forma`).toBeDefined();
      expect(classes(raiz), `${arquivo}: sem shrink-0 o flex pode comprimir o aviso`).toContain("shrink-0");
    }
  });

  it("a raiz da casca pede `h-dvh` E pode encolher (`min-h-0`)", () => {
    const raiz = CASCA.match(/return \(\s*<div className="([^"]*)"/)?.[1];
    expect(raiz, "a raiz da casca mudou de forma").toBeDefined();
    const c = classes(raiz);
    // `h-dvh` é a guarda de `casca-tem-altura-definida`; `min-h-0` é o que deixa o flex encolhê-la
    // pela altura do aviso. Um sem o outro: ou `h-full` vira auto, ou o fim da página desce.
    expect(c).toContain("h-dvh");
    expect(c, "sem min-h-0 a casca não encolhe e o fim da página desce abaixo da dobra").toContain("min-h-0");
  });

  it("o inbox tem teto: a altura que SOBROU ao `main`", () => {
    const grade = INBOX.match(/data-tela-cheia=""\s*className="([^"]*)"/)?.[1];
    expect(grade, "a grade do inbox mudou de forma").toBeDefined();
    const c = classes(grade);
    // A conta da barra segue sendo a de sempre (casa com o `h-14` do TopBar)…
    expect(c).toContain("h-[calc(100dvh-3.5rem)]");
    // …e o teto é o que desconta o aviso.
    expect(c, "sem max-h-full o composer nasce abaixo do fim do main quando há aviso").toContain("max-h-full");
  });
});
