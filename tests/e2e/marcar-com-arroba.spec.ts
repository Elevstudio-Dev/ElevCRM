/**
 * MARCAR ALGUÉM COM @ — pela tela, como a atendente faz, no chat da equipe e na nota interna.
 *
 * O pedido: "marcar a pessoa pelo @, igual ao do WhatsApp". Este arquivo prova, no navegador de verdade
 * e contra o banco:
 *
 *  1. CHAT DA EQUIPE: digitar `@` abre a lista (com o `@todos` no topo); escolher põe o nome no texto;
 *     a mensagem sai com o nome em destaque; e a marcação fica guardada com o ID da pessoa — não só o
 *     texto — e gera o evento `user.mentioned` para ela e só para ela;
 *  2. `@todos` avisa todos os colegas do canal (um evento cada) e nunca quem escreveu;
 *  3. NOTA INTERNA: o mesmo, e o evento aponta para a CONVERSA;
 *  4. QUEM NÃO ENXERGA A CONVERSA NÃO APARECE NA LISTA da nota, nem na API — marcar alguém que não abre
 *     a conversa seria lhe entregar o começo de uma conversa que ela não pode ler. É a regra que o banco
 *     responde (`fn_membros_que_veem_conversa`), medida aqui pela tela;
 *  5. A LISTA CABE na tela do celular (375px) e fica acima do campo.
 *
 * ⚠️ O que NÃO prova: a marcação num GRUPO DE WHATSAPP. Ela precisa do WhatsApp conectado a um grupo de
 * verdade (a lista de participantes vem de lá), e o servidor de teste não tem. O que se prova dela está
 * nos testes unitários, contra um WAHA falso — e o que falta (o aparelho do participante tocar) só se vê
 * com um grupo e um celular. Também não prova o push no navegador: prova o EVENTO, que é o que o worker
 * de notificações transforma em push.
 *
 * Os dados vão direto no banco com a service role, e o arquivo RECUSA rodar contra banco que não seja
 * local. Tudo o que cria, apaga no fim (o log de eventos é append-only e fica).
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
const CONVERSA_DA_FILA = creds.queue.conversation_id;

const supa = credenciaisSupabaseDeTeste();
if (!destinoEhLocal(supa.url)) {
  throw new Error(`marcar-com-arroba escreve no banco — recusado, o destino não é local (${supa.url}).`);
}
const admin = createClient(supa.url, supa.serviceRole, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const SUFIXO = String(Date.now());

interface Marcavel {
  user_id: string;
  nome: string;
  role: string;
}

let contatoExtraId = "";
let conversaDoGestorId = "";

test.describe.configure({ mode: "serial", timeout: 120_000 });

async function entrar(page: Page, papel: string): Promise<void> {
  const usuario = creds.users[papel];
  if (!usuario) throw new Error(`.e2e-creds.json sem o usuário \`${papel}\``);
  await page.goto("/login");
  await page.locator("#email").fill(usuario.email);
  await page.locator("#password").fill(creds.password);
  await page.getByRole("button", { name: /entrar/i }).click();
  // 90s e não 30: no servidor de DESENVOLVIMENTO a primeira entrada compila a área logada inteira
  // ("Compiling…"), e isso passa de 30s numa máquina carregada. No CI (build de produção) é instantâneo.
  await page.waitForURL(/\/app\//, { timeout: 90_000 });
}

async function idDoUsuario(email: string): Promise<string> {
  const { data, error } = await admin.auth.admin.listUsers({ perPage: 1000 });
  if (error) throw new Error(`listar usuários: ${error.message}`);
  const u = data.users.find((x) => x.email === email);
  if (!u) throw new Error(`usuário ${email} não existe`);
  return u.id;
}

/** Os eventos `user.mentioned` de uma mensagem/nota, por destinatário. O envio do evento é assíncrono. */
async function destinatariosDoEvento(entityKind: string, entityId: string): Promise<string[]> {
  const { data, error } = await admin
    .from("event_log")
    .select("payload")
    .eq("organization_id", creds.org_id)
    .eq("event_type", "user.mentioned")
    .eq("entity_kind", entityKind)
    .eq("entity_id", entityId);
  if (error) throw new Error(`ler event_log: ${error.message}`);
  return ((data ?? []) as Array<{ payload: { to_user_id?: string } }>)
    .map((l) => l.payload.to_user_id)
    .filter((x): x is string => !!x)
    .sort();
}

async function canalGeral(page: Page): Promise<{ canalId: string; colegas: Marcavel[] }> {
  const canais = (await (await page.request.get("/api/v1/team-chat/channels")).json()) as {
    data: Array<{ id: string; kind: string }>;
  };
  const geral = canais.data.find((c) => c.kind === "geral");
  if (!geral) throw new Error("a organização de teste não tem canal Geral");
  const r = (await (await page.request.get(`/api/v1/team-chat/channels/${geral.id}/mentionable`)).json()) as {
    data: Marcavel[];
  };
  return { canalId: geral.id, colegas: r.data };
}

async function abrirOChat(page: Page) {
  await page.goto("/app/inbox");
  await page.getByTestId("botao-do-chat").click();
  await expect(page.getByTestId("fio-do-chat")).toBeVisible({ timeout: 30_000 });
  return page.getByLabel("Mensagem para a equipe");
}

test.afterAll(async () => {
  await admin.from("team_messages").delete().like("body", `%${SUFIXO}%`);
  await admin.from("conversation_notes").delete().like("body", `%${SUFIXO}%`);
  if (conversaDoGestorId) await admin.from("conversations").delete().eq("id", conversaDoGestorId);
  if (contatoExtraId) await admin.from("contacts").delete().eq("id", contatoExtraId);
});

test("chat da equipe: o @ abre a lista com o @todos no topo, filtra, o Enter escolhe e o Esc fecha", async ({ page }) => {
  await entrar(page, "manager");
  const { colegas } = await canalGeral(page);
  // A precondição é AFIRMADA: sem colega no canal o `@` fica desligado e o teste mediria outra coisa.
  expect(colegas.length, "o canal Geral precisa ter ao menos um colega do manager").toBeGreaterThan(0);
  const colega = colegas[0]!;

  const campo = await abrirOChat(page);
  await campo.fill("@");
  // A lista depende de uma consulta (quem está no canal): na primeira vez, no servidor de desenvolvimento,
  // ela espera a rota compilar. A lista aparece sozinha quando a resposta chega, com o `@` já digitado.
  await expect(page.getByTestId("menu-de-mencao")).toBeVisible({ timeout: 30_000 });
  const opcoes = page.getByTestId("opcao-de-mencao");
  await expect(opcoes.first()).toHaveAttribute("data-nome", "todos");
  await expect(opcoes.filter({ hasText: colega.nome }).first()).toBeVisible();

  // Filtra pelo começo do nome e escolhe com o teclado, como no WhatsApp.
  await campo.fill(`@${colega.nome.slice(0, 3)}`);
  await expect(opcoes.filter({ hasText: colega.nome }).first()).toBeVisible();
  await campo.press("Enter");
  await expect(campo).toHaveValue(/^@.+ $/);
  await expect(page.getByTestId("menu-de-mencao")).toBeHidden();

  // O Esc fecha a lista e deixa o texto como está.
  await campo.fill("@");
  await expect(page.getByTestId("menu-de-mencao")).toBeVisible();
  await campo.press("Escape");
  await expect(page.getByTestId("menu-de-mencao")).toBeHidden();
  await expect(campo).toHaveValue("@");

  // E `@` no meio de um e-mail não abre nada.
  await campo.fill("ana@empresa.com");
  await expect(page.getByTestId("menu-de-mencao")).toBeHidden();
});

test("chat da equipe: escolher na lista guarda a marcação com o ID da pessoa e avisa SÓ ela", async ({ page }) => {
  await entrar(page, "manager");
  const { canalId, colegas } = await canalGeral(page);
  const colega = colegas[0]!;

  const campo = await abrirOChat(page);
  // O caminho inteiro, só pelo teclado: @ + começo do nome + Enter escolhe + texto + Enter envia.
  await campo.fill("");
  await campo.pressSequentially("@");
  await expect(page.getByTestId("menu-de-mencao")).toBeVisible({ timeout: 30_000 });
  await campo.pressSequentially(colega.nome.slice(0, 2));
  const opcao = page.getByTestId("opcao-de-mencao").filter({ hasText: colega.nome }).first();
  await expect(opcao).toBeVisible();
  // Clica na linha certa (mais de um nome pode casar o começo digitado).
  await opcao.dispatchEvent("mousedown");
  await expect(campo).toHaveValue(`@${colega.nome} `);
  await campo.pressSequentially(`conferido ${SUFIXO}-b`);
  await campo.press("Enter");

  const mensagem = page.getByTestId("mensagem-da-equipe").filter({ hasText: `${SUFIXO}-b` });
  await expect(mensagem).toBeVisible({ timeout: 15_000 });
  await expect(mensagem.getByTestId("mencao")).toHaveText(`@${colega.nome}`);

  const lista = (await (await page.request.get(`/api/v1/team-chat/channels/${canalId}/messages?limit=20`)).json()) as {
    data: Array<{ id: string; body: string; mentions: unknown }>;
  };
  const gravada = lista.data.find((m) => m.body.includes(`${SUFIXO}-b`))!;
  expect(gravada.mentions).toEqual([{ tipo: "pessoa", user_id: colega.user_id, nome: colega.nome }]);

  await expect
    .poll(() => destinatariosDoEvento("team_message", gravada.id), { timeout: 15_000 })
    .toEqual([colega.user_id]);
});

test("chat da equipe: @todos avisa todos os colegas do canal — e nunca quem escreveu", async ({ page }) => {
  await entrar(page, "manager");
  const { canalId, colegas } = await canalGeral(page);
  const euId = await idDoUsuario(creds.users.manager!.email);

  const campo = await abrirOChat(page);
  await campo.pressSequentially("@to");
  await expect(page.getByTestId("opcao-de-mencao")).toHaveCount(1, { timeout: 30_000 });
  await campo.press("Enter");
  await expect(campo).toHaveValue("@todos ");
  await campo.pressSequentially(`reunião às 15h ${SUFIXO}-c`);
  await campo.press("Enter");

  const mensagem = page.getByTestId("mensagem-da-equipe").filter({ hasText: `${SUFIXO}-c` });
  await expect(mensagem).toBeVisible({ timeout: 15_000 });
  // O @todos inclui a mim: destaque mais forte.
  await expect(mensagem.getByTestId("mencao")).toHaveAttribute("data-comigo", "true");

  const lista = (await (await page.request.get(`/api/v1/team-chat/channels/${canalId}/messages?limit=20`)).json()) as {
    data: Array<{ id: string; body: string; mentions: unknown }>;
  };
  const gravada = lista.data.find((m) => m.body.includes(`${SUFIXO}-c`))!;
  expect(gravada.mentions).toEqual([{ tipo: "todos" }]);

  const esperados = colegas.map((c) => c.user_id).sort();
  await expect.poll(() => destinatariosDoEvento("team_message", gravada.id), { timeout: 15_000 }).toEqual(esperados);
  expect(esperados).not.toContain(euId);
});

test("nota interna: marcar um colega guarda a marcação, destaca o nome e avisa a pessoa pela CONVERSA", async ({ page }) => {
  await entrar(page, "manager");
  const lista = (await (await page.request.get(`/api/v1/conversations/${CONVERSA_DA_FILA}/mentionable`)).json()) as {
    data: Marcavel[];
  };
  expect(lista.data.length, "a conversa da fila precisa ter ao menos um colega que a enxergue").toBeGreaterThan(0);
  const colega = lista.data[0]!;

  await page.goto(`/app/inbox/${CONVERSA_DA_FILA}`);
  await page.getByRole("button", { name: /nota interna/i }).click();
  const campo = page.getByPlaceholder(/nota interna/i);
  await campo.pressSequentially("@");
  await expect(page.getByTestId("menu-de-mencao")).toBeVisible({ timeout: 15_000 });
  await campo.pressSequentially(colega.nome.slice(0, 2));
  const opcao = page.getByTestId("opcao-de-mencao").filter({ hasText: colega.nome }).first();
  await expect(opcao).toBeVisible();
  await opcao.dispatchEvent("mousedown");
  await expect(campo).toHaveValue(`@${colega.nome} `);
  await campo.pressSequentially(`veja isso ${SUFIXO}-n`);
  await campo.press("Enter");

  const nota = page.getByTestId("nota-interna").filter({ hasText: `${SUFIXO}-n` });
  await expect(nota).toBeVisible({ timeout: 15_000 });
  await expect(nota.getByTestId("mencao")).toHaveText(`@${colega.nome}`);

  const { data: linhas } = await admin
    .from("conversation_notes")
    .select("id, mentions")
    .eq("conversation_id", CONVERSA_DA_FILA)
    .like("body", `%${SUFIXO}-n%`);
  expect(linhas).toHaveLength(1);
  const gravada = (linhas as Array<{ id: string; mentions: unknown }>)[0]!;
  expect(gravada.mentions).toEqual([{ tipo: "pessoa", user_id: colega.user_id, nome: colega.nome }]);

  await expect
    .poll(() => destinatariosDoEvento("conversation_note", gravada.id), { timeout: 15_000 })
    .toEqual([colega.user_id]);
  // O evento aponta para a CONVERSA: é para onde o aviso leva quem clica.
  const { data: ev } = await admin
    .from("event_log")
    .select("payload")
    .eq("organization_id", creds.org_id)
    .eq("event_type", "user.mentioned")
    .eq("entity_id", gravada.id);
  expect((ev as Array<{ payload: { conversation_id?: string } }>)[0]!.payload.conversation_id).toBe(CONVERSA_DA_FILA);
});

test("nota interna: quem NÃO enxerga a conversa não aparece na lista — nem na tela, nem na API", async ({ page }) => {
  const { data: org } = await admin.from("organizations").select("settings").eq("id", creds.org_id).single();
  const modo = (org as { settings?: { visibility_mode?: string } } | null)?.settings?.visibility_mode ?? "own_and_unassigned";
  test.skip(modo === "all", "visibility_mode='all': o agente enxerga toda conversa, não há quem ficar de fora");

  const gestorId = await idDoUsuario(creds.users.manager!.email);
  const agenteId = await idDoUsuario(creds.users.agent!.email);

  // Uma conversa ATRIBUÍDA ao gestor: o agente, que só enxerga as suas e as da fila, não a vê.
  const { data: base } = await admin
    .from("conversations")
    .select("channel_session_id")
    .eq("id", CONVERSA_DA_FILA)
    .single();
  const { data: contato, error: cErr } = await admin
    .from("contacts")
    .insert({ organization_id: creds.org_id, name: `Cliente Arroba ${SUFIXO}`, phone_number: `+55119${SUFIXO.slice(-8)}` } as never)
    .select("id")
    .single();
  if (cErr || !contato) throw new Error(`criar contato: ${cErr?.message}`);
  contatoExtraId = (contato as { id: string }).id;
  const { data: conversa, error: vErr } = await admin
    .from("conversations")
    .insert({
      organization_id: creds.org_id,
      contact_id: contatoExtraId,
      channel_session_id: (base as { channel_session_id: string }).channel_session_id,
      status: "claimed",
      assigned_to_user_id: gestorId,
      assigned_at: new Date().toISOString(),
      assignee_kind: "user",
    } as never)
    .select("id")
    .single();
  if (vErr || !conversa) throw new Error(`criar conversa: ${vErr?.message}`);
  conversaDoGestorId = (conversa as { id: string }).id;

  await entrar(page, "manager");
  const daFila = (await (await page.request.get(`/api/v1/conversations/${CONVERSA_DA_FILA}/mentionable`)).json()) as {
    data: Marcavel[];
  };
  const doGestor = (await (await page.request.get(`/api/v1/conversations/${conversaDoGestorId}/mentionable`)).json()) as {
    data: Marcavel[];
  };
  // CONTROLE: o agente enxerga a conversa da fila, então aparece nela. Sem isto o "não aparece" abaixo
  // poderia ser só uma lista vazia por outro motivo.
  expect(daFila.data.map((m) => m.user_id)).toContain(agenteId);
  expect(doGestor.data.map((m) => m.user_id)).not.toContain(agenteId);

  // E pela TELA: o nome do agente não é oferecido na nota da conversa que ele não enxerga.
  const nomeDoAgente = daFila.data.find((m) => m.user_id === agenteId)!.nome;
  await page.goto(`/app/inbox/${conversaDoGestorId}`);
  await page.getByRole("button", { name: /nota interna/i }).click();
  const campo = page.getByPlaceholder(/nota interna/i);
  await campo.pressSequentially("@");
  // Há outros colegas que enxergam a conversa (o gestor mesmo é excluído, mas admin/gestores não): se a
  // lista nem abrir, o teste ainda vale — o que importa é o agente não estar nela.
  await page.waitForTimeout(1500);
  await expect(page.getByTestId("opcao-de-mencao").filter({ hasText: nomeDoAgente })).toHaveCount(0);
});

test("a lista do @ cabe na tela do celular (375px) e fica ACIMA do campo", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await entrar(page, "manager");
  await page.goto(`/app/inbox/${CONVERSA_DA_FILA}`);
  await page.getByRole("button", { name: /nota interna/i }).click();
  const campo = page.getByPlaceholder(/nota interna/i);
  await campo.pressSequentially("@");
  const menu = page.getByTestId("menu-de-mencao");
  await expect(menu).toBeVisible({ timeout: 15_000 });

  const m = (await menu.boundingBox())!;
  const c = (await campo.boundingBox())!;
  expect(m.x, "a lista sai pela esquerda").toBeGreaterThanOrEqual(0);
  expect(m.x + m.width, "a lista sai pela direita").toBeLessThanOrEqual(375);
  expect(m.y, "a lista sai por cima da tela").toBeGreaterThanOrEqual(0);
  expect(m.y + m.height, "a lista cobre o campo de escrever").toBeLessThanOrEqual(c.y + 1);
  // A página não ganhou rolagem lateral por causa da lista.
  const sobra = await page.evaluate(() => document.body.scrollWidth - document.documentElement.clientWidth);
  expect(sobra).toBeLessThanOrEqual(0);
});
