/**
 * A rolagem do funil — o que a pessoa que opera o CRM sente o dia todo.
 *
 * Quatro coisas que ficaram erradas juntas e que este arquivo mantém juntas:
 *
 *  1. A JANELA não pode ganhar rolagem (nem para os lados, nem para baixo). Texto `sr-only` e faixas
 *     `absolute` dentro do quadro escapavam do recorte dele e esticavam o documento em milhares de
 *     pixels: ao arrastar um card até o fim, quem rolava era a página inteira, e ficava um pedaço vazio.
 *  2. CADA COLUNA rola sozinha. Antes os cards passavam da borda da coluna e quem rolava era o quadro
 *     inteiro, todas as colunas juntas.
 *  3. Arrastar até a borda direita não move a página.
 *  4. Durante um arraste, a roda LATERAL do quadro fica travada — a biblioteca de arrastar mede as
 *     colunas ao levantar o card e não acompanha rolagem aninhada; rolar no meio do arraste faz o card
 *     "achar" a coluna errada. Fora do arraste, a roda lateral rola o quadro normalmente.
 *
 * ⚠️ O que este arquivo NÃO afirma: que dê para arrastar até uma coluna que está fora da tela. A
 * biblioteca não rola o quadro sozinha (rolagem aninhada) e rolar à mão durante o arraste é justamente o
 * que o caso 4 proíbe. Para etapa fora da tela: rolar o quadro e arrastar, ou marcar como ganho/perdido.
 *
 * O funil é criado aqui e arquivado no fim — isolado, para não mexer nas contagens dos outros specs. Os
 * dados vão direto no banco com a service role, e o arquivo RECUSA rodar contra qualquer banco que não
 * seja local.
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { createClient } from "@supabase/supabase-js";
import { test, expect, type Page } from "@playwright/test";

import { credenciaisSupabaseDeTeste, destinoEhLocal } from "../../scripts/lib/env-de-teste";

const CREDS_PATH = path.join(process.cwd(), ".e2e-creds.json");

interface Creds {
  org_id: string;
  password: string;
  users: Record<string, { email: string }>;
}

const creds = JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as Creds;
const supa = credenciaisSupabaseDeTeste();
if (!destinoEhLocal(supa.url)) {
  throw new Error(`funil-rolagem escreve no banco — recusado, o destino não é local (${supa.url}).`);
}
const admin = createClient(supa.url, supa.serviceRole, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const SUFIXO = String(Date.now());
const NOME_DO_FUNIL = `Rolagem E2E ${SUFIXO}`;
const ETAPAS = 9; // 9 colunas de 320px não cabem em 1280px: o quadro TEM que rolar para os lados
const LEADS_NA_PRIMEIRA = 40; // bem mais do que cabe em 720px de altura
const LEADS_NA_SEGUNDA = 2;

let pipelineId = "";
let segundaEtapaId = "";

test.use({ viewport: { width: 1280, height: 720 } });
test.describe.configure({ mode: "serial" });

async function login(page: Page, email: string): Promise<void> {
  await page.goto("/login");
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(creds.password);
  await page.getByRole("button", { name: /entrar/i }).click();
  await page.waitForURL(/\/app\//);
}

test.beforeAll(async () => {
  const { data: pipeline, error: pErr } = await admin
    .from("crm_pipelines")
    .insert({
      organization_id: creds.org_id,
      name: NOME_DO_FUNIL,
      slug: `rolagem-e2e-${SUFIXO}`,
      position: 9_000_000,
    } as never)
    .select("id")
    .single();
  if (pErr || !pipeline) throw new Error(`criar funil: ${pErr?.message}`);
  pipelineId = (pipeline as { id: string }).id;

  const etapas = Array.from({ length: ETAPAS }, (_, i) => ({
    organization_id: creds.org_id,
    pipeline_id: pipelineId,
    name: `Etapa ${i + 1}`,
    slug: `etapa-${i + 1}`,
    position: (i + 1) * 1000,
    // As duas últimas são terminais, como num funil real: é nelas que mora o texto `sr-only`
    // ("Etapa de ganho"/"Etapa de perda") que escapava do quadro.
    is_won: i === ETAPAS - 2,
    is_lost: i === ETAPAS - 1,
  }));
  const { data: criadas, error: sErr } = await admin
    .from("crm_stages")
    .insert(etapas as never)
    .select("id, position");
  if (sErr || !criadas) throw new Error(`criar etapas: ${sErr?.message}`);
  const ordenadas = (criadas as { id: string; position: number }[]).sort(
    (a, b) => Number(a.position) - Number(b.position),
  );

  segundaEtapaId = ordenadas[1]!.id;

  const lead = (stageId: string, titulo: string, pos: number) => ({
    organization_id: creds.org_id,
    pipeline_id: pipelineId,
    stage_id: stageId,
    title: titulo,
    position_in_stage: pos,
    source: "manual",
  });
  const leads = [
    ...Array.from({ length: LEADS_NA_PRIMEIRA }, (_, i) =>
      lead(ordenadas[0]!.id, `Rolagem ${String(i + 1).padStart(2, "0")}`, (i + 1) * 1000),
    ),
    ...Array.from({ length: LEADS_NA_SEGUNDA }, (_, i) =>
      lead(ordenadas[1]!.id, `Segunda ${i + 1}`, (i + 1) * 1000),
    ),
  ];
  const { error: lErr } = await admin.from("crm_leads").insert(leads as never);
  if (lErr) throw new Error(`criar leads: ${lErr.message}`);
});

test.afterAll(async () => {
  if (!pipelineId) return;
  // A organização é compartilhada com as outras specs: 42 leads soltos mudariam o que elas contam.
  // Apaga o que criou; se o histórico do lead impedir (chave estrangeira), cai para ARQUIVAR o funil,
  // que sempre funciona — e nunca falha o teste por limpeza.
  const apagou = await (async () => {
    for (const tabela of ["crm_leads", "crm_stages"]) {
      const { error } = await admin.from(tabela).delete().eq("pipeline_id", pipelineId);
      if (error) return false;
    }
    const { error } = await admin.from("crm_pipelines").delete().eq("id", pipelineId);
    return !error;
  })();
  if (!apagou) {
    await admin
      .from("crm_pipelines")
      .update({ is_archived: true } as never)
      .eq("id", pipelineId);
  }
});

async function abrirOFunil(page: Page): Promise<void> {
  await login(page, creds.users.manager!.email);
  await page.goto(`/app/pipelines/${pipelineId}`);
  await expect(page.getByTestId("quadro-do-funil")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Rolagem 01" })).toBeVisible();
}

const colunas = (page: Page) => page.getByTestId("coluna-do-funil");

async function medidas(page: Page) {
  return page.evaluate(() => {
    const de = document.documentElement;
    const quadro = document.querySelector<HTMLElement>('[data-testid="quadro-do-funil"]')!;
    const main = document.querySelector<HTMLElement>("main")!;
    const listas = [...document.querySelectorAll<HTMLElement>('[data-testid="lista-da-coluna"]')];
    const cols = [...document.querySelectorAll<HTMLElement>('[data-testid="coluna-do-funil"]')];
    return {
      janelaScrollW: de.scrollWidth,
      janelaClientW: de.clientWidth,
      janelaX: window.scrollX,
      janelaY: window.scrollY,
      mainScrollH: main.scrollHeight,
      mainClientH: main.clientHeight,
      quadroScrollTop: quadro.scrollTop,
      quadroScrollLeft: quadro.scrollLeft,
      quadroScrollH: quadro.scrollHeight,
      quadroClientH: quadro.clientHeight,
      quadroScrollW: quadro.scrollWidth,
      quadroClientW: quadro.clientWidth,
      quadroBaixo: quadro.getBoundingClientRect().bottom,
      colunaBaixo: cols[0]!.getBoundingClientRect().bottom,
      lista1Top: listas[0]!.scrollTop,
      lista1ScrollH: listas[0]!.scrollHeight,
      lista1ClientH: listas[0]!.clientHeight,
      lista2Top: listas[1]!.scrollTop,
    };
  });
}

/** Aperta na MARGEM do card: o título é um botão, e a biblioteca não arrasta a partir de botão. */
async function levantarOPrimeiroCard(page: Page) {
  const card = colunas(page).first().locator("[data-rfd-draggable-id]").first();
  const b = (await card.boundingBox())!;
  const x = b.x + 8;
  const y = b.y + b.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 15, y + 8, { steps: 5 });
  // O card foi mesmo levantado? Sem isto, os testes de arrasto passariam sem arrastar nada.
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          [...document.querySelectorAll("[data-rfd-draggable-id]")].filter(
            (e) => getComputedStyle(e).position === "fixed",
          ).length,
      ),
    )
    .toBe(1);
  return { x, y };
}

test("a janela não rola e cada coluna rola sozinha", async ({ page }) => {
  await abrirOFunil(page);

  const m = await medidas(page);

  // 1. A janela inteira parada — o defeito era ela ganhar milhares de pixels para a direita.
  expect(m.janelaScrollW, "a janela não pode ter rolagem lateral").toBeLessThanOrEqual(m.janelaClientW);
  expect(m.mainScrollH, "a área da página não pode rolar na vertical").toBeLessThanOrEqual(m.mainClientH);

  // 2. O quadro só rola para os lados — e tem de rolar, com 9 colunas em 1280px.
  expect(m.quadroScrollW).toBeGreaterThan(m.quadroClientW);
  expect(m.quadroScrollH, "o quadro não rola na vertical: quem rola é cada coluna").toBeLessThanOrEqual(
    m.quadroClientH,
  );
  expect(m.colunaBaixo, "a coluna termina dentro do quadro, não passa dele").toBeLessThanOrEqual(
    m.quadroBaixo,
  );

  // 3. A primeira coluna (40 leads) tem rolagem própria…
  expect(m.lista1ScrollH).toBeGreaterThan(m.lista1ClientH);

  // …e rolá-la não leva mais nada junto: nem a segunda coluna, nem o quadro, nem a janela.
  await page
    .getByTestId("lista-da-coluna")
    .first()
    .evaluate((el) => {
      el.scrollTop = 600;
    });
  const depois = await medidas(page);
  expect(depois.lista1Top).toBeGreaterThan(0);
  expect(depois.lista2Top).toBe(0);
  expect(depois.quadroScrollTop).toBe(0);
  expect(depois.janelaY).toBe(0);
  expect(depois.janelaX).toBe(0);

  // O título da coluna continua à vista enquanto a lista desce: é a lista que rola, não a coluna.
  await expect(colunas(page).first().getByRole("heading", { name: "Etapa 1" })).toBeInViewport();
});

test("arrastar um card até a borda direita não move a página", async ({ page }) => {
  await abrirOFunil(page);

  const { y } = await levantarOPrimeiroCard(page);
  await page.mouse.move(1274, y + 8, { steps: 25 });
  await page.waitForTimeout(1500); // tempo de sobra para a rolagem automática, se houvesse uma

  const m = await medidas(page);
  expect(m.janelaX, "a janela não pode andar para o lado").toBe(0);
  expect(m.janelaScrollW).toBeLessThanOrEqual(m.janelaClientW);

  await page.keyboard.press("Escape");
  await page.mouse.up();
});

test("a roda lateral só rola o quadro fora do arraste", async ({ page }) => {
  await abrirOFunil(page);
  // O mouse fica SOBRE uma coluna — é onde ele está quase sempre. Medido: com `overscroll-contain` na
  // lista, a roda lateral aqui rolava 0px; era preciso acertar a borda do quadro.
  const lista = (await page.getByTestId("lista-da-coluna").nth(1).boundingBox())!;
  const sobreAColuna = { x: lista.x + lista.width / 2, y: lista.y + 60 };
  const rolarOQuadro = async (): Promise<number> => {
    await page.mouse.move(sobreAColuna.x, sobreAColuna.y);
    await page.mouse.wheel(400, 0);
    await page.waitForTimeout(300);
    return (await medidas(page)).quadroScrollLeft;
  };
  const voltarAoInicio = () =>
    page.getByTestId("quadro-do-funil").evaluate((el) => {
      el.scrollLeft = 0;
    });

  // Fora do arraste: livre — senão o operador não alcança as últimas etapas.
  await expect.poll(rolarOQuadro, { timeout: 5000 }).toBeGreaterThan(0);
  await voltarAoInicio();

  // Durante o arraste: travada. (Rolar aqui faria a biblioteca achar a coluna errada.)
  await levantarOPrimeiroCard(page);
  await page.mouse.move(sobreAColuna.x, sobreAColuna.y, { steps: 6 });
  await page.mouse.wheel(500, 0);
  await page.waitForTimeout(400);
  expect((await medidas(page)).quadroScrollLeft, "a roda lateral deve ficar travada no arraste").toBe(0);
  await page.keyboard.press("Escape");
  await page.mouse.up();

  // Soltou ou cancelou: destravou. Cancelar com Esc não pode deixar o quadro preso.
  await expect.poll(rolarOQuadro, { timeout: 5000 }).toBeGreaterThan(0);
});

test("soltar o card em outra coluna move o lead e o movimento persiste", async ({ page }) => {
  await abrirOFunil(page);
  const primeira = colunas(page).nth(0).locator("[data-rfd-draggable-id]");
  const segunda = colunas(page).nth(1).locator("[data-rfd-draggable-id]");
  await expect(primeira).toHaveCount(LEADS_NA_PRIMEIRA);
  await expect(segunda).toHaveCount(LEADS_NA_SEGUNDA);

  await levantarOPrimeiroCard(page);
  const alvo = (await colunas(page).nth(1).boundingBox())!;
  await page.mouse.move(alvo.x + alvo.width / 2, alvo.y + 200, { steps: 25 });
  await page.waitForTimeout(300);
  await page.mouse.up();

  await expect(segunda).toHaveCount(LEADS_NA_SEGUNDA + 1);
  await expect(primeira).toHaveCount(LEADS_NA_PRIMEIRA - 1);

  // Persistiu no banco, não só na tela. A tela atualiza antes da gravação terminar; recarregar
  // nesse intervalo derruba a requisição em voo e parece "não persistiu". Espera o BANCO dizer.
  await expect
    .poll(
      async () => {
        const { data } = await admin
          .from("crm_leads")
          .select("stage_id")
          .eq("pipeline_id", pipelineId)
          .eq("title", "Rolagem 01")
          .maybeSingle();
        return (data as { stage_id: string } | null)?.stage_id;
      },
      { timeout: 10_000 },
    )
    .toBe(segundaEtapaId);
  await page.reload();
  await expect(colunas(page).nth(1).locator("[data-rfd-draggable-id]")).toHaveCount(LEADS_NA_SEGUNDA + 1);
});
