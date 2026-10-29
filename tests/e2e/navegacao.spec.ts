/**
 * Navegação pela barra superior — prova pela TELA.
 *
 * Os testes unitários provam que o registro e os componentes fazem o que
 * dizem. Isto prova o que o usuário vê: que dá para *achar* as coisas — agora
 * sem menu lateral. O menu saiu em 2026-09-10: as cinco abas de uso diário
 * moram na barra superior, ao lado da busca, e TUDO o mais mora em
 * Configurações, que virou o inventário do produto inteiro.
 *
 * ⚠️ O que esta spec media antes, e por que parou de medir:
 *   - "o menu inteiro cabe em 900px sem rolar" — não há menu vertical; o que
 *     se mede agora é que a BARRA não estoura a largura em 1024 e 1280;
 *   - "chega nas Etapas do funil sem passar por Configurações" — passa, e é
 *     de propósito: Configurações deixou de ser "só organização" e virou a
 *     porta de tudo que não é aba. O caso mede que o caminho existe e é curto.
 *
 * Pré-requisito: `.e2e-creds.json` (gerado por scripts/seed-e2e-credentials.ts).
 */
import { mkdirSync } from "node:fs";
import * as path from "node:path";

import { test, expect, type Page } from "@playwright/test";

import { lerCreds, loginComoAdmin } from "./helpers/login-admin";
import { afirmarAdminDeTenantPuro } from "./utils/precondicao";

let creds = lerCreds();
const EVIDENCE = path.join(process.cwd(), ".superpowers", "evidence");

mkdirSync(EVIDENCE, { recursive: true });

// ── Precondição de identidade ────────────────────────────────────────────────
// As abas são `abasPrincipais(isPlatformAdmin, role)` e o inventário é
// `inventario(...)` (lib/navigation/registry.ts), então a suspeita natural é
// que promover o `e2e-admin` a dono do servidor mudasse o que esta spec mede.
//
// ⚠️ MEDIDO, e a suspeita não se confirma: `canSee` é
// `isPlatformAdmin || ROLE_RANK[role] >= ROLE_RANK[minRole]`; `ROLE_RANK.admin`
// é o TETO, e o maior `minRole` do registro é `"admin"`. Para um admin de
// tenant a navegação é IDÊNTICA promovido ou não. Guardar a identidade aqui
// continua valendo (qualquer destino futuro exclusivo do dono apareceria
// primeiro nela), mas registrar a diferença entre "muda" e "poderia mudar" é
// o ponto.
test.beforeAll(async () => {
  await afirmarAdminDeTenantPuro(creds.users.admin!.email);
});

async function login(page: Page, email: string): Promise<void> {
  await page.goto("/login");
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(creds.password);
  await page.getByRole("button", { name: /entrar/i }).click();
  await page.waitForURL(/\/app\//);
}

async function loginAdmin(page: Page): Promise<void> {
  creds = await loginComoAdmin(page, creds);
}

const abas = (page: Page) => page.getByRole("navigation", { name: "Navegação principal" });
const gaveta = (page: Page) => page.getByRole("navigation", { name: "Todas as telas" });

async function expectSemOverflowHorizontal(page: Page, contexto: string): Promise<void> {
  const m = await page.evaluate(() => ({
    // ⚠️ `body.scrollWidth`, NÃO `documentElement`. `app/globals.css` põe
    // `overflow-x: hidden` em `html` E em `body`, e sob isso o `scrollWidth`
    // do `documentElement` é GRAMPEADO no `clientWidth`: a conta dá zero mesmo
    // com um filho de 3000px dentro. Medido com o chromium do repo, viewport
    // 390x844, filho de 3000px — `visible` → 2610, `hidden` → 0, e
    // `body.scrollWidth` = 3000 nos DOIS casos.
    scrollWidth: document.body.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));

  expect(
    m.scrollWidth,
    `${contexto}: body.scrollWidth (${m.scrollWidth}) não pode passar do clientWidth (${m.clientWidth})`,
  ).toBeLessThanOrEqual(m.clientWidth + 1);
}

// `loginComoAdmin` espera a virada da janela TOTP entre logins consecutivos
// (o servidor recusa código repetido), e essa espera sozinha pode consumir os
// 30 s do teto global do playwright.config.ts.
test.describe.configure({ timeout: 120_000 });

test.describe("navegação pela barra superior", () => {
  test("as seis abas do administrador, na ordem, e nenhuma a mais", async ({ page }) => {
    await loginAdmin(page);

    // Cinco de uso diário + Relatórios, que é só de gestor+ (quem atende vê as cinco primeiras).
    const links = abas(page).getByRole("link");
    await expect(links).toHaveText(["Inbox", "Contatos", "Funis", "Agenda", "IA", "Relatórios"]);

    // E NÃO existe menu lateral: o conteúdo começa na borda esquerda da tela.
    // (Não dá para afirmar "nenhum <aside>": o inbox tem o painel de CRM, que
    // é um <aside> legítimo — dentro do conteúdo, não ao lado dele.)
    const esquerdaDoMain = await page.evaluate(
      () => document.querySelector("main")!.getBoundingClientRect().left,
    );
    expect(esquerdaDoMain, "há algo ocupando lugar à esquerda do conteúdo").toBe(0);

    await page.screenshot({
      path: path.join(EVIDENCE, "nav-barra-superior.png"),
      fullPage: false,
    });
  });

  test("Configurações é o inventário: todo grupo, com Etapas do funil dentro do CRM", async ({
    page,
  }) => {
    await loginAdmin(page);

    // A engrenagem ao lado da busca é a segunda porta.
    await page.getByRole("link", { name: "Configurações", exact: true }).click();
    await page.waitForURL(/\/app\/settings$/);

    // Os seis grupos, como seções.
    for (const grupo of ["Atendimento", "CRM", "Agente de IA", "Canais", "Análise", "Organização"]) {
      await expect(page.getByRole("heading", { name: grupo, level: 2 })).toBeVisible();
    }

    await page.screenshot({ path: path.join(EVIDENCE, "nav-inventario.png"), fullPage: true });

    // ⚠️ O ITEM MUDOU DE NOME no passado, e o nome antigo ("Funis") passou para
    // o VIZINHO — a lista de funis, em /app/kanban. A asserção de URL abaixo é
    // específica (`settings/tenant/pipelines`) e não o antigo /pipelines/, que
    // casa com as duas.
    await page.getByRole("link", { name: /Etapas do funil/ }).click();
    await page.waitForURL(/settings\/tenant\/pipelines/);
    await expect(page.getByRole("heading", { name: "Etapas do funil", level: 1 })).toBeVisible();
  });

  test("e a lista de funis é a aba, com nome próprio", async ({ page }) => {
    await loginAdmin(page);
    await abas(page).getByRole("link", { name: "Funis", exact: true }).click();
    await page.waitForURL(/\/app\/kanban/);
    await expect(page.getByRole("heading", { name: "Funis", level: 1 })).toBeVisible();
  });

  test("a aba IA abre o hub, organizado por jornada", async ({ page }) => {
    await loginAdmin(page);

    await abas(page).getByRole("link", { name: "IA" }).click();
    await page.waitForURL(/\/app\/ai$/);

    await expect(page.getByRole("heading", { name: "Montar o agente" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Ensinar o agente" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Acompanhar o agente" })).toBeVisible();

    await page.screenshot({ path: path.join(EVIDENCE, "nav-hub-ia.png"), fullPage: true });

    await page.getByRole("link", { name: /Conhecimento/ }).click();
    await page.waitForURL(/knowledge\/sources/);
  });

  /**
   * O canal oficial saiu de Configurações no PR #105 e virou aba de Conexões.
   * Conexões, por sua vez, deixou de ser item de menu: a porta é o grupo
   * CANAIS do inventário.
   */
  test("chega ao canal oficial por Configurações → Canais → Conexões", async ({ page }) => {
    await loginAdmin(page);

    await page.getByRole("link", { name: "Configurações", exact: true }).click();
    await page.waitForURL(/\/app\/settings$/);
    await page.getByRole("link", { name: /Conexões/ }).click();
    await page.waitForURL(/\/app\/connections/);
    await expect(page.getByRole("tab", { name: /oficial/i })).toBeVisible();
  });

  test("o ⌘K acha o canal oficial por nome, mesmo sem tela própria", async ({ page }) => {
    await loginAdmin(page);

    // Ninguém procura por "Conexões" quando quer o número oficial da Meta —
    // procura por "oficial". A busca varre a descrição além do rótulo.
    await page.keyboard.press("ControlOrMeta+k");
    await page.getByRole("combobox").fill("oficial");
    await expect(page.getByRole("option", { name: /Conexões/ })).toBeVisible();
  });

  test("⌘K abre, filtra e navega", async ({ page }) => {
    await loginAdmin(page);

    await page.keyboard.press("ControlOrMeta+k");
    const busca = page.getByRole("combobox");
    await expect(busca).toBeVisible();

    await busca.fill("conhec");
    await expect(page.getByRole("option", { name: /Conhecimento/ })).toBeVisible();

    await page.screenshot({ path: path.join(EVIDENCE, "nav-command-palette.png") });

    await page.keyboard.press("Enter");
    await page.waitForURL(/knowledge\/sources/);
  });

  /**
   * A barra tem largura fixa e a tela não: em 1024 (o `lg` do Tailwind, onde
   * os rótulos aparecem) tudo — marca, cinco abas com texto, busca e quatro
   * ícones — precisa caber sem estourar a linha. Abaixo de `lg` os rótulos
   * somem e ficam os ícones. Medido por ferramenta, nunca a olho.
   */
  // 768 é o `md`: as abas aparecem (só ícone) e o hambúrguer some — é a faixa
  // mais apertada em que a barra inteira do desktop existe.
  for (const largura of [768, 1024, 1280]) {
    test(`em ${largura}px a barra cabe inteira, sem overflow`, async ({ page }) => {
      await page.setViewportSize({ width: largura, height: 800 });
      await loginAdmin(page);

      await expectSemOverflowHorizontal(page, `barra em ${largura}px`);
      const m = await page.evaluate(() => {
        const header = document.querySelector("header")!;
        const r = header.getBoundingClientRect();
        const filhos = [...header.querySelectorAll("a, button")].map((el) => el.getBoundingClientRect());
        return {
          alturaDaBarra: Math.round(r.height),
          foraDaBarra: filhos.filter((f) => f.right > r.right + 1 || f.bottom > r.bottom + 1).length,
        };
      });
      expect(m.alturaDaBarra, "a barra tem de ser UMA linha (h-14 = 56px)").toBe(56);
      expect(m.foraDaBarra, "nenhum controle da barra pode sair dela").toBe(0);
    });
  }

  test("o inbox ocupa a tela inteira abaixo da barra, sem moldura", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await loginAdmin(page);
    await page.goto("/app/inbox");

    // A grade do inbox declara `data-tela-cheia` e o <main> cede o padding.
    const m = await page.evaluate(() => {
      const grade = document.querySelector("[data-tela-cheia]")!;
      const header = document.querySelector("header")!;
      const g = grade.getBoundingClientRect();
      const h = header.getBoundingClientRect();
      return {
        esquerda: Math.round(g.left),
        largura: Math.round(g.width),
        topo: Math.round(g.top),
        base: Math.round(g.bottom),
        baseDaBarra: Math.round(h.bottom),
        viewport: { w: window.innerWidth, h: window.innerHeight },
      };
    });
    expect(m.esquerda, "a grade começa na borda esquerda — sem menu lateral e sem padding").toBe(0);
    expect(m.largura, "a grade usa a largura inteira").toBe(m.viewport.w);
    expect(m.topo, "a grade começa logo abaixo da barra").toBe(m.baseDaBarra);
    expect(m.base, "a grade termina na borda de baixo — o composer nunca nasce fora da tela").toBe(
      m.viewport.h,
    );

    await page.screenshot({ path: path.join(EVIDENCE, "nav-inbox-tela-cheia.png") });
  });

  test.describe("mobile", () => {
    test.use({ viewport: { width: 390, height: 844 } });

    test("em 390px, as abas somem e a gaveta traz o inventário inteiro", async ({ page }) => {
      await loginAdmin(page);

      await expect(abas(page), "as abas do desktop ficam fora da árvore acessível no mobile").toHaveCount(0);
      await expectSemOverflowHorizontal(page, "shell mobile após login");

      await page.getByRole("button", { name: "Abrir navegação" }).click();
      await expect(gaveta(page)).toBeVisible();
      await expectSemOverflowHorizontal(page, "shell mobile com drawer aberto");
      await page.screenshot({
        path: path.join(EVIDENCE, "nav-mobile-390-drawer-aberta.png"),
        fullPage: true,
      });

      // O inventário inteiro está na gaveta — inclusive o que no desktop só
      // se acha em Configurações.
      await expect(gaveta(page).getByRole("link", { name: "Etapas do funil" })).toBeVisible();

      await gaveta(page).getByRole("link", { name: "Funis", exact: true }).click();
      await page.waitForURL(/\/app\/kanban/);
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await expectSemOverflowHorizontal(page, "shell mobile após navegar pelo drawer");

      await page.screenshot({
        path: path.join(EVIDENCE, "nav-mobile-390-sem-overflow.png"),
        fullPage: true,
      });
    });
  });

  test("um agent não vê o grupo que a permissão esvaziou — nem no inventário", async ({ page }) => {
    await login(page, creds.users.agent!.email);

    await page.getByRole("link", { name: "Configurações", exact: true }).click();
    await page.waitForURL(/\/app\/settings$/);
    // CANAIS é todo manager+/admin: o título não pode sobrar sozinho.
    await expect(page.getByRole("heading", { name: "Canais", level: 2 })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Atendimento", level: 2 })).toBeVisible();
  });
});
