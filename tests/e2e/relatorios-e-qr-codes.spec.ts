/**
 * RELATÓRIOS DE ORIGEM E QR CODES RASTREÁVEIS — a jornada inteira, no navegador de verdade, contra o banco real.
 *
 *  1. o gestor cria um QR pela tela (nome, número, mensagem) e o cartão mostra o QR desenhado, o link e a mensagem
 *     final com o código;
 *  2. ler o QR (`/q/<código>`) redireciona para o WhatsApp com a mensagem + `#código` e CONTA a leitura — mas o
 *     robô de pré-visualização do app de mensagens é redirecionado sem contar;
 *  3. a mensagem chega pelo CAMINHO DE PRODUÇÃO (o webhook do canal, o mesmo que o provedor chama) e vira lead novo
 *     com origem QR, ligado à conversa do QR;
 *  4. a tela de QR mostra o funil (leituras → conversas → leads) e o relatório mostra o grupo "QR codes" com o QR
 *     pelo nome; o card do funil diz "QR: <nome>";
 *  5. arquivar o QR faz o endereço impresso responder "não está mais ativo";
 *  6. quem atende NÃO vê a aba Relatórios nem entra na tela; o gestor vê seis abas e a barra não estoura em
 *     768/1024/1280 px;
 *  7. as duas telas cabem no celular, nos dois temas.
 *
 * O WhatsApp NÃO é tocado: o servidor de teste aponta o provedor para uma porta morta, a "mensagem do cliente" é
 * um POST no webhook, e nenhum número real existe aqui. Os dados vão direto no banco com a service role, e o
 * arquivo RECUSA rodar contra banco que não seja local. Tudo o que cria, apaga no fim — inclusive o telefone da
 * sessão de teste, que volta ao que era.
 */
import { execFileSync } from "node:child_process";
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
  nascimento?: { webhook_token: string; session_name: string; pipeline_default_id: string };
}

function lerCreds(): Creds {
  if (!fs.existsSync(CREDS_PATH)) {
    execFileSync("npx", ["tsx", "scripts/seed-e2e-credentials.ts"], { stdio: "inherit" });
  }
  let c = JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as Creds;
  if (!c.users?.manager || !c.users?.agent) {
    execFileSync("npx", ["tsx", "scripts/seed-e2e-credentials.ts"], { stdio: "inherit" });
    c = JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as Creds;
  }
  if (!c.nascimento?.webhook_token) {
    execFileSync("npx", ["tsx", "scripts/seed-e2e-nascimento-do-lead.ts"], { stdio: "inherit" });
    c = JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as Creds;
  }
  return c;
}

const creds = lerCreds();

const supa = credenciaisSupabaseDeTeste();
if (!destinoEhLocal(supa.url)) {
  throw new Error(`relatorios-e-qr-codes escreve no banco — recusado, o destino não é local (${supa.url}).`);
}
const admin = createClient(supa.url, supa.serviceRole, {
  auth: { autoRefreshToken: false, persistSession: false },
});

/** Único por execução: o banco de e2e é compartilhado entre frentes. */
const SUFIXO = String(process.pid).padStart(5, "0").slice(-5);
const NOME_QR = `E2E QR ${SUFIXO}`;
const NOME_CLIENTE = `Cliente QR ${SUFIXO}`;
const TELEFONE_CLIENTE = `5500000${SUFIXO}`;
/** Número de teste da sessão: 13 dígitos, nenhum real. */
const TELEFONE_DA_SESSAO = "5500000000099";

const IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";

let sessaoId = "";
let telefoneOriginal: string | null = null;
let codigo = "";
let qrId = "";
let leadId = "";

test.use({ viewport: { width: 1280, height: 900 } });
test.describe.configure({ mode: "serial" });

async function login(page: Page, email: string): Promise<void> {
  await page.goto("/login");
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(creds.password);
  await page.getByRole("button", { name: /entrar/i }).click();
  await page.waitForURL(/\/app\//, { timeout: 30_000 });
}

/** Uma mensagem de texto de cliente, como o provedor a entrega ao webhook do canal. */
async function mandarMensagem(page: Page, texto: string, id: string): Promise<number> {
  const r = await page.request.post(`/api/v1/webhooks/waha/${creds.nascimento!.webhook_token}`, {
    data: {
      event: "message",
      session: creds.nascimento!.session_name,
      payload: {
        id,
        from: `${TELEFONE_CLIENTE}@c.us`,
        fromMe: false,
        body: texto,
        timestamp: Math.floor(Date.now() / 1000),
        _data: { notifyName: NOME_CLIENTE },
      },
    },
  });
  return r.status();
}

async function limpar(): Promise<void> {
  // QR e tudo que pende dele (leituras, conversas) por cascata.
  await admin.from("qr_codes").delete().eq("organization_id", creds.org_id).like("nome", "E2E QR %");

  const { data } = await admin
    .from("contacts")
    .select("id")
    .eq("organization_id", creds.org_id)
    .like("phone_number", `%${TELEFONE_CLIENTE}`);
  const ids = (data ?? []).map((c) => c.id as string);
  if (ids.length === 0) return;
  await admin.from("crm_leads").delete().in("contact_id", ids);
  await admin.from("messages").delete().in("contact_id", ids);
  await admin.from("conversations").delete().in("contact_id", ids);
  await admin.from("contacts").delete().in("id", ids);
}

test.beforeAll(async () => {
  await limpar();
  const { data, error } = await admin
    .from("channel_sessions")
    .select("id, phone_number")
    .eq("organization_id", creds.org_id)
    .eq("waha_session_name", creds.nascimento!.session_name)
    .single();
  if (error || !data) throw new Error(`sessão de teste ausente: ${error?.message}`);
  sessaoId = (data as { id: string }).id;
  telefoneOriginal = (data as { phone_number: string | null }).phone_number;
  await admin.from("channel_sessions").update({ phone_number: TELEFONE_DA_SESSAO } as never).eq("id", sessaoId);
});

test.afterAll(async () => {
  await limpar();
  if (sessaoId) {
    await admin.from("channel_sessions").update({ phone_number: telefoneOriginal } as never).eq("id", sessaoId);
  }
});

const cartaoDoQr = (page: Page) => page.getByTestId("cartao-do-qr").filter({ hasText: NOME_QR });
/** O número grande de uma etapa do funil do cartão (o 2º <span>: rótulo, VALOR, percentual). */
const valorDaEtapa = (page: Page, etapa: string) =>
  cartaoDoQr(page).getByTestId(`funil-${etapa}`).locator("span").nth(1);

async function semRolagemLateral(page: Page): Promise<void> {
  const geo = await page.evaluate(() => ({
    w: document.documentElement.scrollWidth,
    c: document.documentElement.clientWidth,
  }));
  expect(geo.w, "a janela ganhou rolagem lateral").toBeLessThanOrEqual(geo.c);
}

test("1 · o gestor cria o QR pela tela e o cartão mostra o QR, o link e a mensagem com o código", async ({ page }) => {
  await login(page, creds.users.manager!.email);
  await page.goto("/app/relatorios/qr-codes");

  await page.getByRole("button", { name: /Novo QR code/ }).first().click();
  const dialogo = page.getByRole("dialog");
  await dialogo.getByLabel("Nome").fill(NOME_QR);
  await dialogo.locator("#qr-numero").selectOption(sessaoId);
  await expect(dialogo.getByTestId("previa-da-mensagem")).toContainText("Olá! Gostaria de saber mais. #······");
  await dialogo.getByRole("button", { name: "Criar QR code" }).click();
  await expect(dialogo).toBeHidden({ timeout: 30_000 });

  const cartao = cartaoDoQr(page);
  await expect(cartao).toBeVisible({ timeout: 30_000 });
  // O QR foi DESENHADO (a lib gera um <svg> dentro do role=img), não só reservado o espaço.
  await expect(cartao.locator('[role="img"] svg')).toBeVisible();

  codigo = ((await cartao.getByTestId("codigo-do-qr").innerText()) ?? "").trim();
  expect(codigo).toMatch(/^[2-9A-HJKMNP-Z]{6}$/);
  await expect(cartao.getByTestId("link-do-qr")).toHaveText(new RegExp(`/q/${codigo}$`));
  await expect(cartao.getByTestId("mensagem-do-qr")).toHaveText(`Olá! Gostaria de saber mais. #${codigo}`);

  const { data } = await admin.from("qr_codes").select("id, channel_session_id").eq("codigo", codigo).single();
  qrId = (data as { id: string }).id;
  expect((data as { channel_session_id: string }).channel_session_id).toBe(sessaoId);
});

test("2 · ler o QR abre o WhatsApp com a mensagem + código e conta UMA leitura (o robô não conta)", async ({ page }) => {
  const leitura = await page.request.get(`/q/${codigo}`, {
    maxRedirects: 0,
    headers: { "user-agent": IPHONE },
  });
  expect(leitura.status()).toBe(302);
  const destino = leitura.headers()["location"] ?? "";
  expect(destino.startsWith(`https://wa.me/${TELEFONE_DA_SESSAO}?text=`), destino).toBe(true);
  expect(destino).toContain(`%23${codigo}`);
  expect(decodeURIComponent(destino)).toContain("Olá! Gostaria de saber mais.");

  // A pré-visualização de link do próprio app de mensagens: segue para o mesmo destino, não entra na conta.
  const robo = await page.request.get(`/q/${codigo}`, {
    maxRedirects: 0,
    headers: { "user-agent": "WhatsApp/2.23.20.0 A" },
  });
  expect(robo.status()).toBe(302);

  const { count } = await admin
    .from("qr_code_leituras")
    .select("id", { count: "exact", head: true })
    .eq("qr_code_id", qrId);
  expect(count, "só a leitura do celular conta").toBe(1);

  // Código que não existe: página neutra, não erro de servidor, e nada é contado.
  const inexistente = await page.request.get("/q/ZZZZZZ", { maxRedirects: 0, headers: { "user-agent": IPHONE } });
  expect(inexistente.status()).toBe(404);
});

test("3 · a mensagem com #código chega pelo webhook do canal e vira lead novo com origem QR", async ({ page }) => {
  const status = await mandarMensagem(page, `Olá! Gostaria de saber mais. #${codigo}`, `e2e-qr-${SUFIXO}-1`);
  expect(status, "o webhook precisa ACEITAR — 4xx aqui e o resto mede o vazio").toBe(200);

  await expect
    .poll(
      async () => {
        const { data } = await admin.from("qr_code_conversas").select("lead_id").eq("qr_code_id", qrId);
        return (data as Array<{ lead_id: string | null }> | null)?.[0]?.lead_id ?? null;
      },
      { timeout: 30_000, message: "a conversa do QR ganhou o lead que nasceu dela" },
    )
    .not.toBeNull();

  const { data: ligacao } = await admin.from("qr_code_conversas").select("lead_id").eq("qr_code_id", qrId);
  leadId = (ligacao as Array<{ lead_id: string }>)[0]!.lead_id;
  const { data: lead } = await admin
    .from("crm_leads")
    .select("source, source_metadata, tags")
    .eq("id", leadId)
    .single();
  const l = lead as { source: string; source_metadata: Record<string, unknown>; tags: string[] };
  expect(l.source).toBe("qr_code");
  expect(l.source_metadata).toMatchObject({ qr_code_id: qrId, qr_code_nome: NOME_QR, qr_code_codigo: codigo });
  expect(l.tags).toContain("QR code");

  // Mandar o código DE NOVO não infla o número: a mesma conversa conta uma vez por QR.
  expect(await mandarMensagem(page, `de novo #${codigo}`, `e2e-qr-${SUFIXO}-2`)).toBe(200);
  await page.waitForTimeout(2_000);
  const { count } = await admin
    .from("qr_code_conversas")
    .select("id", { count: "exact", head: true })
    .eq("qr_code_id", qrId);
  expect(count).toBe(1);
});

test("4 · a tela de QR mostra o funil e o relatório mostra o QR pelo nome", async ({ page }, testInfo) => {
  await page.addInitScript(() => localStorage.setItem("elevcrm-theme", "light"));
  await login(page, creds.users.manager!.email);

  await page.goto("/app/relatorios/qr-codes");
  await expect(cartaoDoQr(page)).toBeVisible({ timeout: 30_000 });
  await expect(valorDaEtapa(page, "leituras")).toHaveText("1", { timeout: 30_000 });
  await expect(valorDaEtapa(page, "conversas")).toHaveText("1");
  await expect(valorDaEtapa(page, "leads")).toHaveText("1");
  await expect(valorDaEtapa(page, "vendas")).toHaveText("0");
  await page.screenshot({ path: testInfo.outputPath("qr-codes-claro.png"), fullPage: true });

  await page.goto("/app/relatorios");
  await expect(page.getByTestId("resumo-leads")).toBeVisible({ timeout: 30_000 });
  await expect
    .poll(async () => Number(await page.getByTestId("resumo-leads").locator("span").nth(1).innerText()))
    .toBeGreaterThanOrEqual(1);

  const grupo = page.getByRole("button", { name: "QR codes" });
  await expect(grupo).toBeVisible();
  await grupo.click();
  const linha = page.getByRole("row").filter({ hasText: NOME_QR });
  await expect(linha).toBeVisible();
  await expect(linha.getByRole("cell").nth(1)).toHaveText("1"); // leads
  await page.screenshot({ path: testInfo.outputPath("relatorio-claro.png") });

  // O gráfico por dia: a rolagem é interna à tela, então a captura vem DEPOIS de levá-lo à vista. O gráfico tem
  // de ter barras desenhadas (não só o espaço reservado) e os dias no eixo.
  await page.setViewportSize({ width: 1280, height: 1400 }); // alto o bastante para a tela inteira caber na captura
  await expect(page.getByRole("heading", { name: "Leads por dia" })).toBeVisible();
  await expect(page.locator(".recharts-bar-rectangle").first()).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("relatorio-grafico-claro.png") });
});

test("5 · o card do funil diz de qual QR o lead veio", async ({ page }) => {
  await login(page, creds.users.manager!.email);
  await page.goto(`/app/pipelines/${creds.nascimento!.pipeline_default_id}`);
  const card = page.locator("[data-rfd-draggable-id]").filter({ hasText: NOME_CLIENTE });
  await expect(card).toBeVisible({ timeout: 30_000 });
  const origem = card.getByTestId("origem-e-prazo").locator("[data-origem]");
  await expect(origem).toHaveAttribute("data-origem", "qr");
  await expect(origem).toContainText(`QR: ${NOME_QR}`);
});

test("6 · arquivar o QR faz o endereço impresso dizer que não está mais ativo", async ({ page }, testInfo) => {
  await page.addInitScript(() => localStorage.setItem("elevcrm-theme", "dark"));
  await login(page, creds.users.manager!.email);
  await page.goto("/app/relatorios/qr-codes");

  await cartaoDoQr(page).getByRole("button", { name: /Arquivar/ }).click();
  const confirmacao = page.getByRole("alertdialog");
  await expect(confirmacao).toContainText("não está mais ativo");
  await confirmacao.getByRole("button", { name: "Arquivar" }).click();

  await expect(page.getByRole("heading", { name: "Arquivados" })).toBeVisible({ timeout: 30_000 });
  await expect(cartaoDoQr(page).getByText("Arquivado", { exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("qr-codes-escuro.png"), fullPage: true });

  const lida = await page.request.get(`/q/${codigo}`, { maxRedirects: 0, headers: { "user-agent": IPHONE } });
  expect(lida.status()).toBe(410);
  expect(await lida.text()).toContain("não está mais ativo");
  const { count } = await admin
    .from("qr_code_leituras")
    .select("id", { count: "exact", head: true })
    .eq("qr_code_id", qrId);
  expect(count, "QR arquivado não conta leitura").toBe(1);

  // E o fato histórico fica: a conversa e o lead já atribuídos continuam no relatório do QR.
  const { count: conversas } = await admin
    .from("qr_code_conversas")
    .select("id", { count: "exact", head: true })
    .eq("qr_code_id", qrId);
  expect(conversas).toBe(1);

  // Reativar devolve o endereço à vida.
  await cartaoDoQr(page).getByRole("button", { name: /Reativar/ }).click();
  await expect(page.getByRole("heading", { name: "Arquivados" })).toHaveCount(0, { timeout: 30_000 });
  const volta = await page.request.get(`/q/${codigo}`, { maxRedirects: 0, headers: { "user-agent": IPHONE } });
  expect(volta.status()).toBe(302);
});

test("7 · quem atende não vê a aba nem entra; o gestor vê seis abas e a barra não estoura", async ({ page }) => {
  const abas = page.getByRole("navigation", { name: "Navegação principal" }).getByRole("link");

  await login(page, creds.users.agent!.email);
  await expect(abas).toHaveCount(5);
  await expect(abas.filter({ hasText: "Relatórios" })).toHaveCount(0);
  await page.goto("/app/relatorios");
  await page.waitForURL(/\/app\/inbox/);
  await page.goto("/app/relatorios/qr-codes");
  await page.waitForURL(/\/app\/inbox/);
  // A API também fecha a porta (a RLS é a segunda cerca): o atendente não lê o relatório pelo endereço.
  const api = await page.request.get("/api/v1/relatorios/origens?de=2026-10-01&ate=2026-10-07");
  expect(api.status()).toBe(403);
  const apiQr = await page.request.get("/api/v1/qr-codes");
  expect(apiQr.status()).toBe(403);

  await page.context().clearCookies();
  await login(page, creds.users.manager!.email);
  await expect(abas).toHaveCount(6);
  await expect(abas.nth(5)).toHaveAttribute("title", "Relatórios");

  for (const largura of [1280, 1024, 768]) {
    await page.setViewportSize({ width: largura, height: 900 });
    await page.goto("/app/relatorios");
    await expect(page.getByTestId("resumo-leads")).toBeVisible({ timeout: 30_000 });
    await semRolagemLateral(page);
    // Cada uma das seis abas cabe DENTRO da janela (em 768 só o ícone aparece).
    for (let i = 0; i < 6; i++) {
      const caixa = (await abas.nth(i).boundingBox())!;
      expect(caixa.x, `aba ${i} em ${largura}px`).toBeGreaterThanOrEqual(0);
      expect(caixa.x + caixa.width, `aba ${i} em ${largura}px`).toBeLessThanOrEqual(largura);
    }
  }
});

test.describe("no celular", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("8 · as duas telas cabem em 390px, sem rolagem lateral", async ({ page }, testInfo) => {
    await page.addInitScript(() => localStorage.setItem("elevcrm-theme", "light"));
    await login(page, creds.users.manager!.email);

    await page.goto("/app/relatorios");
    await expect(page.getByTestId("resumo-leads")).toBeVisible({ timeout: 30_000 });
    await semRolagemLateral(page);
    await page.screenshot({ path: testInfo.outputPath("relatorio-celular.png"), fullPage: true });

    await page.goto("/app/relatorios/qr-codes");
    await expect(cartaoDoQr(page)).toBeVisible({ timeout: 30_000 });
    await semRolagemLateral(page);
    // O QR e o link por extenso ficam DENTRO do cartão.
    const cartao = (await cartaoDoQr(page).boundingBox())!;
    for (const alvo of [cartaoDoQr(page).locator('[role="img"]'), cartaoDoQr(page).getByTestId("link-do-qr")]) {
      const b = (await alvo.boundingBox())!;
      expect(b.x).toBeGreaterThanOrEqual(cartao.x - 1);
      expect(b.x + b.width).toBeLessThanOrEqual(cartao.x + cartao.width + 1);
    }
    await page.screenshot({ path: testInfo.outputPath("qr-codes-celular.png"), fullPage: true });
  });
});
