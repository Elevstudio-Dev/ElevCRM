/**
 * A conversa do lead, ao lado do quadro do funil.
 *
 * O pedido: "no funil, quando clicar no lead, abrir metade da janela a conversa dele — como se fosse a
 * conversa dele, para enviar mensagem tudo certinho também". Antes, o clique abria uma gaveta estreita só
 * com os dados e um link para o inbox: para responder, saía-se do quadro.
 *
 * O que este arquivo prova, no navegador de verdade (nada disto é alcançável por teste de unidade — eles
 * provam que o componente existe, não que ele ocupa a metade certa da tela):
 *
 *  1. clicar abre a conversa na METADE DIREITA, e o quadro encolhe para a esquerda sem a janela ganhar
 *     rolagem lateral;
 *  2. o card aberto se destaca, e clicar em OUTRO lead troca o painel (lead sem conversa abre nos dados);
 *  3. trocar de aba NÃO apaga o rascunho — a conversa continua montada, só escondida (o CSS, que o teste de
 *     unidade não enxerga, é o que esconde);
 *  4. fechar devolve o quadro inteiro;
 *  5. o quadro continua ARRASTÁVEL com o painel aberto (a metade esquerda encolheu, o gesto não pode);
 *  6. no celular o painel cobre a tela, com o botão de fechar à mão.
 *
 * ⚠️ O que NÃO prova: o envio. Mandar mensagem aqui sairia pelo WhatsApp da instalação de teste, e o teste
 * nunca fala com um número de verdade — digita o rascunho e confere que ele sobrevive, e só.
 *
 * Os dados vão direto no banco com a service role, e o arquivo RECUSA rodar contra banco que não seja local.
 * Tudo o que cria, apaga no fim (as mensagens semeadas moram na conversa compartilhada da fila).
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
  queue?: { conversation_id: string };
}

// Semeia SEMPRE (idempotente): `.e2e-creds.json` sobrevive a um banco recriado e passa a apontar para o
// que não existe mais. O seed da fila monta o trio contato + canal + conversa que este arquivo precisa.
execFileSync(process.execPath, ["--import", "tsx", "scripts/seed-e2e-credentials.ts"], { stdio: "inherit" });
execFileSync(process.execPath, ["--import", "tsx", "scripts/seed-e2e-queue.ts"], { stdio: "inherit" });
const creds = JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as Creds;
if (!creds.queue) throw new Error("bloco `queue` ausente em .e2e-creds.json após o seed");
const CONVERSA = creds.queue.conversation_id;

const supa = credenciaisSupabaseDeTeste();
if (!destinoEhLocal(supa.url)) {
  throw new Error(`funil-conversa-ao-lado escreve no banco — recusado, o destino não é local (${supa.url}).`);
}
const admin = createClient(supa.url, supa.serviceRole, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const SUFIXO = String(Date.now());
const NOME_DO_FUNIL = `Conversa ao lado E2E ${SUFIXO}`;
const LEAD_COM_CONVERSA = `Cliente com conversa ${SUFIXO}`;
const LEAD_SEM_CONVERSA = `Lead sem conversa ${SUFIXO}`;
const PERGUNTA = `Qual o preço da limpeza? ${SUFIXO}`;

let pipelineId = "";
let primeiraEtapaId = "";
let segundaEtapaId = "";
const mensagens: string[] = [];

test.use({ viewport: { width: 1280, height: 800 } });
test.describe.configure({ mode: "serial" });

async function login(page: Page, email: string): Promise<void> {
  await page.goto("/login");
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(creds.password);
  await page.getByRole("button", { name: /entrar/i }).click();
  await page.waitForURL(/\/app\//);
}

test.beforeAll(async () => {
  const { data: conversa, error: cErr } = await admin
    .from("conversations")
    .select("contact_id, channel_session_id")
    .eq("id", CONVERSA)
    .single();
  if (cErr || !conversa) throw new Error(`ler conversa da fila: ${cErr?.message}`);
  const { contact_id, channel_session_id } = conversa as { contact_id: string; channel_session_id: string };

  const { data: pipeline, error: pErr } = await admin
    .from("crm_pipelines")
    .insert({
      organization_id: creds.org_id,
      name: NOME_DO_FUNIL,
      slug: `conversa-ao-lado-${SUFIXO}`,
      position: 9_000_000,
    } as never)
    .select("id")
    .single();
  if (pErr || !pipeline) throw new Error(`criar funil: ${pErr?.message}`);
  pipelineId = (pipeline as { id: string }).id;

  const { data: etapas, error: sErr } = await admin
    .from("crm_stages")
    .insert(
      ["Novo", "Em conversa"].map((name, i) => ({
        organization_id: creds.org_id,
        pipeline_id: pipelineId,
        name,
        slug: `etapa-${i + 1}`,
        position: (i + 1) * 1000,
      })) as never,
    )
    .select("id, position");
  if (sErr || !etapas) throw new Error(`criar etapas: ${sErr?.message}`);
  const ordenadas = (etapas as { id: string; position: number }[]).sort(
    (a, b) => Number(a.position) - Number(b.position),
  );
  primeiraEtapaId = ordenadas[0]!.id;
  segundaEtapaId = ordenadas[1]!.id;

  const lead = (titulo: string, pos: number, contactId: string | null) => ({
    organization_id: creds.org_id,
    pipeline_id: pipelineId,
    stage_id: primeiraEtapaId,
    title: titulo,
    position_in_stage: pos,
    source: "manual",
    ...(contactId ? { contact_id: contactId } : {}),
  });
  const { data: leads, error: lErr } = await admin
    .from("crm_leads")
    .insert([lead(LEAD_COM_CONVERSA, 1000, contact_id), lead(LEAD_SEM_CONVERSA, 2000, null)] as never)
    .select("id, title");
  if (lErr || !leads) throw new Error(`criar leads: ${lErr?.message}`);


  // A mensagem do cliente, para o fio da conversa ter o que mostrar.
  const id = crypto.randomUUID();
  const { error: mErr } = await admin.from("messages").insert({
    id,
    organization_id: creds.org_id,
    conversation_id: CONVERSA,
    channel_session_id,
    contact_id,
    type: "text",
    direction: "inbound",
    status: "received",
    sent_via: "crm",
    body: PERGUNTA,
    sent_at: new Date().toISOString(),
  } as never);
  if (mErr) throw new Error(`criar mensagem: ${mErr.message}`);
  mensagens.push(id);
});

test.afterAll(async () => {
  if (mensagens.length) await admin.from("messages").delete().in("id", mensagens);
  if (!pipelineId) return;
  // Apaga o que criou; se o histórico impedir (chave estrangeira), cai para ARQUIVAR o funil — que
  // sempre funciona — e nunca falha o teste por limpeza.
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

async function abrirOFunil(page: Page): Promise<void> {
  await login(page, creds.users.manager!.email);
  await page.goto(`/app/pipelines/${pipelineId}`);
  await expect(page.getByTestId("quadro-do-funil")).toBeVisible();
  await expect(page.getByRole("heading", { name: LEAD_COM_CONVERSA })).toBeVisible();
}

const painel = (page: Page) => page.getByTestId("painel-do-lead");
const cardDe = (page: Page, titulo: string) => page.locator("[data-rfd-draggable-id]").filter({ hasText: titulo });

async function geometria(page: Page) {
  return page.evaluate(() => {
    const de = document.documentElement;
    const quadro = document.querySelector<HTMLElement>('[data-testid="quadro-do-funil"]')!.getBoundingClientRect();
    const painelEl = document.querySelector<HTMLElement>('[data-testid="painel-do-lead"]');
    const p = painelEl?.getBoundingClientRect() ?? null;
    return {
      janelaScrollW: de.scrollWidth,
      janelaClientW: de.clientWidth,
      quadro: { left: quadro.left, right: quadro.right, width: quadro.width },
      painel: p ? { left: p.left, right: p.right, width: p.width, top: p.top, bottom: p.bottom } : null,
      // A linha que o painel divide com a página: é dela que ele toma a METADE.
      linhaW: painelEl?.parentElement?.getBoundingClientRect().width ?? 0,
      linhaH: painelEl?.parentElement?.getBoundingClientRect().height ?? 0,
      viewW: window.innerWidth,
      viewH: window.innerHeight,
    };
  });
}

test("clicar no lead abre a conversa na METADE DIREITA, e o quadro encolhe para a esquerda", async ({ page }) => {
  await abrirOFunil(page);

  const antes = await geometria(page);
  expect(antes.painel, "sem lead aberto não há painel").toBeNull();

  await cardDe(page, LEAD_COM_CONVERSA).click();
  await expect(painel(page)).toBeVisible();
  // A conversa DESTE lead: a mensagem do cliente no fio e o campo de envio de verdade.
  await expect(painel(page).getByText(PERGUNTA)).toBeVisible({ timeout: 30_000 });
  await expect(painel(page).getByPlaceholder(/escreva uma mensagem/i)).toBeVisible();
  await expect(painel(page).getByRole("tab", { name: "Conversa" })).toHaveAttribute("aria-selected", "true");

  const g = (await geometria(page))!;
  const p = g.painel!;
  // Metade da linha que o painel divide com a página, com folga de 2% — não "mais ou menos".
  expect(p.width / g.linhaW, "o painel ocupa a metade da largura").toBeGreaterThan(0.48);
  expect(p.width / g.linhaW).toBeLessThan(0.52);
  // Em toda a ALTURA da linha (não só embaixo do título): é o que dá espaço para a conversa.
  expect(p.bottom - p.top, "o painel ocupa a altura toda").toBeGreaterThan(g.linhaH - 2);
  // Lado a lado, sem sobrepor: o quadro termina onde o painel começa.
  expect(g.quadro.right).toBeLessThanOrEqual(p.left + 1);
  // E a janela não ganhou rolagem lateral por causa disso.
  expect(g.janelaScrollW).toBeLessThanOrEqual(g.janelaClientW);
  // O painel não passa da tela.
  expect(p.right).toBeLessThanOrEqual(g.viewW + 1);
});

test("o card aberto se destaca, e clicar em OUTRO lead troca o painel", async ({ page }) => {
  await abrirOFunil(page);

  await cardDe(page, LEAD_COM_CONVERSA).click();
  await expect(painel(page).getByRole("heading", { name: LEAD_COM_CONVERSA })).toBeVisible();
  await expect(cardDe(page, LEAD_COM_CONVERSA)).toHaveClass(/border-primary/);
  await expect(cardDe(page, LEAD_SEM_CONVERSA)).not.toHaveClass(/border-primary/);

  await cardDe(page, LEAD_SEM_CONVERSA).click();
  await expect(painel(page).getByRole("heading", { name: LEAD_SEM_CONVERSA })).toBeVisible();
  // Lead sem conversa: abre nos dados, e a aba da conversa não é clicável.
  await expect(painel(page).getByRole("tab", { name: "Dados do lead" })).toHaveAttribute("aria-selected", "true");
  await expect(painel(page).getByRole("tab", { name: "Conversa" })).toBeDisabled();
  // A conversa do lead anterior NÃO ficou para trás.
  await expect(painel(page).getByText(PERGUNTA)).toHaveCount(0);
  await expect(cardDe(page, LEAD_COM_CONVERSA)).not.toHaveClass(/border-primary/);
});

test("trocar de aba NÃO apaga o rascunho (a conversa fica montada, só escondida)", async ({ page }) => {
  await abrirOFunil(page);
  await cardDe(page, LEAD_COM_CONVERSA).click();

  const campo = painel(page).getByPlaceholder(/escreva uma mensagem/i);
  await expect(campo).toBeVisible({ timeout: 30_000 });
  await campo.fill("rascunho que não pode sumir");

  await painel(page).getByRole("tab", { name: "Dados do lead" }).click();
  // Escondida DE VERDADE (a classe `data-[state=inactive]:hidden` que o jsdom não aplica) e os dados à vista.
  await expect(campo).toBeHidden();
  await expect(painel(page).getByRole("heading", { name: "Linha do tempo" })).toBeVisible();

  await painel(page).getByRole("tab", { name: "Conversa" }).click();
  await expect(campo).toBeVisible();
  await expect(campo).toHaveValue("rascunho que não pode sumir");
});

test("fechar devolve o quadro inteiro", async ({ page }) => {
  await abrirOFunil(page);
  const inteiro = (await geometria(page)).quadro.width;

  await cardDe(page, LEAD_COM_CONVERSA).click();
  await expect(painel(page)).toBeVisible();
  expect((await geometria(page)).quadro.width, "o quadro encolheu").toBeLessThan(inteiro * 0.6);

  await painel(page).getByRole("button", { name: "Fechar painel do lead" }).click();
  await expect(painel(page)).toHaveCount(0);
  await expect.poll(async () => (await geometria(page)).quadro.width).toBeGreaterThan(inteiro - 2);
});

test("o quadro continua ARRASTÁVEL com o painel aberto, e o movimento persiste", async ({ page }) => {
  await abrirOFunil(page);
  await cardDe(page, LEAD_COM_CONVERSA).click();
  await expect(painel(page)).toBeVisible();

  const card = cardDe(page, LEAD_SEM_CONVERSA);
  const b = (await card.boundingBox())!;
  // Pega na MARGEM do card (o título é um botão, e a biblioteca não arrasta a partir de botão).
  const x = b.x + 8;
  const y = b.y + b.height / 2;
  const destino = page.getByTestId("coluna-do-funil").nth(1);
  const d = (await destino.boundingBox())!;

  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 15, y + 8, { steps: 5 });
  await page.mouse.move(d.x + d.width / 2, d.y + 120, { steps: 25 });
  await page.mouse.up();

  // O movimento foi gravado (a tela é otimista: conferir no banco, não na tela).
  await expect
    .poll(
      async () => {
        const { data } = await admin.from("crm_leads").select("stage_id").eq("title", LEAD_SEM_CONVERSA).single();
        return (data as { stage_id: string } | null)?.stage_id;
      },
      { timeout: 15_000 },
    )
    .toBe(segundaEtapaId);
  // O painel segue aberto no lead que estava aberto.
  await expect(painel(page).getByRole("heading", { name: LEAD_COM_CONVERSA })).toBeVisible();
});

test.describe("no celular", () => {
  test.use({ viewport: { width: 375, height: 812 } });

  test("o painel cobre a tela, e o botão de fechar está à mão", async ({ page }) => {
    await abrirOFunil(page);
    await cardDe(page, LEAD_COM_CONVERSA).click();
    await expect(painel(page)).toBeVisible();

    const g = await geometria(page);
    const p = g.painel!;
    expect(p.left).toBeLessThanOrEqual(1);
    expect(p.right).toBeGreaterThanOrEqual(g.viewW - 1);
    expect(p.top).toBeLessThanOrEqual(1);
    expect(p.bottom).toBeGreaterThanOrEqual(g.viewH - 1);
    expect(g.janelaScrollW).toBeLessThanOrEqual(g.janelaClientW);

    const fechar = painel(page).getByRole("button", { name: "Fechar painel do lead" });
    await expect(fechar).toBeInViewport();
    await fechar.click();
    await expect(painel(page)).toHaveCount(0);
  });
});
