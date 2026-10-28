/**
 * O TIQUE MUDA SOZINHO NA LISTA — sem F5. FORA DO CI, de propósito (ver FORA_DO_CI no e2e.yml).
 *
 * ─── O que este arquivo prova ───────────────────────────────────────────────
 *
 * A razão de o espelho do status morar em `conversations` (migration 0219) é o Realtime da lista, que
 * escuta essa tabela e não `messages`. Quando o WhatsApp confirma a entrega e depois a leitura, só o
 * `status` da MENSAGEM muda; o trigger leva isso à conversa, e o Realtime leva a conversa à tela. Se
 * qualquer elo caísse, o ✓✓ azul só apareceria depois de recarregar — sem erro nenhum.
 *
 * ⚠️ NÃO RECARREGA A PÁGINA depois de abrir o inbox, e isso é o teste. Quem acrescentar um `reload()`
 * "para estabilizar" passa a medir o F5 — o sintoma que este arquivo existe para proibir.
 *
 * ─── Por que está fora do CI ────────────────────────────────────────────────
 *
 * Passou local (22 s) e FALHOU no runner do PR #14: o canal em tempo real não entregou em 45 s, sem
 * nenhuma linha de erro. É o mesmo comportamento que tirou `inbox-tempo-real` da lista de execução — o
 * canal responde SUBSCRIBED e a entrega, no runner, é não determinística. O caso que NÃO depende de
 * Realtime (o trigger leva o ack à conversa e a rota o devolve) ficou no CI, em
 * `inbox-lista-estilo-whatsapp.spec.ts`. Volta para a lista de execução junto com `inbox-tempo-real`,
 * quando a entrega for determinística.
 *
 * Roda local: `pnpm exec playwright test tests/e2e/inbox-lista-tique-ao-vivo.spec.ts`.
 *
 * Os dados vão direto no banco com a service role, em contato e conversa PRÓPRIOS (telefone
 * +55000001NNNN), e o arquivo RECUSA rodar contra banco que não seja local. Tudo o que cria, apaga no fim.
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
  throw new Error(`inbox-lista-tique-ao-vivo escreve no banco — recusado, o destino não é local (${supa.url}).`);
}
const admin = createClient(supa.url, supa.serviceRole, {
  auth: { autoRefreshToken: false, persistSession: false },
});

test.setTimeout(180_000);

const FONE_UM = "+550000010001";
const FONE_DOIS = "+550000010002";
let conversaDoAck = "";
let conversaDoPing = "";
let mensagemDoAck = "";

async function limpar(): Promise<void> {
  const { data } = await admin
    .from("contacts")
    .select("id")
    .eq("organization_id", creds.org_id)
    .like("phone_number", "+55000001%");
  const ids = (data ?? []).map((c) => c.id as string);
  if (ids.length === 0) return;
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

  const semear = async (fone: string, nome: string, direcao: "inbound" | "outbound", status: string) => {
    const { data: contato, error: e1 } = await admin
      .from("contacts")
      .insert({ organization_id: creds.org_id, display_name: nome, phone_number: fone } as never)
      .select("id")
      .single();
    if (e1 || !contato) throw new Error(`criar contato: ${e1?.message}`);
    const contatoId = (contato as { id: string }).id;
    const { data: conversa, error: e2 } = await admin
      .from("conversations")
      .insert({ organization_id: creds.org_id, contact_id: contatoId, channel_session_id: sessao, status: "open" } as never)
      .select("id")
      .single();
    if (e2 || !conversa) throw new Error(`criar conversa: ${e2?.message}`);
    const conversaId = (conversa as { id: string }).id;
    const mensagemId = crypto.randomUUID();
    const quando = new Date().toISOString();
    const { error: e3 } = await admin.from("messages").insert({
      id: mensagemId,
      organization_id: creds.org_id,
      conversation_id: conversaId,
      channel_session_id: sessao,
      contact_id: contatoId,
      type: "text",
      direction: direcao,
      status,
      sent_via: direcao === "outbound" ? "user" : "external_device",
      body: "mensagem de teste do tique",
      sent_at: quando,
    } as never);
    if (e3) throw new Error(`criar mensagem: ${e3.message}`);
    // O carimbo REAL dos canais de entrada: é ele que preenche o espelho que a tela lê.
    const { error: e4 } = await admin.rpc("fn_mark_conversation_message" as never, {
      p_conv: conversaId,
      p_direction: direcao,
      p_preview: "mensagem de teste do tique",
      p_at: quando,
    } as never);
    if (e4) throw new Error(`carimbar conversa: ${e4.message}`);
    return { conversaId, mensagemId };
  };

  const ack = await semear(FONE_UM, "Ana do Ack", "outbound", "sent");
  conversaDoAck = ack.conversaId;
  mensagemDoAck = ack.mensagemId;
  const ping = await semear(FONE_DOIS, "Beto do Ping", "inbound", "received");
  conversaDoPing = ping.conversaId;
  await admin.from("conversations").update({ unread_count_for_assignee: 3 }).eq("id", conversaDoPing);
});

test.afterAll(limpar);

async function login(page: Page, email: string): Promise<void> {
  await page.goto("/login");
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(creds.password);
  await page.getByRole("button", { name: /entrar/i }).click();
  await page.waitForURL(/\/app\//);
}

const linha = (page: Page, id: string) => page.locator(`[data-conversation-id="${id}"]`);

test("o tique muda sozinho quando o ack chega — sem recarregar a tela", async ({ page }) => {
  await login(page, creds.users.manager!.email);
  await page.goto("/app/inbox");
  await escolherVisaoDoInbox(page, /Todas/);
  await expect(linha(page, conversaDoAck).getByRole("img", { name: "Enviada" })).toBeVisible({ timeout: 30_000 });

  // O canal em tempo real leva alguns segundos para assinar depois que a tela abre; um ack disparado
  // antes disso não tem para quem ser entregue (e o refetch de segurança só roda de 45 em 45 s). Então
  // primeiro se confirma que o canal está VIVO, com uma mudança qualquer que a outra linha mostra.
  let contagem = 3;
  await expect
    .poll(
      async () => {
        contagem += 1;
        await admin.from("conversations").update({ unread_count_for_assignee: contagem }).eq("id", conversaDoPing);
        await page.waitForTimeout(1500);
        return (await linha(page, conversaDoPing).getByTestId("nao-lidas").textContent()) === String(contagem);
      },
      { message: "o canal em tempo real da lista nunca ficou vivo", timeout: 90_000 },
    )
    .toBe(true);

  await admin.from("messages").update({ status: "delivered" }).eq("id", mensagemDoAck);
  await expect(linha(page, conversaDoAck).getByRole("img", { name: "Entregue" })).toBeVisible({ timeout: 30_000 });

  await admin.from("messages").update({ status: "read" }).eq("id", mensagemDoAck);
  const lida = linha(page, conversaDoAck).getByRole("img", { name: "Lida" });
  await expect(lida).toBeVisible({ timeout: 30_000 });
  // ✓✓ azul: a cor é o que separa "lida" de "entregue".
  await expect(lida).toHaveClass(/text-info/);
});
