/**
 * A barra superior não se sobrepõe — MEDIDA, não olhada.
 *
 * ─── O defeito, medido (27/10/2026, Chromium, viewport 375x812) ──────────────────────────────
 *
 * Um usuário que pertence a mais de uma organização (então o seletor aparece) via, na mesma linha:
 * o seletor de organização em x=48..186, e Buscar (73-115), Chat da equipe (119-163) e Central de
 * avisos (167-211) POR CIMA dele — texto e ícones um sobre o outro. Medido em 320..1024px, o
 * seletor passava por cima do vizinho em TODAS as larguras; só 1280 estava limpo. E mesmo sem
 * seletor a barra do celular estava errada: o hambúrguer era amassado para 16px (alvo de toque de
 * 44), o nome da marca nunca aparecia — nem em 390 — e em 320/360 a busca passava por cima do selo.
 *
 * A causa não é um `min-w-0` faltando num lugar. É ORÇAMENTO: a direita da barra foi crescendo
 * (idioma e tema em agosto, o chat da equipe em setembro, o selo da Elev na esquerda em 1.19.0)
 * até ocupar 290 dos 351px úteis do celular, e o grupo da esquerda — hambúrguer, marca, seletor —
 * ficava com 45. Um item de flex só encolhe se o conteúdo dele deixar (`min-width: auto`), e o
 * `Button` do seletor não deixava: o grupo encolhia, o filho não, e ele transbordava.
 *
 * ─── O que esta spec mantém junto ────────────────────────────────────────────────────────────
 *
 *  1. Nenhuma peça da barra (links e botões, mais as partes da marca) cobre outra, de 320 a 1280.
 *  2. Nada fica fora da tela, e a PÁGINA não rola de lado — a garantia de 390px que o comentário do
 *     `TopBar` já dava: o nome da marca/organização trunca, a barra não depende dele.
 *  3. O hambúrguer mantém os 44px de alvo de toque abaixo de `md`.
 *  4. Com seletor, o nome da organização aparece (ao menos o começo) a partir de 360px, e a marca
 *     só entra de `xl` em diante; sem seletor a marca fica sempre.
 *  5. Idioma e tema, que saíram da barra abaixo de `lg`, continuam ALCANÇÁVEIS: no menu do usuário.
 *
 * ⚠️ O que ela NÃO prova: o espanhol (rótulos de aba mais longos) e uma organização com logo largo
 * ou nome de 60 caracteres. O que garante esses é o piso (`min-w-*` + truncate) e não a medida.
 *
 * Precisa do `manager` em duas organizações (`seed-e2e-duas-organizacoes`, semeado aqui se faltar)
 * e do `agent`, que é de uma só. A precondição é AFIRMADA: sem o seletor o caso "com seletor" mediria
 * outra barra.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { test, expect, type Page } from "@playwright/test";

const RAIZ = path.resolve(__dirname, "../..");

interface Creds {
  password: string;
  users: Record<string, { email: string } | undefined>;
  duas_orgs?: unknown;
}

function lerCreds(): Creds {
  const p = path.join(RAIZ, ".e2e-creds.json");
  if (!fs.existsSync(p)) throw new Error("`.e2e-creds.json` ausente — rode `scripts/seed-e2e-credentials.ts`");
  let c = JSON.parse(fs.readFileSync(p, "utf8")) as Creds;
  // A spec semeia a própria precondição em vez de depender da ORDEM das outras.
  if (!c.duas_orgs) {
    execFileSync("npx", ["tsx", "scripts/seed-e2e-duas-organizacoes.ts"], { stdio: "inherit" });
    c = JSON.parse(fs.readFileSync(p, "utf8")) as Creds;
  }
  return c;
}

async function entrar(page: Page, creds: Creds, papel: "manager" | "agent"): Promise<void> {
  const usuario = creds.users[papel];
  if (!usuario) throw new Error(`.e2e-creds.json sem o usuário \`${papel}\``);
  await page.goto("/login");
  await page.locator("#email").fill(usuario.email);
  await page.locator("#password").fill(creds.password);
  await page.getByRole("button", { name: /entrar/i }).click();
  await page.waitForURL(/\/app(\/|$)/, { timeout: 30_000 });
}

/** De mesa a celular pequeno: 320 é o iPhone SE de 1ª geração; 1280 é onde a barra sempre coube. */
const LARGURAS = [320, 360, 375, 390, 414, 430, 768, 1024, 1280] as const;
const ALTURA = 812;
/** Mesmos cortes do Tailwind: `md` 768, `lg` 1024, `xl` 1280. */
const MD = 768;
const XL = 1280;

interface Medida {
  clientWidth: number;
  scrollWidth: number;
  sobrepoe: string[];
  foraDaTela: string[];
  /** Largura do hambúrguer, ou null quando está escondido (de `md` em diante). */
  hamburguer: number | null;
  /** O `<a>` da marca está na tela? */
  marcaVisivel: boolean;
  /** Largura em que o NOME do seletor aparece (o `span` truncado), ou null sem seletor. */
  rotuloDoSeletor: number | null;
  /** Largura em que o NOME da marca aparece, ou null quando não há nome (logo) ou a marca saiu. */
  nomeDaMarca: number | null;
}

/** Roda no navegador. Peças = links, botões e os filhos da marca; pai e filho não contam entre si. */
function medirBarra(): Medida {
  const barra = document.querySelector("header")!;
  const visivel = (el: Element) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && getComputedStyle(el).display !== "none";
  };
  const rotulo = (el: Element) =>
    el.getAttribute("data-testid") ||
    el.getAttribute("aria-label") ||
    el.getAttribute("title") ||
    (el.textContent ?? "").trim().slice(0, 24) ||
    el.tagName.toLowerCase();

  const pecas = [...barra.querySelectorAll("a, button, [data-marca-da-barra] > *")]
    .filter(visivel)
    .map((el) => ({ el, nome: `${el.tagName.toLowerCase()}:${rotulo(el)}`, r: el.getBoundingClientRect() }));

  const sobrepoe: string[] = [];
  for (let i = 0; i < pecas.length; i++) {
    for (let j = i + 1; j < pecas.length; j++) {
      const a = pecas[i]!;
      const b = pecas[j]!;
      if (a.el.contains(b.el) || b.el.contains(a.el)) continue;
      const dx = Math.min(a.r.right, b.r.right) - Math.max(a.r.left, b.r.left);
      const dy = Math.min(a.r.bottom, b.r.bottom) - Math.max(a.r.top, b.r.top);
      if (dx > 0.5 && dy > 0.5) sobrepoe.push(`${a.nome} × ${b.nome}: ${dx.toFixed(1)}px`);
    }
  }

  const larguraDaTela = document.documentElement.clientWidth;
  const foraDaTela = pecas
    .filter((p) => p.r.right > larguraDaTela + 0.5 || p.r.left < -0.5)
    .map((p) => `${p.nome} [${p.r.left.toFixed(1)}..${p.r.right.toFixed(1)}]`);

  const hamburguer = [...barra.querySelectorAll("button")].find(
    (b) => b.getAttribute("aria-label") === "Abrir navegação" && visivel(b),
  );
  const marca = barra.querySelector("[data-marca-da-barra]");
  const seletor = barra.querySelector('[data-testid="tenant-switcher"]');
  const rotuloDoSeletor = seletor?.querySelector(":scope > span");
  const nomeDaMarca = marca?.querySelector(":scope > span.truncate");

  return {
    clientWidth: larguraDaTela,
    // `body`, não `documentElement`: o globals.css põe `overflow-x: hidden` nos dois e o do
    // `documentElement` é grampeado no `clientWidth` — a conta daria zero com filho de 3000px.
    scrollWidth: document.body.scrollWidth,
    sobrepoe,
    foraDaTela,
    hamburguer: hamburguer ? hamburguer.getBoundingClientRect().width : null,
    marcaVisivel: !!marca && visivel(marca),
    rotuloDoSeletor: rotuloDoSeletor && visivel(rotuloDoSeletor) ? rotuloDoSeletor.getBoundingClientRect().width : null,
    nomeDaMarca: nomeDaMarca && visivel(nomeDaMarca) ? nomeDaMarca.getBoundingClientRect().width : null,
  };
}

test.describe.configure({ timeout: 120_000 });

const PERFIS = [
  { nome: "com seletor de organização (manager, duas orgs)", papel: "manager", comSeletor: true },
  { nome: "sem seletor (agent, uma org)", papel: "agent", comSeletor: false },
] as const;

for (const perfil of PERFIS) {
  test(`${perfil.nome}: nenhuma peça cobre outra, de 320 a 1280px`, async ({ page }) => {
    const creds = lerCreds();
    await page.setViewportSize({ width: 1280, height: ALTURA });
    await entrar(page, creds, perfil.papel);
    await page.goto("/app/inbox");
    await expect(page.locator("header")).toBeVisible({ timeout: 30_000 });

    // Precondição afirmada: sem isto o caso "com seletor" mediria uma barra sem seletor.
    expect(
      await page.getByTestId("tenant-switcher").count(),
      perfil.comSeletor
        ? "o `manager` não tem seletor de organização — o seed de duas organizações não valeu"
        : "o `agent` tem seletor — ele deveria ser de uma organização só, e o caso mediria a barra errada",
    ).toBe(perfil.comSeletor ? 1 : 0);

    for (const largura of LARGURAS) {
      await page.setViewportSize({ width: largura, height: ALTURA });
      const m = await page.evaluate(medirBarra);
      const onde = `${perfil.nome} em ${largura}px`;

      // 1. Nada cobre nada.
      expect(m.sobrepoe, `${onde}: peças da barra uma por cima da outra`).toEqual([]);

      // 2. Nada fora da tela, e a PÁGINA não rola de lado.
      expect(m.foraDaTela, `${onde}: peças fora da tela`).toEqual([]);
      expect(
        m.scrollWidth,
        `${onde}: body.scrollWidth (${m.scrollWidth}) passou do clientWidth (${m.clientWidth})`,
      ).toBeLessThanOrEqual(m.clientWidth + 1);

      // 3. O hambúrguer é alvo de toque: era amassado para 16px.
      if (largura < MD) {
        expect(m.hamburguer, `${onde}: o hambúrguer sumiu do celular`).not.toBeNull();
        expect(m.hamburguer!, `${onde}: o hambúrguer foi amassado (alvo de toque é 44px)`).toBeGreaterThanOrEqual(44);
      } else {
        expect(m.hamburguer, `${onde}: o hambúrguer deveria estar escondido de \`md\` em diante`).toBeNull();
      }

      if (perfil.comSeletor) {
        // 4a. O nome da organização é o que a pessoa precisa ver: ao menos o começo dele, de 360 em
        // diante. Em 320 o piso é ícone + seta — não há como caber mais com os botões de 44px.
        if (largura >= 360) {
          expect(
            m.rotuloDoSeletor,
            `${onde}: o seletor não mostra nem o começo do nome da organização`,
          ).toBeGreaterThanOrEqual(24);
        }
        // 4b. A marca só entra de `xl` em diante: abaixo disso o seletor leva a largura inteira.
        expect(m.marcaVisivel, `${onde}: a marca ${largura >= XL ? "deveria aparecer" : "deveria ceder ao seletor"}`).toBe(
          largura >= XL,
        );
      } else {
        // 4c. Sem seletor a marca fica sempre — o selo nunca sai.
        expect(m.marcaVisivel, `${onde}: a marca sumiu`).toBe(true);
        // E o nome dela aparece (era invisível mesmo em 390: o hambúrguer e a direita a esmagavam).
        if (largura >= 375 && m.nomeDaMarca !== null) {
          expect(m.nomeDaMarca, `${onde}: o nome da marca não aparece`).toBeGreaterThanOrEqual(16);
        }
      }
    }
  });
}

test("idioma e tema saíram da barra no celular e estão no menu do usuário — e voltam à barra em lg", async ({ page }) => {
  const creds = lerCreds();
  await page.setViewportSize({ width: 375, height: ALTURA });
  await entrar(page, creds, "agent");
  await page.goto("/app/inbox");
  await expect(page.locator("header")).toBeVisible({ timeout: 30_000 });

  // No celular: os botões não estão na barra…
  await expect(page.getByTestId("seletor-de-idioma")).toBeHidden();
  await expect(page.getByRole("button", { name: /^Tema:/ })).toBeHidden();

  // …e a escolha existe, dentro do menu do usuário.
  await page.getByRole("button", { name: "Menu do usuário" }).click();
  const secao = page.getByTestId("preferencias-no-menu");
  await expect(secao, "o menu do usuário não trouxe idioma e tema no celular").toBeVisible();
  await expect(page.getByTestId("menu-idioma-pt-BR")).toHaveAttribute("aria-current", "true");
  await expect(page.getByTestId("menu-idioma-es")).toBeVisible();
  for (const tema of ["light", "dark", "system"]) {
    await expect(page.getByTestId(`menu-tema-${tema}`)).toBeVisible();
  }

  // O menu cabe na tela (não é cortado pela borda do celular).
  const caixa = (await page.getByRole("menu").boundingBox())!;
  expect(caixa.x, "o menu do usuário passa da borda esquerda").toBeGreaterThanOrEqual(0);
  expect(caixa.x + caixa.width, "o menu do usuário passa da borda direita").toBeLessThanOrEqual(375);

  // O tema troca de verdade — é o mesmo `setTheme` do botão da barra. (Idioma recarrega a página e
  // grava na conta; trocá-lo aqui deixaria estado no banco compartilhado, e a troca em si é a do
  // `SeletorDeIdioma`, coberta por `i18n-espanhol-na-tela`.)
  await page.getByTestId("menu-tema-dark").click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");

  // De `lg` em diante os botões voltam à barra e a seção some do menu.
  await page.setViewportSize({ width: 1280, height: ALTURA });
  await expect(page.getByTestId("seletor-de-idioma")).toBeVisible();
  await expect(page.getByRole("button", { name: /^Tema:/ })).toBeVisible();
  await page.getByRole("button", { name: "Menu do usuário" }).click();
  await expect(page.getByTestId("preferencias-no-menu"), "a seção do celular vazou para a mesa").toBeHidden();
});
