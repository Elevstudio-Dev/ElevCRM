/**
 * O KANBAN NOVO DO FUNIL, NO NAVEGADOR DE VERDADE — o rosto do cliente e o arrastar que continua.
 *
 * O pedido do dono: aplicar o desenho do kanban de referência no funil e acrescentar a foto de perfil do
 * cliente. O arrastar NÃO foi trocado (decisão dele: só o visual), então o que está em jogo é provar que o
 * desenho novo não quebrou o que já funcionava, e que o rosto aparece onde deve e some onde não pode:
 *
 *  1. cliente COM foto: a imagem carrega de verdade (a rota assina a URL do armazenamento privado);
 *  2. cliente sem foto: as iniciais dele; lead sem contato: as iniciais do título — o círculo nunca falta;
 *  3. cliente ANONIMIZADO: a foto NÃO chega — nem no JSON do quadro (o servidor não entrega) nem como
 *     pedido de imagem do navegador (LGPD: apagar o nome e manter a foto não anonimiza ninguém);
 *  4. o quadro continua ARRASTÁVEL (teclado) e a posição é gravada no banco;
 *  5. cada coluna segue rolando sozinha e a janela não ganha rolagem lateral no celular.
 *
 * Os dados vão direto no banco com a service role (funil, contatos e a imagem no armazenamento), e o
 * arquivo RECUSA rodar contra banco que não seja local. Tudo o que cria, apaga no fim.
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
}

execFileSync(process.execPath, ["--import", "tsx", "scripts/seed-e2e-credentials.ts"], { stdio: "inherit" });
const creds = JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as Creds;

const supa = credenciaisSupabaseDeTeste();
if (!destinoEhLocal(supa.url)) {
  throw new Error(`funil-kanban-visual escreve no banco — recusado, o destino não é local (${supa.url}).`);
}
const admin = createClient(supa.url, supa.serviceRole, {
  auth: { autoRefreshToken: false, persistSession: false },
});

// Um PNG de 1×1 válido: o suficiente para o navegador CARREGAR a imagem (naturalWidth > 0).
const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

const SUFIXO = String(Date.now());
const NOME_DO_FUNIL = `Kanban visual E2E ${SUFIXO}`;
const FONE = (n: number) => `+55000000${String(n).padStart(4, "0")}`;

const TITULO_FOTO = "Orçamento do portão";
const TITULO_INICIAIS = "Troca de fechadura";
const TITULO_SEM_CONTATO = "Visita técnica";
const TITULO_ANONIMO = "Manutenção do interfone";

let pipelineId = "";
let segundaEtapaId = "";
let contatoComFotoId = "";
let contatoAnonimoId = "";
let caminhoDaFoto = "";
let caminhoDaFotoAnonima = "";
const contatos: string[] = [];

test.use({ viewport: { width: 1280, height: 800 } });
test.describe.configure({ mode: "serial" });

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
  if (ids.length) {
    await admin.from("crm_leads").delete().in("contact_id", ids);
    await admin.from("contacts").delete().in("id", ids);
  }
}

test.beforeAll(async () => {
  await limpar();

  const novoContato = async (n: number, nome: string, extra: Record<string, unknown> = {}): Promise<string> => {
    const { data, error } = await admin
      .from("contacts")
      .insert({ organization_id: creds.org_id, display_name: nome, phone_number: FONE(n), ...extra } as never)
      .select("id")
      .single();
    if (error || !data) throw new Error(`criar contato: ${error?.message}`);
    const id = (data as { id: string }).id;
    contatos.push(id);
    return id;
  };

  // O contato COM foto: a imagem de verdade, no armazenamento privado onde a rota a procura.
  contatoComFotoId = await novoContato(1, "Maria Souza");
  caminhoDaFoto = `${creds.org_id}/avatars/${contatoComFotoId}-e2e.png`;
  const { error: upErr } = await admin.storage
    .from("whatsapp-media")
    .upload(caminhoDaFoto, PNG_1X1, { contentType: "image/png", upsert: true });
  if (upErr) throw new Error(`enviar a foto: ${upErr.message}`);
  await admin.from("contacts").update({ avatar_storage_path: caminhoDaFoto } as never).eq("id", contatoComFotoId);

  const contatoIniciaisId = await novoContato(2, "João Pereira");

  // O ANONIMIZADO: tem arquivo de foto E caminho gravado — de propósito. Se o servidor o entregasse, o
  // teste veria. O que impede é a rota do quadro e, por baixo, a do avatar.
  // (O banco exige `anonymized_at` junto de `is_anonymized`, e trava o contato depois — por isso o
  // arquivo é enviado ANTES e o caminho entra no próprio INSERT, com um nome que não depende do id.)
  caminhoDaFotoAnonima = `${creds.org_id}/avatars/anonimo-${SUFIXO}-e2e.png`;
  const { error: upAnonErr } = await admin.storage
    .from("whatsapp-media")
    .upload(caminhoDaFotoAnonima, PNG_1X1, { contentType: "image/png", upsert: true });
  if (upAnonErr) throw new Error(`enviar a foto do anonimizado: ${upAnonErr.message}`);
  contatoAnonimoId = await novoContato(3, "Nome Que Foi Apagado", {
    is_anonymized: true,
    anonymized_at: new Date().toISOString(),
    avatar_storage_path: caminhoDaFotoAnonima,
  });

  const { data: pipeline, error: pErr } = await admin
    .from("crm_pipelines")
    .insert({
      organization_id: creds.org_id,
      name: NOME_DO_FUNIL,
      slug: `kanban-visual-${SUFIXO}`,
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
  const primeiraEtapaId = ordenadas[0]!.id;
  segundaEtapaId = ordenadas[1]!.id;

  const lead = (titulo: string, pos: number, contactId: string | null, valor: number | null) => ({
    organization_id: creds.org_id,
    pipeline_id: pipelineId,
    stage_id: primeiraEtapaId,
    title: titulo,
    position_in_stage: pos,
    source: "manual",
    ...(valor ? { value_cents: valor } : {}),
    ...(contactId ? { contact_id: contactId } : {}),
  });
  const { error: lErr } = await admin.from("crm_leads").insert([
    lead(TITULO_FOTO, 1000, contatoComFotoId, 150_000),
    lead(TITULO_INICIAIS, 2000, contatoIniciaisId, 42_000),
    lead(TITULO_SEM_CONTATO, 3000, null, null),
    lead(TITULO_ANONIMO, 4000, contatoAnonimoId, 9_900),
  ] as never);
  if (lErr) throw new Error(`criar leads: ${lErr.message}`);
});

test.afterAll(async () => {
  await limpar();
  await admin.storage.from("whatsapp-media").remove([caminhoDaFoto, caminhoDaFotoAnonima].filter(Boolean));
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
  await expect(cardDe(page, TITULO_FOTO)).toBeVisible({ timeout: 30_000 });
}

test("cada card mostra o rosto do CLIENTE — a foto carrega, e quem não tem foto tem iniciais", async ({ page }, testInfo) => {
  await abrirOFunil(page);

  // 1. Com foto: a <img> existe, aponta para a rota de avatar do contato e CARREGOU de verdade.
  const foto = cardDe(page, TITULO_FOTO).locator("img");
  await expect(foto).toHaveAttribute("src", `/api/v1/contacts/${contatoComFotoId}/avatar`);
  await expect
    .poll(async () => foto.evaluate((el) => (el as HTMLImageElement).complete && (el as HTMLImageElement).naturalWidth), {
      message: "a foto do cliente não carregou",
      timeout: 20_000,
    })
    .toBeGreaterThan(0);

  // 2. Sem foto: as iniciais do CLIENTE ("João Pereira" → JP), não as do título do negócio.
  const semFoto = cardDe(page, TITULO_INICIAIS);
  await expect(semFoto.getByText("JP", { exact: true })).toBeVisible();
  await expect(semFoto.locator("img")).toHaveCount(0);

  // 3. Lead SEM contato: as iniciais do título ("Visita técnica" → VT) — o círculo nunca falta.
  await expect(cardDe(page, TITULO_SEM_CONTATO).getByText("VT", { exact: true })).toBeVisible();

  await page.screenshot({ path: testInfo.outputPath("funil-claro.png") });
});

test("cliente ANONIMIZADO não tem foto: o servidor não a entrega e o navegador nem a pede", async ({ page }) => {
  const pedidosDeAvatar: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes(`/api/v1/contacts/${contatoAnonimoId}/avatar`)) pedidosDeAvatar.push(r.url());
  });
  const quadro = page.waitForResponse(
    (r) => r.url().includes(`/api/v1/pipelines/${pipelineId}/board`) && r.status() === 200,
  );
  await abrirOFunil(page);
  const corpo = (await (await quadro).json()) as {
    data: { leads: Array<{ title: string; contato?: Record<string, unknown> | null }> };
  };

  const anonimo = corpo.data.leads.find((l) => l.title === TITULO_ANONIMO)!;
  expect(anonimo.contato, "o quadro devolveu o contato anonimizado").toMatchObject({
    is_anonymized: true,
    avatar_storage_path: null,
    display_name: null,
    phone_number: null,
  });
  // O caminho do arquivo dele não aparece em lugar nenhum da resposta.
  expect(JSON.stringify(corpo)).not.toContain(caminhoDaFotoAnonima);

  await expect(cardDe(page, TITULO_ANONIMO)).toBeVisible();
  await expect(cardDe(page, TITULO_ANONIMO).locator("img")).toHaveCount(0);
  expect(pedidosDeAvatar, "o navegador pediu a foto de um contato anonimizado").toEqual([]);

  // E a rota de avatar, por baixo, também recusa (a segunda cerca).
  const r = await page.request.get(`/api/v1/contacts/${contatoAnonimoId}/avatar`, { maxRedirects: 0 });
  expect(r.status()).toBe(404);
});

test("o quadro continua arrastável (teclado) e o movimento é gravado", async ({ page }, testInfo) => {
  await abrirOFunil(page, "dark");
  const card = cardDe(page, TITULO_INICIAIS);
  await card.focus();
  await page.keyboard.press("Space");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Space");

  await expect
    .poll(
      async () => {
        const { data } = await admin
          .from("crm_leads")
          .select("stage_id")
          .eq("pipeline_id", pipelineId)
          .eq("title", TITULO_INICIAIS)
          .single();
        return (data as { stage_id: string } | null)?.stage_id;
      },
      { timeout: 15_000 },
    )
    .toBe(segundaEtapaId);

  // Ele aparece na coluna de destino, e o rosto foi junto.
  const destino = page.getByTestId("coluna-do-funil").nth(1);
  await expect(destino.getByRole("heading", { name: TITULO_INICIAIS })).toBeVisible();
  await expect(destino.getByText("JP", { exact: true })).toBeVisible();

  await page.screenshot({ path: testInfo.outputPath("funil-escuro.png") });
});

test.describe("no celular", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("a janela não ganha rolagem lateral e o rosto cabe no card", async ({ page }, testInfo) => {
    await abrirOFunil(page);
    const geo = await page.evaluate(() => ({
      janelaScrollW: document.documentElement.scrollWidth,
      janelaClientW: document.documentElement.clientWidth,
    }));
    expect(geo.janelaScrollW).toBeLessThanOrEqual(geo.janelaClientW);

    const card = cardDe(page, TITULO_FOTO);
    const rostoBox = (await card.locator("img").boundingBox())!;
    const cardBox = (await card.boundingBox())!;
    expect(rostoBox.x).toBeGreaterThanOrEqual(cardBox.x);
    expect(rostoBox.x + rostoBox.width).toBeLessThanOrEqual(cardBox.x + cardBox.width);

    await page.screenshot({ path: testInfo.outputPath("funil-celular.png") });
  });
});
