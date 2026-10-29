/**
 * CONTATO "FORA DO FUNIL" — a jornada inteira, no navegador de verdade, contra o banco real.
 *
 *  1. uma pessoa escreve pelo WhatsApp (webhook do canal, o caminho de produção) e vira lead, como sempre;
 *  2. o gestor a marca como "fora do funil" pela ficha: o diálogo mostra ANTES quantos negócios saem, ele cria um
 *     tipo na hora, confirma, e o selo aparece;
 *  3. o negócio some do quadro e do relatório (que o gestor lê pela API), a IA deixa de ser elegível
 *     (a consulta REAL do motor diz `fora_do_funil`), e criar negócio para ela é recusado (409);
 *  4. a pessoa escreve de novo: a conversa chega, o selo está na conversa, e NENHUM negócio nasce;
 *  5. a lista de contatos filtra por "fora do funil" e por tipo, e marca vários de uma vez;
 *  6. desmarcar pela conversa devolve tudo — o MESMO negócio volta ao quadro e ao relatório, e a IA volta a ser elegível;
 *  7. o atendente marca, mas não cria tipo e não entra na tela de tipos; no celular nada estoura.
 *
 * O WhatsApp NÃO é tocado: o provedor aponta para uma porta morta e a "mensagem da pessoa" é um POST no webhook.
 * Os dados vão direto no banco com a service role e o arquivo RECUSA rodar contra banco que não seja local. Tudo o
 * que cria, apaga no fim.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { createClient } from "@supabase/supabase-js";
import { test, expect, type Page } from "@playwright/test";

import { decidirElegibilidadeDaConversaViaSupabase } from "../../lib/ai/elegibilidade/consulta-supabase";
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
  throw new Error(`contato-fora-do-funil escreve no banco — recusado, o destino não é local (${supa.url}).`);
}
const admin = createClient(supa.url, supa.serviceRole, { auth: { autoRefreshToken: false, persistSession: false } });

/** Único por execução: o banco de e2e é compartilhado entre frentes. */
const SUFIXO = String(process.pid).padStart(5, "0").slice(-5);
const NOME = `Marcela Equipe ${SUFIXO}`;
const TELEFONE = `5500001${SUFIXO}`;
const NOME_TIPO = `E2E Equipe ${SUFIXO}`;
const LOTE = `E2E Lote ${SUFIXO}`;

let contatoId = "";
let conversaId = "";
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

async function mandarMensagem(page: Page, texto: string, id: string): Promise<number> {
  const r = await page.request.post(`/api/v1/webhooks/waha/${creds.nascimento!.webhook_token}`, {
    data: {
      event: "message",
      session: creds.nascimento!.session_name,
      payload: {
        id,
        from: `${TELEFONE}@c.us`,
        fromMe: false,
        body: texto,
        timestamp: Math.floor(Date.now() / 1000),
        _data: { notifyName: NOME },
      },
    },
  });
  return r.status();
}

/** Leads (no período) que o RELATÓRIO conta — pela API que a tela usa, no fuso UTC para não depender da hora do teste. */
async function leadsNoRelatorio(page: Page): Promise<number> {
  const dia = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString().slice(0, 10);
  const r = await page.request.get(`/api/v1/relatorios/origens?de=${dia(-2)}&ate=${dia(1)}&fuso=UTC`);
  expect(r.status()).toBe(200);
  return (await r.json()).data.total.leads as number;
}

const leadsDoContato = async () =>
  ((await admin.from("crm_leads").select("id, fora_do_funil").eq("contact_id", contatoId)).data ?? []) as Array<{
    id: string;
    fora_do_funil: boolean;
  }>;

const elegibilidade = () =>
  decidirElegibilidadeDaConversaViaSupabase(admin, {
    organizationId: creds.org_id,
    conversationId: conversaId,
    agora: new Date(),
    ttlMs: 21 * 86_400_000,
  });

async function limpar(): Promise<void> {
  const { data } = await admin
    .from("contacts")
    .select("id")
    .eq("organization_id", creds.org_id)
    .or(`phone_number.like.%${TELEFONE},display_name.like.${LOTE}%`);
  const ids = (data ?? []).map((c) => c.id as string);
  if (ids.length > 0) {
    await admin.from("crm_leads").delete().in("contact_id", ids);
    await admin.from("messages").delete().in("contact_id", ids);
    await admin.from("conversations").delete().in("contact_id", ids);
    await admin.from("contacts").delete().in("id", ids);
  }
  await admin.from("tipos_fora_do_funil").delete().eq("organization_id", creds.org_id).like("nome", "E2E %");
}

test.beforeAll(limpar);
test.afterAll(limpar);

test("1 · quem escreve pelo WhatsApp vira lead, como sempre", async ({ page }) => {
  expect(await mandarMensagem(page, "Oi, aqui é da equipe, preciso falar com vocês", `e2e-fdf-${SUFIXO}-1`)).toBe(200);
  await expect
    .poll(async () => (await admin.from("contacts").select("id").like("phone_number", `%${TELEFONE}`)).data?.length ?? 0, {
      timeout: 30_000,
    })
    .toBe(1);
  contatoId = ((await admin.from("contacts").select("id").like("phone_number", `%${TELEFONE}`).single()).data as { id: string }).id;
  await expect.poll(async () => (await leadsDoContato()).length, { timeout: 30_000 }).toBe(1);
  leadId = (await leadsDoContato())[0]!.id;
  conversaId = ((await admin.from("conversations").select("id").eq("contact_id", contatoId).single()).data as { id: string }).id;

  expect((await leadsDoContato())[0]!.fora_do_funil).toBe(false);
  expect((await elegibilidade())?.permite, "antes de marcar a IA PODE atender").toBe(true);

  await login(page, creds.users.manager!.email);
  await page.goto(`/app/pipelines/${creds.nascimento!.pipeline_default_id}`);
  await expect(page.locator("[data-rfd-draggable-id]").filter({ hasText: NOME })).toBeVisible({ timeout: 30_000 });
});

test("2 · o gestor marca pela ficha: vê antes o que sai, cria o tipo na hora e confirma", async ({ page }, testInfo) => {
  await page.addInitScript(() => localStorage.setItem("elevcrm-theme", "light"));
  await login(page, creds.users.manager!.email);
  await page.goto(`/app/contacts/${contatoId}`);
  await page.getByTestId("botao-fora-do-funil").click();

  const dialogo = page.getByTestId("dialogo-fora-do-funil");
  await expect(dialogo).toBeVisible();
  await expect(dialogo.getByText(/A IA para de atender/)).toBeVisible();
  // O que sai, dito ANTES de confirmar: o negócio que nasceu da mensagem.
  await expect(page.getByTestId("previa-fora-do-funil")).toContainText("Saem do funil e do relatório: 1 negócio aberto");

  await dialogo.getByLabel("Novo tipo").fill(NOME_TIPO);
  await dialogo.getByRole("button", { name: "Criar tipo" }).click();
  await expect(dialogo.getByLabel("Tipo (opcional)")).toHaveValue(/.+/, { timeout: 15_000 });
  await page.screenshot({ path: testInfo.outputPath("dialogo-marcar-claro.png") });

  const antes = await leadsNoRelatorio(page);
  await dialogo.getByTestId("confirmar-fora-do-funil").click();
  await expect(dialogo).toBeHidden({ timeout: 30_000 });

  await expect(page.getByTestId("selo-fora-do-funil").first()).toContainText(`Fora do funil · ${NOME_TIPO}`, { timeout: 30_000 });
  await expect(page.getByTestId("botao-fora-do-funil")).toContainText("Voltar ao funil");

  const c = (await admin.from("contacts").select("fora_do_funil_em, fora_do_funil_tipo_id, fora_do_funil_por").eq("id", contatoId).single()).data as {
    fora_do_funil_em: string | null;
    fora_do_funil_tipo_id: string | null;
    fora_do_funil_por: string | null;
  };
  expect(c.fora_do_funil_em).not.toBeNull();
  expect(c.fora_do_funil_tipo_id).not.toBeNull();
  expect(c.fora_do_funil_por, "a auditoria e o contato dizem QUEM marcou").not.toBeNull();

  // O espelho acompanhou, na mesma transação, e o relatório que o gestor lê perdeu esse negócio.
  expect((await leadsDoContato())[0]!.fora_do_funil).toBe(true);
  expect(await leadsNoRelatorio(page)).toBe(antes - 1);
  guardarAntes = antes;

  const { data: audit } = await admin
    .from("api_audit_log")
    .select("action, resource_id")
    .eq("organization_id", creds.org_id)
    .eq("action", "contact.fora_do_funil_marcado")
    .eq("resource_id", contatoId);
  expect(audit?.length, "a marcação deixa rastro com o contato como recurso").toBe(1);
});

let guardarAntes = 0;

test("3 · o negócio sai do quadro, a IA deixa de ser elegível e criar negócio é recusado", async ({ page }) => {
  await login(page, creds.users.manager!.email);
  await page.goto(`/app/pipelines/${creds.nascimento!.pipeline_default_id}`);
  await expect(page.getByTestId("quadro-do-funil")).toBeVisible({ timeout: 30_000 });
  await expect(page.locator("[data-rfd-draggable-id]").filter({ hasText: NOME })).toHaveCount(0);

  // A consulta REAL que o motor usa (drain e turno) — não um dublê.
  const e = await elegibilidade();
  expect(e).toEqual({ permite: false, motivo: "fora_do_funil", bloqueioPorAllowlist: false });

  // A porta única de criar negócio recusa, com mensagem que o gestor entende.
  const pipeline = creds.nascimento!.pipeline_default_id;
  const etapa = ((await admin.from("crm_stages").select("id").eq("pipeline_id", pipeline).eq("is_won", false).eq("is_lost", false).order("position").limit(1).single()).data as { id: string }).id;
  const r = await page.request.post("/api/v1/leads", {
    data: { pipeline_id: pipeline, stage_id: etapa, title: "Tentativa", contact_id: contatoId, source: "manual" },
  });
  expect(r.status()).toBe(409);
  expect((await r.json()).error.code).toBe("contato_fora_do_funil");
  expect((await leadsDoContato()).length).toBe(1);
});

test("4 · ela escreve de novo: a conversa chega com o selo e NENHUM negócio nasce", async ({ page }, testInfo) => {
  // Fecha o negócio antigo no banco para provar que não nasce outro (sem negócio aberto o lead NASCERIA de novo).
  await admin.from("crm_leads").update({ status: "lost", lost_reason: "teste", closed_at: new Date().toISOString() }).eq("id", leadId);
  expect(await mandarMensagem(page, "Mais uma coisa da equipe", `e2e-fdf-${SUFIXO}-2`)).toBe(200);
  await page.waitForTimeout(3_000);
  expect((await leadsDoContato()).length, "nenhum negócio novo").toBe(1);
  await admin.from("crm_leads").update({ status: "open", lost_reason: null, closed_at: null }).eq("id", leadId);

  await page.addInitScript(() => localStorage.setItem("elevcrm-theme", "dark"));
  await login(page, creds.users.manager!.email);
  await page.goto(`/app/inbox?id=${conversaId}`);
  await expect(page.getByRole("heading", { name: NOME })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("selo-fora-do-funil").first()).toBeVisible();
  // O silêncio da IA tem motivo escrito, em palavras do dono.
  await expect(page.getByTestId("badge-atendimento-humano")).toContainText("fora do funil");
  await page.screenshot({ path: testInfo.outputPath("conversa-fora-do-funil-escuro.png") });
});

test("5 · a lista filtra por 'fora do funil' e marca vários de uma vez", async ({ page }, testInfo) => {
  await admin.from("contacts").insert([
    { organization_id: creds.org_id, display_name: `${LOTE} A` },
    { organization_id: creds.org_id, display_name: `${LOTE} B` },
  ] as never);

  await page.addInitScript(() => localStorage.setItem("elevcrm-theme", "light"));
  await login(page, creds.users.manager!.email);
  await page.goto("/app/contacts");

  // O filtro: só quem está fora do funil.
  await page.getByTestId("filtro-do-funil").click();
  await page.getByTestId("filtro-fora-do-funil").click();
  await expect(page.getByRole("link", { name: NOME, exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("link", { name: `${LOTE} A`, exact: true })).toHaveCount(0);

  // O filtro "Clientes": quem está fora NÃO aparece.
  await page.getByTestId("filtro-do-funil").click();
  await page.getByRole("menuitem", { name: "Clientes" }).click();
  await page.getByPlaceholder(/Buscar por nome/).fill(LOTE);
  await expect(page.getByRole("link", { name: `${LOTE} A`, exact: true })).toBeVisible({ timeout: 30_000 });
  await page.getByPlaceholder(/Buscar por nome/).fill(NOME);
  await expect(page.getByRole("link", { name: NOME, exact: true })).toHaveCount(0, { timeout: 30_000 });

  // Em massa: seleciona os dois do lote e marca.
  await page.getByPlaceholder(/Buscar por nome/).fill(LOTE);
  await expect(page.getByRole("link", { name: `${LOTE} B`, exact: true })).toBeVisible({ timeout: 30_000 });
  await page.getByLabel("Selecionar todos desta página").check();
  await expect(page.getByTestId("barra-de-selecao-de-contatos")).toContainText("2 selecionados");
  await page.getByTestId("marcar-selecionados-fora-do-funil").click();
  const dialogo = page.getByTestId("dialogo-fora-do-funil");
  await expect(dialogo.getByText("2 contatos")).toBeVisible();
  await expect(page.getByTestId("previa-fora-do-funil")).toContainText("Nenhum negócio será afetado.");
  await page.screenshot({ path: testInfo.outputPath("lista-em-massa-claro.png") });
  await dialogo.getByTestId("confirmar-fora-do-funil").click();
  await expect(dialogo).toBeHidden({ timeout: 30_000 });

  const marcados = (await admin.from("contacts").select("id").like("display_name", `${LOTE}%`).not("fora_do_funil_em", "is", null)).data;
  expect(marcados?.length).toBe(2);
});

test("6 · desmarcar pela conversa devolve TUDO: o mesmo negócio volta ao quadro, ao relatório e à IA", async ({ page }) => {
  await login(page, creds.users.manager!.email);
  await page.goto(`/app/inbox?id=${conversaId}`);
  await expect(page.getByRole("heading", { name: NOME })).toBeVisible({ timeout: 30_000 });
  await page.getByTestId("opcoes-da-conversa").click();
  await page.getByTestId("fora-do-funil-na-conversa").click();

  const dialogo = page.getByTestId("dialogo-fora-do-funil");
  await expect(dialogo.getByRole("heading", { name: "Voltar ao funil" })).toBeVisible();
  await expect(page.getByTestId("previa-fora-do-funil")).toContainText("Voltam ao funil e ao relatório: 1 negócio aberto");
  await dialogo.getByTestId("confirmar-fora-do-funil").click();
  await expect(dialogo).toBeHidden({ timeout: 30_000 });

  await expect.poll(async () => (await leadsDoContato())[0]!.fora_do_funil, { timeout: 30_000 }).toBe(false);
  expect((await leadsDoContato()).map((l) => l.id), "é o MESMO negócio, não um novo").toEqual([leadId]);
  expect((await elegibilidade())?.permite).toBe(true);
  expect(await leadsNoRelatorio(page)).toBe(guardarAntes);

  await page.goto(`/app/pipelines/${creds.nascimento!.pipeline_default_id}`);
  await expect(page.locator("[data-rfd-draggable-id]").filter({ hasText: NOME })).toBeVisible({ timeout: 30_000 });
  const c = (await admin.from("contacts").select("fora_do_funil_em, fora_do_funil_tipo_id").eq("id", contatoId).single()).data as Record<string, unknown>;
  expect(c).toEqual({ fora_do_funil_em: null, fora_do_funil_tipo_id: null });
});

test("7 · o atendente marca, mas não cria tipo nem entra na tela de tipos", async ({ page }) => {
  await login(page, creds.users.agent!.email);
  await page.goto(`/app/contacts/${contatoId}`);
  await page.getByTestId("botao-fora-do-funil").click();
  const dialogo = page.getByTestId("dialogo-fora-do-funil");
  await expect(dialogo).toBeVisible();
  await expect(dialogo.getByLabel("Tipo (opcional)")).toBeVisible(); // escolhe entre os que o dono cadastrou
  await expect(dialogo.getByLabel("Novo tipo")).toHaveCount(0);
  await dialogo.getByRole("button", { name: "Cancelar" }).click();

  // A API também fecha a porta (a RLS é a segunda cerca).
  const criar = await page.request.post("/api/v1/tipos-fora-do-funil", { data: { nome: "E2E do atendente" } });
  expect(criar.status()).toBe(403);
  await page.goto("/app/settings/tenant/fora-do-funil");
  await page.waitForURL(/\/403/);

  // O gestor entra e vê o tipo que criou no passo 2.
  await page.context().clearCookies();
  await login(page, creds.users.manager!.email);
  await page.goto("/app/settings/tenant/fora-do-funil");
  await expect(page.getByTestId("tipo-fora-do-funil").filter({ hasText: NOME_TIPO })).toBeVisible({ timeout: 30_000 });
});

test.describe("no celular", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("8 · a lista, o diálogo e a tela de tipos cabem em 390px", async ({ page }, testInfo) => {
    await page.addInitScript(() => localStorage.setItem("elevcrm-theme", "light"));
    await login(page, creds.users.manager!.email);

    const semRolagemLateral = async () => {
      const g = await page.evaluate(() => ({ w: document.documentElement.scrollWidth, c: document.documentElement.clientWidth }));
      expect(g.w, "a janela ganhou rolagem lateral").toBeLessThanOrEqual(g.c);
    };

    await page.goto(`/app/contacts/${contatoId}`);
    await page.getByTestId("botao-fora-do-funil").click();
    const dialogo = page.getByTestId("dialogo-fora-do-funil");
    await expect(dialogo).toBeVisible();
    await expect(page.getByTestId("previa-fora-do-funil")).not.toContainText("Conferindo", { timeout: 15_000 });
    const caixa = (await dialogo.boundingBox())!;
    expect(caixa.x).toBeGreaterThanOrEqual(0);
    expect(caixa.x + caixa.width).toBeLessThanOrEqual(390);
    await semRolagemLateral();
    await page.screenshot({ path: testInfo.outputPath("dialogo-celular.png") });
    await dialogo.getByRole("button", { name: "Cancelar" }).click();

    await page.goto("/app/settings/tenant/fora-do-funil");
    await expect(page.getByTestId("tipo-fora-do-funil").first()).toBeVisible({ timeout: 30_000 });
    await semRolagemLateral();
    await page.screenshot({ path: testInfo.outputPath("tipos-celular.png") });
  });
});
