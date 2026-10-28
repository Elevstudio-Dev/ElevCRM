/**
 * ENCAMINHAR MENSAGENS PARA OUTRAS CONVERSAS — pela tela, como a atendente faz.
 *
 * O pedido: encaminhar "como no WhatsApp normal". Num CRM de clínica isso é o que UMA pessoa disse
 * chegando à conversa de OUTRA, então este arquivo prova, no navegador de verdade e contra o banco:
 *
 *  1. o caminho inteiro: botão → modo de seleção → escolher o destino → a CONFERÊNCIA ("as mensagens
 *     são de X e vão chegar ao WhatsApp de Y") → enviar → a mensagem existe na conversa de destino,
 *     marcada como encaminhada;
 *  2. o ÁUDIO vai como arquivo COPIADO para a conversa de destino (o caminho original não é reaproveitado);
 *  3. uma mensagem apagada não pode ser marcada (a caixa fica desabilitada);
 *  4. desistir (Esc) devolve o campo de envio COM o rascunho que estava digitado;
 *  5. a trilha: uma linha de auditoria por encaminhamento, sem o conteúdo.
 *
 * ⚠️ Não envia nada de verdade: o servidor de teste tem o WhatsApp desligado, então o que se prova é o
 * que o CRM grava e tenta enviar — a mensagem pode ficar `failed` na linha, e o teste não depende de
 * ela ter saído. Os dados vão direto no banco com a service role, e o arquivo RECUSA rodar contra banco
 * que não seja local. Tudo o que cria, apaga no fim (a trilha de auditoria é append-only e fica).
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
const ORIGEM = creds.queue.conversation_id;

const supa = credenciaisSupabaseDeTeste();
if (!destinoEhLocal(supa.url)) {
  throw new Error(`inbox-encaminhar escreve no banco — recusado, o destino não é local (${supa.url}).`);
}
const admin = createClient(supa.url, supa.serviceRole, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const SUFIXO = String(Date.now());
const NOME_DO_DESTINO = `Destino Encaminhar ${SUFIXO}`;
const TEXTO = `Pode confirmar o horário de quinta? ${SUFIXO}`;
const TEXTO_APAGADO = `Mensagem que o cliente apagou ${SUFIXO}`;

let destinoId = "";
let contatoDestinoId = "";
let idTexto = "";
let idAudio = "";
let idApagada = "";
const mensagensDeOrigem: string[] = [];
const objetos: string[] = [];

test.describe.configure({ mode: "serial" });

function wavDeSilencio(): Buffer {
  const taxa = 8000;
  const n = taxa * 2;
  const b = Buffer.alloc(44 + n, 128);
  b.write("RIFF", 0); b.writeUInt32LE(36 + n, 4); b.write("WAVE", 8); b.write("fmt ", 12);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(taxa, 24);
  b.writeUInt32LE(taxa, 28); b.writeUInt16LE(1, 32); b.writeUInt16LE(8, 34); b.write("data", 36); b.writeUInt32LE(n, 40);
  return b;
}

async function login(page: Page, email: string): Promise<void> {
  await page.goto("/login");
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(creds.password);
  await page.getByRole("button", { name: /entrar/i }).click();
  await page.waitForURL(/\/app\//);
}

test.beforeAll(async () => {
  const { data: conv } = await admin
    .from("conversations")
    .select("contact_id, channel_session_id")
    .eq("id", ORIGEM)
    .single();
  const { contact_id, channel_session_id } = conv as { contact_id: string; channel_session_id: string };

  // A conversa de DESTINO: outro contato, outro cliente.
  const { data: contato, error: cErr } = await admin
    .from("contacts")
    .insert({
      organization_id: creds.org_id,
      name: NOME_DO_DESTINO,
      phone_number: `+55119${SUFIXO.slice(-8)}`,
    } as never)
    .select("id")
    .single();
  if (cErr || !contato) throw new Error(`criar contato de destino: ${cErr?.message}`);
  contatoDestinoId = (contato as { id: string }).id;

  const { data: conversa, error: vErr } = await admin
    .from("conversations")
    .insert({
      organization_id: creds.org_id,
      contact_id: contatoDestinoId,
      channel_session_id,
      status: "open",
    } as never)
    .select("id")
    .single();
  if (vErr || !conversa) throw new Error(`criar conversa de destino: ${vErr?.message}`);
  destinoId = (conversa as { id: string }).id;

  let t = Date.now() - 60_000;
  const nova = async (over: Record<string, unknown>): Promise<string> => {
    const id = crypto.randomUUID();
    t += 1000;
    const { error } = await admin.from("messages").insert({
      id,
      organization_id: creds.org_id,
      conversation_id: ORIGEM,
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
    mensagensDeOrigem.push(id);
    return id;
  };

  idTexto = await nova({ body: TEXTO });

  // Um áudio com ARQUIVO de verdade no armazenamento — é ele que o encaminhar vai copiar.
  const caminhoDoAudio = `${creds.org_id}/${ORIGEM}/${SUFIXO}-audio.ogg`;
  const up = await admin.storage
    .from("whatsapp-media")
    .upload(caminhoDoAudio, wavDeSilencio(), { contentType: "audio/ogg" });
  if (up.error) throw new Error(`subir o áudio: ${up.error.message}`);
  objetos.push(caminhoDoAudio);
  idAudio = await nova({
    type: "audio",
    media_mime: "audio/ogg",
    media_size_bytes: 16044,
    media_storage_path: caminhoDoAudio,
  });

  idApagada = await nova({ body: TEXTO_APAGADO, revoked_at: new Date(t).toISOString() });
});

test.afterAll(async () => {
  // O que o encaminhar criou na conversa de destino, e os arquivos copiados para lá.
  const { data: criadas } = await admin.from("messages").select("id, media_storage_path").eq("conversation_id", destinoId);
  for (const m of (criadas ?? []) as { id: string; media_storage_path: string | null }[]) {
    if (m.media_storage_path) objetos.push(m.media_storage_path);
  }
  await admin.from("messages").delete().eq("conversation_id", destinoId);
  for (const id of [...mensagensDeOrigem].reverse()) await admin.from("messages").delete().eq("id", id);
  if (objetos.length) await admin.storage.from("whatsapp-media").remove(objetos);
  await admin.from("conversations").delete().eq("id", destinoId);
  await admin.from("contacts").delete().eq("id", contatoDestinoId);
});

async function abrirAOrigem(page: Page): Promise<void> {
  await login(page, creds.users.manager!.email);
  await page.goto(`/app/inbox/${ORIGEM}`);
  await expect(page.getByText(TEXTO).first()).toBeVisible({ timeout: 30_000 });
}

const linhaDe = (page: Page, id: string) => page.locator(`[data-mensagem-id="${id}"]`);

async function comecarPor(page: Page, id: string): Promise<void> {
  const linha = linhaDe(page, id);
  await linha.scrollIntoViewIfNeeded();
  await linha.hover();
  await linha.getByRole("button", { name: /encaminhar esta mensagem/i }).click();
  await expect(page.getByRole("toolbar", { name: /encaminhar mensagens/i })).toBeVisible();
}

test("o caminho inteiro: seleção → destino → conferência → a mensagem chega à outra conversa", async ({ page }) => {
  await abrirAOrigem(page);
  await comecarPor(page, idTexto);

  // A que se começou já vem marcada; a barra conta.
  await expect(linhaDe(page, idTexto).getByRole("checkbox")).toBeChecked();
  await expect(page.getByRole("toolbar")).toContainText("1 mensagem selecionada");

  await page.getByRole("toolbar").getByRole("button", { name: /^encaminhar$/i }).click();
  const dialogo = page.getByRole("dialog");
  await expect(dialogo.getByRole("region", { name: /o que vai ser encaminhado/i })).toContainText(TEXTO);

  // Escolher o destino pela BUSCA (a lista traz as mais recentes; a busca vai ao servidor).
  await dialogo.getByRole("textbox", { name: /buscar conversa para encaminhar/i }).fill(NOME_DO_DESTINO);
  await dialogo.getByRole("checkbox", { name: new RegExp(NOME_DO_DESTINO) }).check();

  // A CONFERÊNCIA: de quem são, para quem vão — antes de enviar.
  await expect(dialogo.getByRole("note")).toContainText(NOME_DO_DESTINO);
  await expect(dialogo.getByRole("note")).toContainText("Confira antes de enviar");

  await dialogo.getByRole("button", { name: /^encaminhar$/i }).click();
  await expect(dialogo.getByTestId("resultado-do-encaminhamento")).toBeVisible({ timeout: 30_000 });

  // No BANCO: a cópia existe na conversa de destino, de saída, marcada como encaminhada, com o texto.
  await expect
    .poll(
      async () => {
        const { data } = await admin
          .from("messages")
          .select("body, direction, metadata")
          .eq("conversation_id", destinoId)
          .eq("body", TEXTO);
        return (data ?? []).length;
      },
      { timeout: 30_000 },
    )
    .toBe(1);
  const { data: copia } = await admin
    .from("messages")
    .select("body, direction, metadata")
    .eq("conversation_id", destinoId)
    .eq("body", TEXTO)
    .single();
  expect(copia).toMatchObject({ direction: "outbound" });
  expect((copia as { metadata: Record<string, unknown> }).metadata).toMatchObject({
    forwarded: true,
    forwarded_from_message_id: idTexto,
    forwarded_from_conversation_id: ORIGEM,
  });

  // Saiu do modo de seleção, e o campo de envio voltou.
  await dialogo.getByRole("button", { name: /fechar/i }).first().click();
  await expect(page.getByRole("toolbar", { name: /encaminhar mensagens/i })).toHaveCount(0);

  // E na conversa de DESTINO a bolha leva o rótulo.
  await page.goto(`/app/inbox/${destinoId}`);
  await expect(page.getByText(TEXTO).first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("Encaminhada").first()).toBeVisible();
});

test("o áudio vai como ARQUIVO COPIADO para a conversa de destino", async ({ page }) => {
  await abrirAOrigem(page);
  await comecarPor(page, idAudio);
  await page.getByRole("toolbar").getByRole("button", { name: /^encaminhar$/i }).click();

  const dialogo = page.getByRole("dialog");
  await expect(dialogo.getByRole("region", { name: /o que vai ser encaminhado/i })).toContainText("Áudio");
  await dialogo.getByRole("textbox", { name: /buscar conversa para encaminhar/i }).fill(NOME_DO_DESTINO);
  await dialogo.getByRole("checkbox", { name: new RegExp(NOME_DO_DESTINO) }).check();
  await dialogo.getByRole("button", { name: /^encaminhar$/i }).click();
  await expect(dialogo.getByTestId("resultado-do-encaminhamento")).toBeVisible({ timeout: 30_000 });

  await expect
    .poll(
      async () => {
        const { data } = await admin
          .from("messages")
          .select("media_storage_path")
          .eq("conversation_id", destinoId)
          .eq("type", "audio");
        return (data ?? []).length;
      },
      { timeout: 30_000 },
    )
    .toBe(1);
  const { data: audios } = await admin
    .from("messages")
    .select("media_storage_path")
    .eq("conversation_id", destinoId)
    .eq("type", "audio");
  const caminho = (audios as { media_storage_path: string }[])[0]!.media_storage_path;

  // Sob a conversa de DESTINO, com nome novo — o da origem não foi reaproveitado.
  expect(caminho).toMatch(new RegExp(`^${creds.org_id}/${destinoId}/fwd-[0-9a-f-]{36}\\.ogg$`));
  // E o arquivo existe de verdade lá, com os mesmos bytes.
  const baixado = await admin.storage.from("whatsapp-media").download(caminho);
  expect(baixado.error).toBeNull();
  expect(baixado.data!.size).toBe(wavDeSilencio().byteLength);
});

test("mensagem apagada não pode ser marcada — e a tela diz por quê", async ({ page }) => {
  await abrirAOrigem(page);
  await comecarPor(page, idTexto);

  const caixa = linhaDe(page, idApagada).getByRole("checkbox");
  await expect(caixa).toBeDisabled();
  await expect(caixa).toHaveAttribute("title", /apagada não pode ser encaminhada/i);
});

test("desistir (Esc) devolve o campo de envio COM o rascunho digitado", async ({ page }) => {
  await abrirAOrigem(page);
  const campo = page.getByPlaceholder(/escreva uma mensagem/i);
  await campo.fill("rascunho que não pode sumir");

  await comecarPor(page, idTexto);
  // Durante a seleção o campo de envio está ESCONDIDO — não desmontado.
  await expect(campo).toBeHidden();

  await page.keyboard.press("Escape");
  await expect(page.getByRole("toolbar", { name: /encaminhar mensagens/i })).toHaveCount(0);
  await expect(campo).toBeVisible();
  await expect(campo).toHaveValue("rascunho que não pode sumir");
});

test("a trilha: uma linha de auditoria por encaminhamento — sem o conteúdo", async () => {
  const { data } = await admin
    .from("api_audit_log")
    .select("action, resource_type, resource_id, metadata")
    .eq("action", "message.forwarded")
    .eq("resource_id", ORIGEM)
    .order("created_at", { ascending: false })
    .limit(5);
  const linhas = (data ?? []) as { metadata: Record<string, unknown> }[];
  // Os dois encaminhamentos dos testes acima (texto e áudio).
  expect(linhas.length).toBeGreaterThanOrEqual(2);
  const dosNossos = linhas.filter((l) => JSON.stringify(l.metadata).includes(destinoId));
  expect(dosNossos.length).toBeGreaterThanOrEqual(2);
  for (const l of dosNossos) {
    expect(l.metadata).toMatchObject({ destination_conversation_ids: [destinoId] });
    expect(JSON.stringify(l.metadata)).not.toContain(TEXTO);
  }
});
