/**
 * UM LINK LONGO NÃO ESTOURA A TELA DO INBOX — medido no navegador, contra o banco real.
 *
 * ## O defeito que fez este arquivo existir
 *
 * Num grupo de WhatsApp, o atendente mandou o link de um convite — uma URL de ~800 caracteres SEM
 * UM ESPAÇO. A bolha não quebrou o texto; a coluna do meio do inbox cresceu até caber a URL inteira,
 * empurrou o painel do contato (a terceira coluna) para fora da janela e a página ganhou rolagem
 * para o lado. "Sumiram as barras laterais", disse o dono.
 *
 * A causa é a grade de `InboxLayout`: `1fr` é `minmax(auto, 1fr)`, e `auto` no mínimo significa
 * "nunca menos que o conteúdo". Uma palavra comprida tem o conteúdo mais largo que existe. O
 * comentário do próprio layout conta o mesmo defeito com outro culpado (o cabeçalho, 707px): conserta-se
 * o culpado e a grade segue exposta ao próximo.
 *
 * ## O que se mede
 *
 * Em três larguras (grade de 3 colunas, de 2 e celular), com uma URL longa DE SAÍDA e um texto longo
 * DE ENTRADA: a página não rola de lado, o painel do contato continua dentro da janela, e nenhuma
 * bolha passa da borda da coluna da conversa.
 *
 * Também mede a segunda metade da queixa: a mensagem que NÃO saiu (`queued`, com o motivo gravado
 * pelo envio) ficava sem sinal nenhum na bolha — nem tique, nem aviso. Agora diz "Não saiu".
 *
 * Os dados vão direto no banco com a service role, num grupo PRÓPRIO (contato +5500007700NN), e o
 * arquivo RECUSA rodar contra banco que não seja local. Não envia nada.
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

execFileSync(process.execPath, ["--import", "tsx", "scripts/seed-e2e-credentials.ts"], { stdio: "inherit" });
execFileSync(process.execPath, ["--import", "tsx", "scripts/seed-e2e-queue.ts"], { stdio: "inherit" });
const creds = JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as Creds;
if (!creds.queue) throw new Error("bloco `queue` ausente em .e2e-creds.json após o seed");

const supa = credenciaisSupabaseDeTeste();
if (!destinoEhLocal(supa.url)) {
  throw new Error(`mensagem-longa-nao-estoura-a-tela escreve no banco — recusado, o destino não é local (${supa.url}).`);
}
const admin = createClient(supa.url, supa.serviceRole, {
  auth: { autoRefreshToken: false, persistSession: false },
});

test.describe.configure({ mode: "serial" });

/** Uma "palavra" de 700 caracteres, como o corpo de um token de convite. Sintética — não é credencial. */
const CORPO_LONGO = "A1b2C3d4E5".repeat(70);
const URL_LONGA = `https://crm.exemplo.com.br/team/accept-invite/${CORPO_LONGO}`;

const FONE = "+5500007700001";
const GRUPO = "120363000000770001@g.us";

let conversaId = "";
const idDaMensagem = { entrada: "", normal: "", link: "", entradaLonga: "" };

async function limpar(): Promise<void> {
  const { data: contatos } = await admin
    .from("contacts")
    .select("id")
    .eq("organization_id", creds.org_id)
    .eq("phone_number", FONE);
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

  const { data: contato, error: e1 } = await admin
    .from("contacts")
    .insert({ organization_id: creds.org_id, display_name: "Grupo do teste do link", phone_number: FONE })
    .select("id")
    .single();
  if (e1) throw new Error(`criar contato: ${e1.message}`);
  const contatoId = (contato as { id: string }).id;

  const { data: conversa, error: e2 } = await admin
    .from("conversations")
    .insert({
      organization_id: creds.org_id,
      contact_id: contatoId,
      channel_session_id: sessao,
      status: "open",
      is_group: true,
      group_chat_id: GRUPO,
    } as never)
    .select("id")
    .single();
  if (e2) throw new Error(`criar conversa de grupo: ${e2.message}`);
  conversaId = (conversa as { id: string }).id;

  const base_ts = Date.now() - 10 * 60_000;
  const mensagens: Array<{
    chave: keyof typeof idDaMensagem;
    direcao: "inbound" | "outbound";
    status: string;
    body: string;
    metadata?: Record<string, unknown>;
  }> = [
    {
      chave: "entrada",
      direcao: "inbound",
      status: "received",
      body: "Bom dia pessoal, para quando fica?",
      metadata: { grupo_participante_nome: "Gabriel" },
    },
    { chave: "normal", direcao: "outbound", status: "sent", body: "Vou verificar e já te aviso" },
    {
      chave: "link",
      direcao: "outbound",
      status: "queued",
      body: URL_LONGA,
      // O que o envio grava quando o número não está conectado — ver `app/api/v1/messages/_handler.ts`.
      metadata: { queued_reason: "channel_session_not_working" },
    },
    {
      chave: "entradaLonga",
      direcao: "inbound",
      status: "received",
      body: `colei aqui ${CORPO_LONGO}`,
      metadata: { grupo_participante_nome: "Simone" },
    },
  ];
  for (const [i, m] of mensagens.entries()) {
    const id = crypto.randomUUID();
    idDaMensagem[m.chave] = id;
    const { error } = await admin.from("messages").insert({
      id,
      organization_id: creds.org_id,
      conversation_id: conversaId,
      channel_session_id: sessao,
      contact_id: contatoId,
      type: "text",
      direction: m.direcao,
      status: m.status,
      sent_via: m.direcao === "outbound" ? "user" : "external_device",
      body: m.body,
      metadata: m.metadata ?? {},
      sent_at: new Date(base_ts + i * 60_000).toISOString(),
    } as never);
    if (error) throw new Error(`criar mensagem ${m.chave}: ${error.message}`);
  }
});

test.afterAll(async () => {
  await limpar();
});

async function login(page: Page, email: string): Promise<void> {
  await page.goto("/login");
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(creds.password);
  await page.getByRole("button", { name: /entrar/i }).click();
  await page.waitForURL(/\/app\//);
}

const bolha = (page: Page, chave: keyof typeof idDaMensagem) =>
  page.locator(`[data-mensagem-id="${idDaMensagem[chave]}"] .inbox-bolha`);

async function abrirOGrupo(page: Page, largura: number, altura: number): Promise<void> {
  await page.setViewportSize({ width: largura, height: altura });
  await login(page, creds.users.manager!.email);
  // Pelo caminho de quem atende: a aba Grupos e a linha do grupo. O endereço direto
  // (`/app/inbox/<id>`) cai na visão "Fila", que não lista grupo (`is_group: false`).
  await page.goto("/app/inbox");
  await page.getByRole("button", { name: /^Grupos/ }).click();
  await page.locator(`[data-conversation-id="${conversaId}"]`).click();
  await expect(bolha(page, "link")).toBeVisible({ timeout: 30_000 });
}

interface Medidas {
  /** Quanto a página rola para o lado (px). Tem de ser 0. */
  rolagemLateral: number;
  larguraDaJanela: number;
  colunaDaConversa: { esquerda: number; direita: number };
  /** `null` quando a grade não tem terceira coluna nessa largura. */
  painelDoContato: { esquerda: number; direita: number; largura: number } | null;
  bolhas: Record<string, { esquerda: number; direita: number } | null>;
}

async function medir(page: Page): Promise<Medidas> {
  return page.evaluate((ids) => {
    const grade = document.querySelector("[data-tela-cheia]") as HTMLElement;
    const colunas = Array.from(grade.children) as HTMLElement[];
    const retangulo = (el: Element | null | undefined) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { esquerda: Math.round(r.left), direita: Math.round(r.right), largura: Math.round(r.width) };
    };
    // A coluna da conversa é a que contém o fio; a do painel é a seguinte, quando existe e aparece.
    const conversa = colunas.find((c) => c.querySelector("[data-mensagem-id]")) as HTMLElement;
    const painelEl = colunas[colunas.indexOf(conversa) + 1];
    const painelVisivel = painelEl && getComputedStyle(painelEl).display !== "none";
    const bolhas: Record<string, { esquerda: number; direita: number } | null> = {};
    for (const [chave, id] of Object.entries(ids)) {
      bolhas[chave] = retangulo(document.querySelector(`[data-mensagem-id="${id}"] .inbox-bolha`));
    }
    const c = retangulo(conversa)!;
    return {
      rolagemLateral: document.documentElement.scrollWidth - window.innerWidth,
      larguraDaJanela: window.innerWidth,
      colunaDaConversa: { esquerda: c.esquerda, direita: c.direita },
      painelDoContato: painelVisivel ? retangulo(painelEl) : null,
      bolhas,
    };
  }, idDaMensagem) as Promise<Medidas>;
}

function conferirQueCabe(m: Medidas): void {
  // 0. a coluna da conversa cabe na janela. É o sintoma original: ela crescia até caber a URL.
  expect(m.colunaDaConversa.direita, "a coluna da conversa passou da janela").toBeLessThanOrEqual(
    m.larguraDaJanela + 1,
  );
  // 1. a página não rola de lado.
  expect(m.rolagemLateral, "a página rolou para o lado").toBeLessThanOrEqual(0);
  // 2. nenhuma bolha passa da borda da coluna da conversa (1px de folga de arredondamento).
  for (const [nome, b] of Object.entries(m.bolhas)) {
    expect(b, `bolha ${nome} não achada`).not.toBeNull();
    expect(b!.direita, `a bolha ${nome} passou da borda direita da conversa`).toBeLessThanOrEqual(
      m.colunaDaConversa.direita + 1,
    );
    expect(b!.esquerda, `a bolha ${nome} passou da borda esquerda da conversa`).toBeGreaterThanOrEqual(
      m.colunaDaConversa.esquerda - 1,
    );
  }
  // 3. o painel do contato, quando a grade o tem, continua DENTRO da janela e à direita da conversa.
  if (m.painelDoContato) {
    expect(m.painelDoContato.direita, "o painel do contato saiu da janela").toBeLessThanOrEqual(
      m.larguraDaJanela + 1,
    );
    expect(m.painelDoContato.largura, "o painel do contato foi espremido").toBeGreaterThanOrEqual(280);
    expect(m.painelDoContato.esquerda).toBeGreaterThanOrEqual(m.colunaDaConversa.direita - 1);
  }
}

test("três colunas (1440px): o link longo cabe na conversa e o painel do contato fica à vista", async ({ page }) => {
  await abrirOGrupo(page, 1440, 900);
  const m = await medir(page);
  expect(m.painelDoContato, "em 1440px a grade tem o painel do contato").not.toBeNull();
  conferirQueCabe(m);
});

test("duas colunas (1024px): o link longo cabe na conversa e a página não rola de lado", async ({ page }) => {
  await abrirOGrupo(page, 1024, 800);
  conferirQueCabe(await medir(page));
});

test("celular (390px): o link longo cabe e a página não rola de lado", async ({ page }) => {
  await abrirOGrupo(page, 390, 844);
  conferirQueCabe(await medir(page));
});

test("a mensagem que não saiu diz que não saiu — e a que saiu não leva o aviso", async ({ page }) => {
  await abrirOGrupo(page, 1440, 900);

  const selo = bolha(page, "link").getByTestId("selo-de-fila");
  await expect(selo).toBeVisible();
  await expect(selo).toContainText("Não saiu");
  // O motivo gravado pelo envio vira texto para quem passa o mouse.
  await expect(selo).toHaveAttribute("title", /desconectado/i);

  await expect(bolha(page, "normal").getByTestId("selo-de-fila")).toHaveCount(0);
  await expect(bolha(page, "normal").getByRole("img", { name: "Enviada" })).toBeVisible();
});
