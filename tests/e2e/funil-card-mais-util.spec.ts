/**
 * O CARD DO FUNIL SEM BURACOS E COM O QUE O VENDEDOR PROCURA — no navegador de verdade, contra o banco real.
 *
 * O dono olhou o quadro e disse que os cards estavam vazios. O que muda, e o que este arquivo mede:
 *
 *  1. o card CHEIO mostra tudo o que o banco sabe: telefone do cliente, tags em chips (com a cor do
 *     marcador da empresa), QUEM falou por último ("Cliente:"), o prazo e a origem;
 *  2. o card esparso (sem valor, sem contato, sem conversa) não reserva espaço: o valor é "R$ 0,00" e
 *     NÃO um traço, e ele é mais BAIXO que o cheio — a altura segue o conteúdo;
 *  3. nossa mensagem é "Você:" e o áudio chega como "Áudio" (não como o literal `[audio]`), e o prazo
 *     que passou é sinalizado como atrasado.
 *
 * O dado de cada linha vem da rota do quadro (`/api/v1/pipelines/{id}/board`): conversa (direção e tipo
 * da última mensagem — espelho da migration 0219), contato, tags, prazo e origem. Os dados vão direto
 * no banco com a service role, e o arquivo RECUSA rodar contra banco que não seja local. Tudo o que
 * cria, apaga no fim — inclusive o vocabulário de marcadores, que é devolvido ao que era.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { createClient } from "@supabase/supabase-js";
import { test, expect, type Page } from "@playwright/test";

import { phoneForDisplay } from "../../lib/channels/phone-variants";
import { CLASSE_DE_COR } from "../../lib/marcadores/cores";
import { credenciaisSupabaseDeTeste, destinoEhLocal } from "../../scripts/lib/env-de-teste";

const CREDS_PATH = path.join(process.cwd(), ".e2e-creds.json");

interface Creds {
  org_id: string;
  password: string;
  users: Record<string, { email: string }>;
  queue?: { conversation_id: string };
}

execFileSync(process.execPath, ["--import", "tsx", "scripts/seed-e2e-credentials.ts"], { stdio: "inherit" });
execFileSync(process.execPath, ["--import", "tsx", "scripts/seed-e2e-queue.ts"], { stdio: "inherit" });
const creds = JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as Creds;
if (!creds.queue) throw new Error("bloco `queue` ausente em .e2e-creds.json após o seed");

const supa = credenciaisSupabaseDeTeste();
if (!destinoEhLocal(supa.url)) {
  throw new Error(`funil-card-mais-util escreve no banco — recusado, o destino não é local (${supa.url}).`);
}
const admin = createClient(supa.url, supa.serviceRole, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const SUFIXO = String(Date.now());
const FONE = (n: number) => `+55000000${String(n).padStart(4, "0")}`;

const TITULO_CHEIO = "Orçamento do portão";
const TITULO_AUDIO = "Troca de fechadura";
const TITULO_ESPARSO = "Visita técnica";

let pipelineId = "";
let settingsOriginais: Record<string, unknown> = {};
const contatos: string[] = [];

test.use({ viewport: { width: 1280, height: 900 } });
test.describe.configure({ mode: "serial" });

/** "YYYY-MM-DD" daqui a `dias` dias, no calendário LOCAL — o mesmo em que o card conta. */
function dataEmDias(dias: number): string {
  const d = new Date();
  d.setDate(d.getDate() + dias);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

async function login(page: Page, email: string): Promise<void> {
  await page.goto("/login");
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(creds.password);
  await page.getByRole("button", { name: /entrar/i }).click();
  await page.waitForURL(/\/app\//);
}

async function limpar(): Promise<void> {
  const { data } = await admin
    .from("contacts")
    .select("id")
    .eq("organization_id", creds.org_id)
    .like("phone_number", "+55000000%");
  const ids = (data ?? []).map((c) => c.id as string);
  if (ids.length === 0) return;
  await admin.from("crm_leads").delete().in("contact_id", ids);
  await admin.from("messages").delete().in("contact_id", ids);
  await admin.from("conversations").delete().in("contact_id", ids);
  await admin.from("contacts").delete().in("id", ids);
}

test.beforeAll(async () => {
  await limpar();

  const { data: base } = await admin
    .from("conversations")
    .select("channel_session_id")
    .eq("id", creds.queue!.conversation_id)
    .single();
  const sessao = (base as { channel_session_id: string }).channel_session_id;

  // O vocabulário de marcadores da empresa: "vip" é vermelho. A cor do chip no card vem daqui.
  const { data: org } = await admin.from("organizations").select("settings").eq("id", creds.org_id).single();
  settingsOriginais = (org as { settings: Record<string, unknown> | null }).settings ?? {};
  await admin
    .from("organizations")
    .update({ settings: { ...settingsOriginais, canonical_conversation_tags: [{ nome: "vip", cor: "vermelho" }] } })
    .eq("id", creds.org_id);

  const novoContato = async (n: number, nome: string): Promise<string> => {
    const { data, error } = await admin
      .from("contacts")
      .insert({ organization_id: creds.org_id, display_name: nome, phone_number: FONE(n) } as never)
      .select("id")
      .single();
    if (error || !data) throw new Error(`criar contato: ${error?.message}`);
    const id = (data as { id: string }).id;
    contatos.push(id);
    return id;
  };

  const novaConversa = async (
    contactId: string,
    c: { preview: string; direcao: "inbound" | "outbound"; tipo: string; status: string; naoLidas: number },
  ): Promise<void> => {
    const { error } = await admin.from("conversations").insert({
      organization_id: creds.org_id,
      contact_id: contactId,
      channel_session_id: sessao,
      status: "open",
      last_message_at: new Date(Date.now() - 5 * 60_000).toISOString(),
      last_message_preview: c.preview,
      last_message_direction: c.direcao,
      last_message_type: c.tipo,
      last_message_status: c.status,
      unread_count_for_assignee: c.naoLidas,
      last_inbound_at: new Date(Date.now() - 5 * 60_000).toISOString(),
    } as never);
    if (error) throw new Error(`criar conversa: ${error.message}`);
  };

  const maria = await novoContato(71, "Maria Souza");
  await novaConversa(maria, {
    preview: "Qual o valor do portão?",
    direcao: "inbound",
    tipo: "text",
    status: "received",
    naoLidas: 2,
  });
  const joao = await novoContato(72, "João Pereira");
  await novaConversa(joao, {
    preview: "[audio]",
    direcao: "outbound",
    tipo: "audio",
    status: "delivered",
    naoLidas: 0,
  });

  const { data: pipeline, error: pErr } = await admin
    .from("crm_pipelines")
    .insert({
      organization_id: creds.org_id,
      name: `Card útil E2E ${SUFIXO}`,
      slug: `card-util-${SUFIXO}`,
      position: 9_000_000,
    } as never)
    .select("id")
    .single();
  if (pErr || !pipeline) throw new Error(`criar funil: ${pErr?.message}`);
  pipelineId = (pipeline as { id: string }).id;

  const { data: etapa, error: sErr } = await admin
    .from("crm_stages")
    .insert({
      organization_id: creds.org_id,
      pipeline_id: pipelineId,
      name: "Novo",
      slug: "etapa-1",
      position: 1000,
    } as never)
    .select("id")
    .single();
  if (sErr || !etapa) throw new Error(`criar etapa: ${sErr?.message}`);
  const etapaId = (etapa as { id: string }).id;

  const base_ = { organization_id: creds.org_id, pipeline_id: pipelineId, stage_id: etapaId };
  const { error: lErr } = await admin.from("crm_leads").insert([
    {
      ...base_,
      title: TITULO_CHEIO,
      position_in_stage: 1000,
      source: "manual",
      value_cents: 150_000,
      tags: ["vip", "retorno"],
      expected_close_date: dataEmDias(3),
      contact_id: maria,
    },
    {
      ...base_,
      title: TITULO_AUDIO,
      position_in_stage: 2000,
      source: "import",
      tags: [],
      expected_close_date: dataEmDias(-2),
      contact_id: joao,
    },
    // O esparso: sem valor, sem contato, sem tags, sem prazo, sem conversa. (`tags` explícito: num
    // insert em lote a chave ausente vira NULL, e a coluna é NOT NULL.)
    { ...base_, title: TITULO_ESPARSO, position_in_stage: 3000, source: "webhook", tags: [] },
  ] as never);
  if (lErr) throw new Error(`criar leads: ${lErr.message}`);
});

test.afterAll(async () => {
  await limpar();
  await admin.from("organizations").update({ settings: settingsOriginais } as never).eq("id", creds.org_id);
  if (!pipelineId) return;
  const apagou = await (async () => {
    for (const tabela of ["crm_leads", "crm_stages"]) {
      const { error } = await admin.from(tabela).delete().eq("pipeline_id", pipelineId);
      if (error) return false;
    }
    const { error } = await admin.from("crm_pipelines").delete().eq("id", pipelineId);
    return !error;
  })();
  if (!apagou) {
    await admin.from("crm_pipelines").update({ is_archived: true } as never).eq("id", pipelineId);
  }
});

const cardDe = (page: Page, titulo: string) => page.locator("[data-rfd-draggable-id]").filter({ hasText: titulo });

async function abrirOFunil(page: Page, tema: "light" | "dark" = "light"): Promise<void> {
  await page.addInitScript((t) => localStorage.setItem("elevcrm-theme", t), tema);
  await login(page, creds.users.manager!.email);
  await page.goto(`/app/pipelines/${pipelineId}`);
  await expect(page.getByTestId("quadro-do-funil")).toBeVisible();
  await expect(cardDe(page, TITULO_CHEIO)).toBeVisible({ timeout: 30_000 });
}

test("o card cheio mostra telefone, tags coloridas, quem falou, prazo e origem", async ({ page }, testInfo) => {
  await abrirOFunil(page);
  const card = cardDe(page, TITULO_CHEIO);

  await expect(card.getByTestId("valor-do-card")).toHaveText(/R\$\s*1\.500,00/);
  await expect(card.getByTestId("telefone-do-card")).toContainText(phoneForDisplay(FONE(71)));

  // As tags viram chips, e a do vocabulário da empresa leva a COR dele (vip = vermelho).
  const chips = card.getByTestId("tags-do-card");
  const chip = chips.locator(":scope > *");
  await expect(chip).toHaveCount(2);
  await expect(chip.nth(0)).toHaveText("vip");
  await expect(chip.nth(0)).toHaveClass(new RegExp(CLASSE_DE_COR.vermelho.fundo.replace(/[[\]/.]/g, "\\$&")));
  // "retorno" não está no vocabulário: cai no cinza, como a lista do Inbox.
  await expect(chip.nth(1)).toHaveText("retorno");
  await expect(chip.nth(1)).toHaveClass(new RegExp(CLASSE_DE_COR.cinza.fundo.replace(/[[\]/.]/g, "\\$&")));

  // Quem falou por último: o CLIENTE, e a mensagem espera resposta (2 sem ler).
  await expect(card.getByTestId("quem-falou")).toHaveText("Cliente:");
  await expect(card.getByText("Qual o valor do portão?")).toBeVisible();
  await expect(card.getByLabel("2 sem ler")).toBeVisible();

  await expect(card.getByText("Fecha em 3 dias")).toBeVisible();
  await expect(card.getByTestId("origem-e-prazo").locator("[data-origem]")).toHaveAttribute("data-origem", "manual");

  await page.screenshot({ path: testInfo.outputPath("card-cheio-claro.png") });
});

test("nossa mensagem é 'Você:', o áudio é 'Áudio' e o prazo que passou é atrasado", async ({ page }) => {
  await abrirOFunil(page);
  const card = cardDe(page, TITULO_AUDIO);

  await expect(card.getByTestId("quem-falou")).toHaveText("Você:");
  await expect(card.getByText("Áudio", { exact: true })).toBeVisible();
  await expect(card.getByText("[audio]")).toHaveCount(0);

  await expect(card.getByText("Atrasado há 2 dias")).toBeVisible();
  await expect(card.locator("[data-faixa-do-prazo]")).toHaveAttribute("data-faixa-do-prazo", "atrasado");
  await expect(card.getByText("Importado")).toBeVisible();

  // Sem valor cadastrado: "R$ 0,00" apagado, e NUNCA o traço que deixava um buraco.
  await expect(card.getByTestId("valor-do-card")).toHaveText(/R\$\s*0,00/);
  await expect(card.getByTestId("valor-do-card")).toHaveAttribute("data-sem-valor", "true");
  await expect(card.getByText("—", { exact: true })).toHaveCount(0);
});

test("o card esparso não reserva espaço: sem telefone, tags, conversa nem faixa vazia — e é mais baixo que o cheio", async ({ page }, testInfo) => {
  await abrirOFunil(page, "dark");
  const esparso = cardDe(page, TITULO_ESPARSO);
  await expect(esparso).toBeVisible();

  await expect(esparso.getByTestId("telefone-do-card")).toHaveCount(0);
  await expect(esparso.getByTestId("tags-do-card")).toHaveCount(0);
  await expect(esparso.getByTestId("quem-falou")).toHaveCount(0);
  await expect(esparso.locator('a[href^="/app/inbox"]')).toHaveCount(0);
  await expect(esparso.getByTestId("valor-do-card")).toHaveText(/R\$\s*0,00/);
  await expect(esparso.getByText("Formulário ou integração")).toBeVisible();

  const alturaEsparso = (await esparso.boundingBox())!.height;
  const alturaCheio = (await cardDe(page, TITULO_CHEIO).boundingBox())!.height;
  expect(alturaEsparso, "o card esparso tem de ser mais baixo que o cheio").toBeLessThan(alturaCheio - 30);
  // E enxuto: rosto + título + valor + origem + rodapé. Se passar disso, voltou a reservar espaço.
  expect(alturaEsparso).toBeLessThan(150);

  await page.screenshot({ path: testInfo.outputPath("cards-escuro.png") });
});

test.describe("no celular", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("a janela não ganha rolagem lateral e o card cheio cabe na coluna", async ({ page }, testInfo) => {
    await abrirOFunil(page);
    const geo = await page.evaluate(() => ({
      janelaScrollW: document.documentElement.scrollWidth,
      janelaClientW: document.documentElement.clientWidth,
    }));
    expect(geo.janelaScrollW).toBeLessThanOrEqual(geo.janelaClientW);

    // Nada do card vaza para fora dele: o telefone, a última mensagem e o prazo cabem em 320px.
    const card = cardDe(page, TITULO_CHEIO);
    const caixa = (await card.boundingBox())!;
    for (const id of ["telefone-do-card", "tags-do-card", "origem-e-prazo"]) {
      const b = (await card.getByTestId(id).boundingBox())!;
      expect(b.x, id).toBeGreaterThanOrEqual(caixa.x - 1);
      expect(b.x + b.width, id).toBeLessThanOrEqual(caixa.x + caixa.width + 1);
    }

    await page.screenshot({ path: testInfo.outputPath("card-celular.png") });
  });
});
