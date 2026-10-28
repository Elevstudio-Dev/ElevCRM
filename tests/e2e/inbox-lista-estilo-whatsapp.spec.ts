/**
 * A LISTA DE CONVERSAS NO JEITO DO WHATSAPP — no navegador de verdade, contra o banco real.
 *
 * O que um teste de unidade não alcança, e este arquivo mede:
 *
 *  1. a linha mostra o que o BANCO guardou da última mensagem — quem falou, o tipo, o tique —, porque
 *     o espelho nasce em `fn_mark_conversation_message` (migration 0219) e a tela só o desenha. Um
 *     áudio gravado como "[audio]" tem de chegar na tela como "Áudio", e os colchetes não;
 *  2. o TIQUE ACOMPANHA O ACK: quando o status da mensagem muda (enviada → entregue → lida), a
 *     linha da lista passa a mostrar o tique novo. Aqui a tela é RELIDA a cada passo; que ele mude
 *     SOZINHO, sem recarregar, é a prova de `inbox-lista-tique-ao-vivo.spec.ts` — fora do CI, pelo
 *     mesmo motivo de `inbox-tempo-real` (a entrega do Realtime não é determinística no runner;
 *     ver o bloco FORA_DO_CI do e2e.yml). O que este caso segura é o que NÃO depende de Realtime: o
 *     trigger leva o ack à conversa e a rota o devolve;
 *  3. os chips: "Não lidas" filtra de verdade, e o menu ▾ continua oferecendo todas as visões.
 *
 * Os dados vão direto no banco com a service role, em conversas PRÓPRIAS (contatos de telefone
 * +55000000NNNN), e o arquivo RECUSA rodar contra banco que não seja local. Tudo o que cria, apaga no
 * fim. Não envia nada: a conexão de WhatsApp do ambiente de teste está desligada.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { createClient } from "@supabase/supabase-js";
import { test, expect, type Page } from "@playwright/test";

import { credenciaisSupabaseDeTeste, destinoEhLocal } from "../../scripts/lib/env-de-teste";
import { escolherVisaoDoInbox } from "./helpers/visao-do-inbox";

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
  throw new Error(`inbox-lista-estilo-whatsapp escreve no banco — recusado, o destino não é local (${supa.url}).`);
}
const admin = createClient(supa.url, supa.serviceRole, {
  auth: { autoRefreshToken: false, persistSession: false },
});

test.describe.configure({ mode: "serial" });

const FONE = (n: number) => `+55000000${String(n).padStart(4, "0")}`;

interface Linha {
  n: number;
  nome: string;
  previa: string;
  direcao: "inbound" | "outbound";
  tipo: string;
  status: string;
  naoLidas: number;
  /** Minutos atrás — define a ordem da lista (a mais nova em cima). */
  minutos: number;
  tags?: string[];
}

const LINHAS: Linha[] = [
  { n: 1, nome: "Ana Souza", previa: "Pode ser amanhã às 14h?", direcao: "inbound", tipo: "text", status: "received", naoLidas: 3, minutos: 3 },
  { n: 2, nome: "Bruno Lima", previa: "Combinado, obrigado!", direcao: "outbound", tipo: "text", status: "sent", naoLidas: 0, minutos: 25 },
  { n: 3, nome: "Carla Mendes", previa: "[audio]", direcao: "outbound", tipo: "audio", status: "delivered", naoLidas: 0, minutos: 90 },
  { n: 4, nome: "Diego Rocha", previa: "olha o orçamento", direcao: "inbound", tipo: "image", status: "received", naoLidas: 1, minutos: 150, tags: ["vip"] },
  { n: 5, nome: "Igor Teles", previa: "não consegui enviar a proposta", direcao: "outbound", tipo: "text", status: "failed", naoLidas: 0, minutos: 210 },
];

const idDaConversa = new Map<number, string>();
const idDaMensagem = new Map<number, string>();
let settingsOriginais: Record<string, unknown> | null = null;

async function limpar(): Promise<void> {
  const { data: contatos } = await admin
    .from("contacts")
    .select("id")
    .eq("organization_id", creds.org_id)
    .like("phone_number", "+55000000%");
  const ids = (contatos ?? []).map((c) => c.id as string);
  if (ids.length === 0) return;
  await admin.from("messages").delete().in("contact_id", ids);
  await admin.from("conversations").delete().in("contact_id", ids);
  await admin.from("contacts").delete().in("id", ids);
}

test.beforeAll(async () => {
  await limpar(); // um teste que morreu no meio não pode deixar o próximo sem conseguir semear

  const { data: base } = await admin
    .from("conversations")
    .select("channel_session_id")
    .eq("id", creds.queue!.conversation_id)
    .single();
  const sessao = (base as { channel_session_id: string }).channel_session_id;

  // O vocabulário de marcadores da empresa: "vip" é vermelho. A cor da etiqueta na linha vem daqui.
  const { data: org } = await admin.from("organizations").select("settings").eq("id", creds.org_id).single();
  settingsOriginais = (org as { settings: Record<string, unknown> | null }).settings ?? {};
  await admin
    .from("organizations")
    .update({ settings: { ...settingsOriginais, canonical_conversation_tags: [{ nome: "vip", cor: "vermelho" }] } })
    .eq("id", creds.org_id);

  for (const l of LINHAS) {
    const { data: contato, error: e1 } = await admin
      .from("contacts")
      .insert({ organization_id: creds.org_id, display_name: l.nome, phone_number: FONE(l.n), tags: l.tags ?? [] })
      .select("id")
      .single();
    if (e1) throw new Error(`criar contato: ${e1.message}`);
    const contatoId = (contato as { id: string }).id;

    const { data: conversa, error: e2 } = await admin
      .from("conversations")
      .insert({ organization_id: creds.org_id, contact_id: contatoId, channel_session_id: sessao, status: "open" })
      .select("id")
      .single();
    if (e2) throw new Error(`criar conversa: ${e2.message}`);
    const conversaId = (conversa as { id: string }).id;
    idDaConversa.set(l.n, conversaId);

    const quando = new Date(Date.now() - l.minutos * 60_000).toISOString();
    const mensagemId = crypto.randomUUID();
    idDaMensagem.set(l.n, mensagemId);
    const { error: e3 } = await admin.from("messages").insert({
      id: mensagemId,
      organization_id: creds.org_id,
      conversation_id: conversaId,
      channel_session_id: sessao,
      contact_id: contatoId,
      type: l.tipo,
      direction: l.direcao,
      status: l.status,
      sent_via: l.direcao === "outbound" ? "user" : "external_device",
      body: l.tipo === "audio" ? null : l.previa,
      sent_at: quando,
    } as never);
    if (e3) throw new Error(`criar mensagem: ${e3.message}`);

    // O carimbo REAL dos canais de entrada — é ele que preenche o espelho que a tela lê.
    const { error: e4 } = await admin.rpc("fn_mark_conversation_message" as never, {
      p_conv: conversaId,
      p_direction: l.direcao,
      p_preview: l.previa,
      p_at: quando,
    } as never);
    if (e4) throw new Error(`carimbar conversa: ${e4.message}`);

    // O carimbo soma 1 por mensagem do cliente; o número de não lidas do cenário é outro.
    await admin.from("conversations").update({ unread_count_for_assignee: l.naoLidas }).eq("id", conversaId);
  }
});

test.afterAll(async () => {
  await limpar();
  if (settingsOriginais !== null) {
    await admin.from("organizations").update({ settings: settingsOriginais }).eq("id", creds.org_id);
  }
});

async function login(page: Page, email: string): Promise<void> {
  await page.goto("/login");
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(creds.password);
  await page.getByRole("button", { name: /entrar/i }).click();
  await page.waitForURL(/\/app\//);
}

const linha = (page: Page, n: number) => page.locator(`[data-conversation-id="${idDaConversa.get(n)}"]`);

async function irParaTodas(page: Page): Promise<void> {
  await page.goto("/app/inbox");
  await escolherVisaoDoInbox(page, /Todas/);
  await expect(linha(page, 1)).toBeVisible({ timeout: 30_000 });
}

async function abrirATodas(page: Page, tema: "light" | "dark" = "light"): Promise<void> {
  await page.addInitScript((t) => localStorage.setItem("elevcrm-theme", t), tema);
  await login(page, creds.users.manager!.email);
  await irParaTodas(page);
}

test("a linha diz quem falou, o tipo da mensagem e o tique — e o áudio não aparece como '[audio]'", async ({ page }, testInfo) => {
  await abrirATodas(page);

  // Cliente falou por último, 3 não lidas: texto, contador, sem tique e sem "Você:".
  await expect(linha(page, 1)).toContainText("Pode ser amanhã às 14h?");
  await expect(linha(page, 1).getByTestId("nao-lidas")).toHaveText("3");
  await expect(linha(page, 1).getByRole("img", { name: /Enviada|Entregue|Lida/ })).toHaveCount(0);
  await expect(linha(page, 1).getByText("Você:")).toHaveCount(0);

  // Nossa mensagem, enviada: tique de "enviada".
  await expect(linha(page, 2).getByRole("img", { name: "Enviada" })).toBeVisible();

  // Áudio nosso: "Áudio" no lugar do literal do envio, e o tique de entregue.
  await expect(linha(page, 3)).toContainText("Áudio");
  await expect(linha(page, 3)).not.toContainText("[audio]");
  await expect(linha(page, 3).getByRole("img", { name: "Entregue" })).toBeVisible();

  // Foto do cliente com legenda: a legenda aparece. A etiqueta "vip" leva a cor do marcador (vermelho).
  await expect(linha(page, 4)).toContainText("olha o orçamento");
  await expect(linha(page, 4).getByText("vip")).toHaveClass(/bg-red-500\/15/);

  // Falhou: o aviso é um tique de falha, não um ✓.
  await expect(linha(page, 5).getByRole("img", { name: "Falhou ao enviar" })).toBeVisible();

  // (Que conversa comum NÃO gasta uma terceira linha é medido na unidade: neste ambiente há mais de
  // um número conectado, e então toda linha leva o selo do número — uma terceira linha legítima.)

  await page.screenshot({ path: testInfo.outputPath("lista-claro.png") });
});

test("o tique acompanha o ack do WhatsApp: o status da mensagem chega na linha da lista", async ({ page }) => {
  await abrirATodas(page);
  await expect(linha(page, 2).getByRole("img", { name: "Enviada" })).toBeVisible();

  // O WhatsApp confirma a entrega e depois a leitura: só o `status` da MENSAGEM muda. É o trigger da 0219
  // que leva isso à conversa, e a lista que o lê dali. A tela é relida a cada passo (sem Realtime):
  // que o tique mude SOZINHO, sem recarregar, é a prova de `inbox-lista-tique-ao-vivo.spec.ts`, que
  // fica fora do CI pelo mesmo motivo de `inbox-tempo-real` (a entrega do Realtime não é determinística
  // no runner).
  for (const [status, nome] of [
    ["delivered", "Entregue"],
    ["read", "Lida"],
  ] as const) {
    await admin.from("messages").update({ status }).eq("id", idDaMensagem.get(2)!);

    // Primeiro o banco: separa "o trigger não levou o ack à conversa" de "levou, e a tela não mostra".
    await expect
      .poll(
        async () => {
          const { data } = await admin
            .from("conversations")
            .select("last_message_status")
            .eq("id", idDaConversa.get(2)!)
            .single();
          return (data as { last_message_status: string | null }).last_message_status;
        },
        { message: `o trigger da 0219 não espelhou o ack '${status}' na conversa`, timeout: 10_000 },
      )
      .toBe(status);

    await irParaTodas(page);
    await expect(linha(page, 2).getByRole("img", { name: nome })).toBeVisible();
  }

  // ✓✓ azul: a cor é o que separa "lida" de "entregue".
  await expect(linha(page, 2).getByRole("img", { name: "Lida" })).toHaveClass(/text-info/);
});

test("os chips: 'Não lidas' filtra de verdade, e o menu ▾ continua com todas as visões", async ({ page }, testInfo) => {
  await abrirATodas(page, "dark");
  await expect(linha(page, 2)).toBeVisible();

  const naoLidas = page.getByTestId("chip-nao-lidas");
  await expect(naoLidas).toHaveAttribute("aria-pressed", "false");
  await naoLidas.click();
  await expect(naoLidas).toHaveAttribute("aria-pressed", "true");
  // Quem tem não lida continua; quem não tem (a do Bruno) sai.
  await expect(linha(page, 1)).toBeVisible();
  await expect(linha(page, 4)).toBeVisible();
  await expect(linha(page, 2)).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("lista-escuro-nao-lidas.png") });

  await naoLidas.click();
  await expect(linha(page, 2)).toBeVisible();

  // Estamos em "Todas", que não tem chip: o gatilho do menu carrega o nome da visão e fica destacado.
  const menu = page.getByTestId("visao-do-inbox");
  await expect(menu).toContainText("Todas");
  await expect(menu).toHaveAttribute("aria-pressed", "true");
  await menu.click();
  for (const nome of [/Fila/, /Minhas/, /Todas/, /Grupos/, /Arquivadas/, /Automático/]) {
    await expect(page.getByRole("menuitem", { name: nome })).toBeVisible();
  }
  await page.keyboard.press("Escape");
});

test("no celular, os chips quebram de linha em vez de estourar a largura da tela", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await abrirATodas(page);
  await expect(page.getByTestId("chip-unassigned")).toBeVisible();
  await expect(page.getByTestId("chip-nao-lidas")).toBeVisible();

  // Nada à direita da borda: nem a página nem o bloco dos filtros rolam na horizontal.
  const estouro = await page.evaluate(() => {
    const chips = document.querySelector('[data-testid="chip-nao-lidas"]')?.parentElement;
    return {
      pagina: document.documentElement.scrollWidth - window.innerWidth,
      chips: chips ? chips.scrollWidth - chips.clientWidth : -1,
    };
  });
  expect(estouro.pagina, "a página ganhou rolagem horizontal").toBeLessThanOrEqual(0);
  expect(estouro.chips, "a fileira de chips rola na horizontal — o que a decisão de 2026-09-04 proíbe").toBeLessThanOrEqual(0);

  await page.screenshot({ path: testInfo.outputPath("lista-celular.png") });
});
