/**
 * O aviso no topo divide a tela com a casca — ele não empurra o fim da página para baixo da dobra.
 *
 * ─── O defeito, medido (27/10/2026, Chromium 1920x990) ──────────────────────────────────────────
 *
 * Com a faixa "WhatsApp está desconectado" (ou a de impersonate) no ar, `scrollHeight` da janela era
 * 1037 contra `innerHeight` 990. Os avisos são irmãos ACIMA da casca, e a raiz da casca é `h-dvh`:
 * ela começava embaixo do aviso e terminava 47px abaixo da tela. O fim de toda página — e a barra de
 * rolagem lateral do quadro do funil — ficava além da dobra, e a janela rolava 47px. Sem aviso,
 * `scrollHeight` == `innerHeight`.
 *
 * ─── O que esta spec mantém junto ───────────────────────────────────────────────────────────────
 *
 *  1. COM aviso, a janela cabe na tela — e a casca termina exatamente na borda de baixo da tela.
 *  2. O gesto de verdade: a roda do mouse sobre a página NÃO move a janela. É isto que a pessoa sente.
 *  3. O inbox (`data-tela-cheia`, altura `100dvh - 3.5rem`) não vaza do `main` por causa do aviso.
 *  4. O CONTROLE, na mesma página: com o mesmo aviso escondido a janela também cabe — é o
 *     comportamento de sempre, que o conserto não pode mexer.
 *
 * ⚠️ O controle esconde o aviso (`display: none`) em vez de depender de uma organização SEM conexão
 * caída: as que a suíte usa acumulam sessões `STOPPED` de specs antigas (medido: seis na org de teste
 * local), e um "sem aviso" que dependesse do banco ficaria pulado justamente onde se roda à mão.
 *
 * Roda em dois tamanhos: o de mesa, e o do celular — onde o aviso QUEBRA em mais de uma linha e fica
 * bem mais alto que os 47px. É o caso que um número fixo para "a altura do aviso" erraria.
 *
 * ⚠️ O que ela NÃO prova: o aviso de IMPERSONATE. Ele exige `IMPERSONATE_COOKIE_SECRET`, que o
 * `.env.e2e` não define de propósito. Os dois avisos são o mesmo mecanismo (irmãos `sticky shrink-0`
 * acima da casca, na mesma coluna), e o teste unitário `aviso-divide-a-tela-com-a-casca` trava a
 * estrutura dos dois.
 *
 * A sessão de canal é criada aqui e apagada no fim. Os dados vão direto no banco com a service role,
 * e o arquivo RECUSA rodar contra qualquer banco que não seja local.
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { createClient } from "@supabase/supabase-js";
import { test, expect, type Page } from "@playwright/test";

import { credenciaisSupabaseDeTeste, destinoEhLocal } from "../../scripts/lib/env-de-teste";
import { REF_KIND_SESSAO } from "../../lib/channels/health";

const CREDS_PATH = path.join(process.cwd(), ".e2e-creds.json");

interface Creds {
  org_id: string;
  password: string;
  users: Record<string, { email: string }>;
}

const creds = JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as Creds;
const supa = credenciaisSupabaseDeTeste();
if (!destinoEhLocal(supa.url)) {
  throw new Error(`aviso-no-topo escreve no banco — recusado, o destino não é local (${supa.url}).`);
}
const admin = createClient(supa.url, supa.serviceRole, {
  auth: { autoRefreshToken: false, persistSession: false },
});

/** Fixo, e não sorteado: se uma execução morrer no meio, a próxima limpa a mesma linha em vez de herdar um aviso. */
const SESSAO = "e2e00000-0000-4000-8000-00000a710a10";

const TELAS = [
  { rota: "/app/inbox", espera: '[data-tela-cheia=""]', nome: "inbox (tela cheia)" },
  { rota: "/app/contacts", espera: "main", nome: "contatos (página com moldura)" },
] as const;

const TAMANHOS = [
  { nome: "mesa 1920x990", width: 1920, height: 990 },
  { nome: "celular 390x844", width: 390, height: 844 },
] as const;

test.describe.configure({ mode: "serial" });

async function login(page: Page, email: string): Promise<void> {
  await page.goto("/login");
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(creds.password);
  await page.getByRole("button", { name: /entrar/i }).click();
  await page.waitForURL(/\/app\//);
}

async function removerAviso(): Promise<void> {
  await admin.from("agent_inbox_items").delete().eq("ref_kind", REF_KIND_SESSAO).eq("ref_id", SESSAO);
  await admin.from("channel_sessions").delete().eq("id", SESSAO);
}

async function criarAviso(): Promise<void> {
  await removerAviso();
  const { error } = await admin.from("channel_sessions").insert({
    id: SESSAO,
    organization_id: creds.org_id,
    waha_session_name: `aviso-no-topo-${Date.now()}`,
    display_name: "Aviso E2E",
    webhook_secret_encrypted: "\\x00",
    status: "SCAN_QR_CODE",
  });
  if (error) throw new Error(`criar a sessão do aviso: ${error.message}`);
}

test.beforeAll(removerAviso);
test.afterAll(removerAviso);

const aviso = (page: Page) =>
  page.getByRole("alert").filter({ has: page.locator('a[href="/app/connections"]') });

async function abrir(page: Page, tela: (typeof TELAS)[number], tamanho: (typeof TAMANHOS)[number]) {
  await page.setViewportSize({ width: tamanho.width, height: tamanho.height });
  await login(page, creds.users.manager!.email);
  await page.goto(tela.rota);
  await expect(page.locator(tela.espera).first()).toBeVisible();
}

async function medidas(page: Page) {
  return page.evaluate(() => {
    const de = document.documentElement;
    const main = document.querySelector<HTMLElement>("main")!;
    const barra = document.querySelector<HTMLElement>("header")!;
    const cheia = document.querySelector<HTMLElement>("[data-tela-cheia]");
    const alerta = [...document.querySelectorAll<HTMLElement>('[role="alert"]')].find((e) =>
      e.querySelector('a[href="/app/connections"]'),
    );
    return {
      alturaDaJanela: window.innerHeight,
      alturaDoDocumento: de.scrollHeight,
      janelaY: window.scrollY,
      avisoAltura: alerta ? alerta.getBoundingClientRect().height : 0,
      barraTopo: barra.getBoundingClientRect().top,
      mainBaixo: main.getBoundingClientRect().bottom,
      mainScrollH: main.scrollHeight,
      mainClientH: main.clientHeight,
      telaCheiaBaixo: cheia ? cheia.getBoundingClientRect().bottom : null,
    };
  });
}

/** O gesto: roda do mouse sobre a página. É o que quem usa faz — e o que movia a janela 47px. */
async function girarARoda(page: Page): Promise<number> {
  const { width, height } = page.viewportSize()!;
  await page.mouse.move(width / 2, height / 2);
  await page.mouse.wheel(0, 3000);
  await page.waitForTimeout(300);
  return page.evaluate(() => window.scrollY);
}

for (const tamanho of TAMANHOS) {
  for (const tela of TELAS) {
    test(`COM aviso, a janela continua cabendo — ${tela.nome}, ${tamanho.nome}`, async ({ page }) => {
      await criarAviso();
      await abrir(page, tela, tamanho);
      // Sem isto o teste passaria sem aviso nenhum — e mediria o controle de novo.
      await expect(aviso(page), "o aviso da sessão semeada não apareceu").toBeVisible();

      const m = await medidas(page);
      const quem = `aviso de ${m.avisoAltura.toFixed(0)}px`;

      // 1. A janela não ganha rolagem — o defeito era 1037 contra 990.
      expect(
        m.alturaDoDocumento,
        `${quem}: o documento passou da tela (${m.alturaDoDocumento} > ${m.alturaDaJanela})`,
      ).toBeLessThanOrEqual(m.alturaDaJanela);

      // 2. A casca começa EMBAIXO do aviso e termina na borda da tela — nem sobra, nem falta.
      expect(m.barraTopo, `${quem}: a barra superior começa embaixo do aviso`).toBeGreaterThanOrEqual(
        m.avisoAltura - 1,
      );
      expect(
        Math.abs(m.mainBaixo - m.alturaDaJanela),
        `${quem}: o fim da página (${m.mainBaixo}) tem de coincidir com a borda da tela (${m.alturaDaJanela})`,
      ).toBeLessThanOrEqual(1);

      // 3. O gesto de verdade.
      expect(await girarARoda(page), `${quem}: a roda moveu a janela`).toBe(0);

      // 4. O inbox cabe no que sobrou ao `main`: o composer não nasce abaixo da borda do aviso.
      if (m.telaCheiaBaixo !== null) {
        expect(
          m.telaCheiaBaixo,
          `${quem}: a tela cheia (${m.telaCheiaBaixo}) vazou do main (${m.mainBaixo})`,
        ).toBeLessThanOrEqual(m.mainBaixo + 1);
        expect(m.mainScrollH, `${quem}: o main do inbox ganhou rolagem própria`).toBeLessThanOrEqual(
          m.mainClientH + 1,
        );
      }

      // 5. O controle, na mesma página: sem o aviso a casca ocupa a tela inteira, como sempre ocupou.
      await aviso(page).evaluate((el) => {
        el.style.display = "none";
      });
      await page.evaluate(() => window.scrollTo(0, 0));
      const c = await medidas(page);
      expect(c.avisoAltura, "o controle precisa de uma tela SEM o aviso").toBe(0);
      expect(c.alturaDoDocumento, "sem aviso a janela já cabia — o conserto não pode mexer nisto").toBeLessThanOrEqual(
        c.alturaDaJanela,
      );
      expect(Math.abs(c.mainBaixo - c.alturaDaJanela)).toBeLessThanOrEqual(1);
      expect(c.barraTopo, "sem aviso a barra superior volta ao topo").toBeLessThanOrEqual(1);
    });
  }
}
