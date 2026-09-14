import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

/**
 * A IMAGEM DO APP ACEITA UM CABEÇALHO MAIOR QUE O PADRÃO DO NODE.
 *
 * ─── O defeito, visto por quem usa ──────────────────────────────────────────
 *
 * Tela cinza do navegador, "Esta página não está funcionando — HTTP ERROR
 * 431", em `/login`. Nada no log do app, porque o Node recusa a requisição
 * ANTES de o Next vê-la: o cabeçalho passou de 16 KB, e quem passa é cookie.
 *
 * ─── Onde isso acontece de verdade ──────────────────────────────────────────
 *
 * - Em desenvolvimento: `localhost` não separa cookie por porta, e o navegador
 *   manda para a 3100 tudo que os outros projetos locais gravaram (medido em
 *   2026-09-14: 20 KB → 431).
 * - Em produção: o CRM vive num subdomínio (`crm.empresa.com.br`) e recebe todo
 *   cookie de `.empresa.com.br` — site, GTM, analytics, chat — mais o token do
 *   Supabase em pedaços de ~3 KB. É questão de tempo.
 *
 * ─── O que este teste prova ─────────────────────────────────────────────────
 *
 * Que o Dockerfile do app sobe `--max-http-header-size` para pelo menos o
 * dobro do padrão, no estágio de RUNTIME (o do `CMD ["node", "server.js"]`), e
 * não só no de build. A prova de comportamento foi feita à mão na imagem
 * construída (cookie de 20 KB → 200; 40 KB → 431, acima do novo teto).
 */

const DOCKERFILE = readFileSync("Dockerfile", "utf8");

describe("a imagem do app aceita cabeçalho grande", () => {
  it("o runtime sobe --max-http-header-size para 32 KB ou mais", () => {
    const runtime = DOCKERFILE.slice(DOCKERFILE.indexOf('CMD ["node", "server.js"]') - 4000);
    const m = /--max-http-header-size=(\d+)/.exec(runtime);
    expect(m, "o Dockerfile perdeu o --max-http-header-size do runtime: 431 volta com cookie grande").not.toBeNull();
    expect(Number(m![1])).toBeGreaterThanOrEqual(32768);
  });
});
