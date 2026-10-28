/**
 * RESPONDER "COMO NO WHATSAPP" — o que ficou faltando no responder que já existia.
 *
 * O botão de responder, a faixa e a citação na bolha já existiam (`inbox-responder-citando.spec.ts`).
 * Este arquivo guarda os três acabamentos que o dono pediu, no navegador de verdade — nenhum é
 * alcançável por teste de unidade, que prova que a função existe, não que dá para fazê-la com o dedo:
 *
 *  1. a citação de um ÁUDIO ou de uma FOTO diz o que a mensagem é ("Áudio", "Foto"), em vez de
 *     "(sem texto)", como se ela estivesse vazia — na bolha e na faixa acima do campo;
 *  2. tocar na citação ROLA o fio até a mensagem original e a destaca;
 *  3. DESLIZAR a mensagem para a direita (toque) abre a resposta, como no WhatsApp do celular.
 *
 * Os dados vão direto no banco com a service role — dentro da conversa da fila, a mesma de outras
 * specs —, e o arquivo RECUSA rodar contra banco que não seja local. Tudo o que cria, apaga no fim.
 * Não envia nada: responder aqui só abre a faixa; nenhuma mensagem sai.
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
  throw new Error(`inbox-responder-melhor escreve no banco — recusado, o destino não é local (${supa.url}).`);
}
const admin = createClient(supa.url, supa.serviceRole, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const SUFIXO = String(Date.now());
const TEXTO_DE_CIMA = `Mensagem lá de cima ${SUFIXO}`;
const RESPOSTA_AO_AUDIO = `Pode ser quinta? ${SUFIXO}`;
const RESPOSTA_A_DE_CIMA = `Sobre aquilo que você disse ${SUFIXO}`;
const RESPOSTA_A_FOTO = `Recebi a foto ${SUFIXO}`;
const FILLERS = 26; // empurram a de cima para fora da tela

const ids: string[] = [];
let idAudio = "";
let idDeCima = "";

test.describe.configure({ mode: "serial" });

async function login(page: Page, email: string): Promise<void> {
  await page.goto("/login");
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(creds.password);
  await page.getByRole("button", { name: /entrar/i }).click();
  await page.waitForURL(/\/app\//);
}

test.beforeAll(async () => {
  const { data } = await admin
    .from("conversations")
    .select("contact_id, channel_session_id")
    .eq("id", CONVERSA)
    .single();
  const { contact_id, channel_session_id } = data as { contact_id: string; channel_session_id: string };

  // Todas as mensagens nascem AGORA (em ordem, com 1 s entre elas): vêm depois de tudo o que a conversa
  // compartilhada já tinha, então ficam no fim do fio.
  let t = Date.now() - 120_000;
  const nova = async (over: Record<string, unknown>): Promise<string> => {
    const id = crypto.randomUUID();
    t += 1000;
    const { error } = await admin.from("messages").insert({
      id,
      organization_id: creds.org_id,
      conversation_id: CONVERSA,
      channel_session_id,
      contact_id,
      type: "text",
      direction: "inbound",
      status: "received",
      sent_via: "crm",
      body: null,
      sent_at: new Date(t).toISOString(),
      ...over,
    } as never);
    if (error) throw new Error(`criar mensagem: ${error.message}`);
    ids.push(id);
    return id;
  };

  idDeCima = await nova({ body: TEXTO_DE_CIMA });
  for (let i = 0; i < FILLERS; i++) {
    await nova({
      body: `enchimento ${i + 1} — ${SUFIXO}`,
      ...(i % 2 ? { direction: "outbound", status: "sent", sent_via: "user" } : {}),
    });
  }
  // Um ÁUDIO e uma FOTO do cliente, sem texto nenhum — o caso do defeito. Sem arquivo no armazenamento
  // de propósito: o player cai em "Mídia indisponível", e o que importa aqui é a CITAÇÃO.
  idAudio = await nova({ type: "audio", media_mime: "audio/ogg", media_storage_path: `${creds.org_id}/${CONVERSA}/${SUFIXO}-a.ogg` });
  const idFoto = await nova({ type: "image", media_mime: "image/jpeg", media_storage_path: `${creds.org_id}/${CONVERSA}/${SUFIXO}-f.jpg` });

  const resposta = (body: string, citando: string) =>
    nova({ direction: "outbound", status: "sent", sent_via: "user", body, reply_to_message_id: citando });
  await resposta(RESPOSTA_AO_AUDIO, idAudio);
  await resposta(RESPOSTA_A_FOTO, idFoto);
  await resposta(RESPOSTA_A_DE_CIMA, idDeCima);
});

test.afterAll(async () => {
  // As respostas citam as outras: apagar na ordem inversa da criação respeita a chave estrangeira.
  for (const id of [...ids].reverse()) await admin.from("messages").delete().eq("id", id);
});

async function abrirAConversa(page: Page): Promise<void> {
  await login(page, creds.users.manager!.email);
  await page.goto(`/app/inbox/${CONVERSA}`);
  await expect(page.getByText(RESPOSTA_A_DE_CIMA)).toBeVisible({ timeout: 30_000 });
}

/** A linha (bolha) de uma mensagem, achada pelo texto dela. */
const linhaDe = (page: Page, texto: string) =>
  page.locator("[data-mensagem-id]").filter({ hasText: texto });

test("a citação de áudio e de foto diz o que a mensagem é — não '(sem texto)'", async ({ page }) => {
  await abrirAConversa(page);

  const aoAudio = linhaDe(page, RESPOSTA_AO_AUDIO);
  await expect(aoAudio.getByRole("button", { name: /ir para a mensagem citada/i })).toContainText("Áudio");
  await expect(aoAudio.getByText("(sem texto)")).toHaveCount(0);

  const aFoto = linhaDe(page, RESPOSTA_A_FOTO);
  await expect(aFoto.getByRole("button", { name: /ir para a mensagem citada/i })).toContainText("Foto");

  // E a faixa acima do campo — o mesmo resumo: responder ao áudio mostra "Áudio", não "(sem texto)".
  const audio = page.locator(`[data-mensagem-id="${idAudio}"]`);
  await audio.hover();
  await audio.getByRole("button", { name: /responder a esta mensagem/i }).click();
  const faixa = page.getByRole("button", { name: /cancelar resposta/i }).locator("xpath=ancestor::div[1]");
  await expect(faixa).toContainText("Áudio");
  await expect(faixa).not.toContainText("(sem texto)");
});

test("tocar na citação rola o fio até a mensagem original e a destaca", async ({ page }) => {
  await abrirAConversa(page);

  // Pelo ID, e não pelo texto: a RESPOSTA também exibe esse texto, dentro da citação.
  const deCima = page.locator(`[data-mensagem-id="${idDeCima}"]`);
  // A original está FORA da tela (26 mensagens de enchimento entre ela e a resposta).
  await expect(deCima).not.toBeInViewport();

  await linhaDe(page, RESPOSTA_A_DE_CIMA)
    .getByRole("button", { name: /ir para a mensagem citada/i })
    .click();

  await expect(deCima).toBeInViewport({ timeout: 10_000 });
  // Destacada por um instante…
  await expect(deCima).toHaveClass(/bg-primary\/15/);
  // …e depois volta ao normal (não fica tingida para sempre).
  await expect(deCima).not.toHaveClass(/bg-primary\/15/, { timeout: 8_000 });
});

test.describe("com toque (celular)", () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 800 } });

  /** Onde o dedo encosta, a partir da borda esquerda da linha: área vazia, longe do botão de responder da bolha. */
  const PONTO_LIVRE = 80;

  /** Um deslize de verdade: eventos de toque do navegador, não eventos sintéticos do teste. */
  async function deslizar(page: Page, de: { x: number; y: number }, ate: { x: number; y: number }) {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [de] });
    const passos = 8;
    for (let i = 1; i <= passos; i++) {
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ x: de.x + ((ate.x - de.x) * i) / passos, y: de.y + ((ate.y - de.y) * i) / passos }],
      });
    }
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  }

  /**
   * A caixa da linha, DEPOIS que a conversa parou de rolar.
   *
   * Ao abrir, o fio rola sozinho até o fim (suave). Medir no meio disso põe o dedo onde a linha ESTAVA —
   * o gesto começa noutra mensagem, ou num controle (que não inicia gesto), e o teste falha por pressa, não
   * por defeito. Espera a posição ficar igual em duas leituras seguidas.
   */
  async function caixaParada(page: Page, alvo: ReturnType<typeof linhaDe>) {
    await alvo.scrollIntoViewIfNeeded();
    let anterior = "";
    await expect
      .poll(
        async () => {
          const atual = JSON.stringify(await alvo.boundingBox());
          const parou = atual === anterior;
          anterior = atual;
          return parou;
        },
        { intervals: [150], timeout: 15_000 },
      )
      .toBe(true);
    return (await alvo.boundingBox())!;
  }

  async function abrirNoCelular(page: Page): Promise<void> {
    await login(page, creds.users.manager!.email);
    await page.goto(`/app/inbox/${CONVERSA}`);
    await expect(page.getByText(RESPOSTA_A_DE_CIMA)).toBeVisible({ timeout: 30_000 });
  }

  test("deslizar a mensagem para a direita abre a resposta", async ({ page }) => {
    await abrirNoCelular(page);

    const alvo = linhaDe(page, RESPOSTA_A_DE_CIMA);
    const b = await caixaParada(page, alvo);
    const y = b.y + b.height / 2;
    await expect(page.getByRole("button", { name: /cancelar resposta/i })).toHaveCount(0);

    // Começa na área vazia da linha (à esquerda da bolha de saída, que é encostada à direita). A 80px da borda:
    // mais perto cai sobre o indicador "N" do servidor de desenvolvimento do Next (canto inferior esquerdo), que
    // engole o toque — no build de produção ele não existe, e o teste não deve depender de onde ele está.
    await deslizar(page, { x: b.x + PONTO_LIVRE, y }, { x: b.x + PONTO_LIVRE + 90, y: y + 2 });

    const cancelar = page.getByRole("button", { name: /cancelar resposta/i });
    await expect(cancelar).toBeVisible();
    // E a faixa cita a mensagem DESLIZADA, não outra.
    await expect(cancelar.locator("xpath=ancestor::div[1]")).toContainText(RESPOSTA_A_DE_CIMA);
  });

  test("rolar a conversa NÃO abre a resposta", async ({ page }) => {
    await abrirNoCelular(page);
    const alvo = linhaDe(page, RESPOSTA_A_DE_CIMA);
    const b = await caixaParada(page, alvo);
    const y = b.y + b.height / 2;

    // Vertical, com um pouco de deriva para o lado: é uma rolagem.
    await deslizar(page, { x: b.x + PONTO_LIVRE, y }, { x: b.x + PONTO_LIVRE + 14, y: y - 120 });

    await expect(page.getByRole("button", { name: /cancelar resposta/i })).toHaveCount(0);
  });
});
