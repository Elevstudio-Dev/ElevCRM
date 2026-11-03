/**
 * O `@` NAS ROTAS — o que o servidor faz com as marcações que o navegador manda.
 *
 * Contra os Route Handlers REAIS, com a autenticação, o Supabase e a lista de "quem pode ser marcado"
 * mockados. A lista, em si, é do banco (`tests/invariants/marcar-com-arroba.test.ts`); aqui se prova o
 * que a rota FAZ com ela: nunca confia no navegador, grava o nome que ELA conhece, e só avisa quem
 * pode ser avisado.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { requireRoleMock, marcaveisDaConversaMock, marcaveisDoCanalMock, emitirMencoesMock, auditMock } = vi.hoisted(
  () => ({
    requireRoleMock: vi.fn(),
    marcaveisDaConversaMock: vi.fn(),
    marcaveisDoCanalMock: vi.fn(),
    emitirMencoesMock: vi.fn(async (_entrada: Record<string, unknown>) => undefined),
    auditMock: vi.fn(async (_entrada: Record<string, unknown>) => undefined),
  }),
);

vi.mock("@/lib/auth/require-role", () => ({ requireRole: requireRoleMock }));
vi.mock("@/lib/audit", () => ({ audit: auditMock }));
vi.mock("@/lib/mencoes/avisar", () => ({ emitirMencoes: emitirMencoesMock }));
vi.mock("@/lib/mencoes/marcaveis", async (original) => {
  const real = await original<typeof import("@/lib/mencoes/marcaveis")>();
  return { ...real, marcaveisDaConversa: marcaveisDaConversaMock, marcaveisDoCanal: marcaveisDoCanalMock };
});

interface Ctx {
  inserts: Record<string, Array<Record<string, unknown>>>;
  existe: Record<string, unknown>;
}
let ctx: Ctx;

const supabaseStub = {
  from: (tabela: string) => {
    const b: Record<string, unknown> = {};
    const devolve = () => b;
    for (const m of ["select", "eq", "order", "limit", "lt", "upsert"]) b[m] = devolve;
    b.insert = (v: Record<string, unknown>) => {
      (ctx.inserts[tabela] ??= []).push(v);
      return b;
    };
    b.maybeSingle = async () => ({ data: ctx.existe[tabela] ?? null, error: null });
    b.single = async () => {
      const ultimo = ctx.inserts[tabela]?.at(-1) ?? {};
      return { data: { id: `${tabela}-1`, ...ultimo }, error: null };
    };
    b.then = (f: (v: unknown) => unknown, r?: (e: unknown) => unknown) =>
      Promise.resolve({ data: null, error: null }).then(f, r);
    return b;
  },
};
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => supabaseStub }));

import { GET as getMarcaveisDaConversa } from "@/app/api/v1/conversations/[id]/mentionable/route";
import { POST as postNota } from "@/app/api/v1/conversations/[id]/notes/route";
import { GET as getMarcaveisDoCanal } from "@/app/api/v1/team-chat/channels/[id]/mentionable/route";
import { POST as postMensagem } from "@/app/api/v1/team-chat/channels/[id]/messages/route";

const ORG = "22222222-2222-4222-8222-222222222222";
const AUTOR = "11111111-1111-4111-8111-111111111111";
const ANA = "33333333-3333-4333-8333-333333333331";
const ANA2 = "33333333-3333-4333-8333-333333333332";
const BIA = "33333333-3333-4333-8333-333333333333";
const FORA = "99999999-9999-4999-8999-999999999999";
const CONVERSA = "44444444-4444-4444-8444-444444444444";
const CANAL = "55555555-5555-4555-8555-555555555555";

const marcaveis = [
  { user_id: AUTOR, role: "agent", full_name: "Autor Silva", email: "autor@x.com" },
  { user_id: ANA, role: "agent", full_name: "Ana Souza", email: "ana.souza@x.com" },
  { user_id: ANA2, role: "manager", full_name: "Ana Lima", email: "ana.lima@x.com" },
  { user_id: BIA, role: "agent", full_name: "Beatriz Alves", email: "bia@x.com" },
];

function req(url: string, corpo?: unknown) {
  return new NextRequest(`http://localhost${url}`, {
    method: corpo === undefined ? "GET" : "POST",
    ...(corpo === undefined ? {} : { body: JSON.stringify(corpo), headers: { "content-type": "application/json" } }),
  });
}
const params = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  ctx = { inserts: {}, existe: { conversations: { id: CONVERSA }, team_channels: { id: CANAL, kind: "geral" } } };
  requireRoleMock.mockReset().mockResolvedValue({
    ok: true,
    user: { id: AUTOR, full_name: "Autor Silva", email: "autor@x.com" },
    org: { orgId: ORG },
  });
  marcaveisDaConversaMock.mockReset().mockResolvedValue(marcaveis);
  marcaveisDoCanalMock.mockReset().mockResolvedValue(marcaveis);
  emitirMencoesMock.mockClear();
  auditMock.mockClear();
});

describe("POST /conversations/[id]/notes", () => {
  it("grava a marcação com o NOME que o servidor conhece e avisa só quem foi escolhido", async () => {
    const res = await postNota(
      req(`/api/v1/conversations/${CONVERSA}/notes`, {
        body: "@Ana Souza vê isso",
        // O `nome` mandado pelo navegador é descartado.
        mentions: [{ tipo: "pessoa", user_id: ANA, nome: "Diretora" }],
      }),
      params(CONVERSA),
    );
    expect(res.status).toBe(201);
    expect(ctx.inserts.conversation_notes![0]).toMatchObject({
      organization_id: ORG,
      conversation_id: CONVERSA,
      body: "@Ana Souza vê isso",
      mentions: [{ tipo: "pessoa", user_id: ANA, nome: "Ana Souza" }],
    });
    expect(emitirMencoesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        entityKind: "conversation_note",
        avisar: [ANA],
        fromUserId: AUTOR,
        destino: { conversation_id: CONVERSA },
      }),
    );
  });

  it("duas Anas: só a escolhida pelo id é avisada (o texto sozinho casaria com as duas)", async () => {
    await postNota(
      req(`/api/v1/conversations/${CONVERSA}/notes`, {
        body: "@Ana Lima pode ver?",
        mentions: [{ tipo: "pessoa", user_id: ANA2 }],
      }),
      params(CONVERSA),
    );
    expect(emitirMencoesMock).toHaveBeenCalledWith(expect.objectContaining({ avisar: [ANA2] }));
  });

  it("quem NÃO enxerga a conversa é recusado: nada é gravado como marcação e ninguém é avisado", async () => {
    await postNota(
      req(`/api/v1/conversations/${CONVERSA}/notes`, {
        body: "@Intruso olha",
        mentions: [{ tipo: "pessoa", user_id: FORA }],
      }),
      params(CONVERSA),
    );
    expect(ctx.inserts.conversation_notes![0]).toMatchObject({ mentions: [] });
    expect(emitirMencoesMock).toHaveBeenCalledWith(expect.objectContaining({ avisar: [] }));
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: expect.objectContaining({ mencoes: 0, mencoes_recusadas: 1 }) }),
    );
  });

  it("@todos avisa só quem enxerga a conversa — nunca a organização inteira", async () => {
    marcaveisDaConversaMock.mockResolvedValue([marcaveis[0], marcaveis[1]]); // só o autor e a Ana veem
    await postNota(
      req(`/api/v1/conversations/${CONVERSA}/notes`, { body: "@todos atenção", mentions: [{ tipo: "todos" }] }),
      params(CONVERSA),
    );
    expect(emitirMencoesMock).toHaveBeenCalledWith(expect.objectContaining({ avisar: [ANA] }));
  });

  it("sem marcação guardada, vale o texto digitado à mão — mas só entre quem vê a conversa", async () => {
    await postNota(req(`/api/v1/conversations/${CONVERSA}/notes`, { body: "vê isso @beatriz" }), params(CONVERSA));
    expect(emitirMencoesMock).toHaveBeenCalledWith(expect.objectContaining({ avisar: [BIA] }));

    emitirMencoesMock.mockClear();
    marcaveisDaConversaMock.mockResolvedValue([marcaveis[0]]); // a Beatriz NÃO vê esta conversa
    await postNota(req(`/api/v1/conversations/${CONVERSA}/notes`, { body: "vê isso @beatriz" }), params(CONVERSA));
    expect(emitirMencoesMock).toHaveBeenCalledWith(expect.objectContaining({ avisar: [] }));
  });

  it("o texto da nota e os nomes marcados não vão para a auditoria", async () => {
    await postNota(
      req(`/api/v1/conversations/${CONVERSA}/notes`, { body: "@Ana Souza segredo", mentions: [{ tipo: "pessoa", user_id: ANA }] }),
      params(CONVERSA),
    );
    const meta = (auditMock.mock.calls[0]![0] as { metadata: Record<string, unknown> }).metadata;
    expect(JSON.stringify(meta)).not.toContain("segredo");
    expect(JSON.stringify(meta)).not.toContain("Ana");
  });

  it("marcação com id que não é uuid → 422, e nada é gravado", async () => {
    const res = await postNota(
      req(`/api/v1/conversations/${CONVERSA}/notes`, { body: "oi", mentions: [{ tipo: "pessoa", user_id: "ana" }] }),
      params(CONVERSA),
    );
    expect(res.status).toBe(422);
    expect(ctx.inserts.conversation_notes).toBeUndefined();
  });

  it("conversa que o usuário não enxerga → 404, sem perguntar a ninguém quem pode ser marcado", async () => {
    ctx.existe.conversations = null;
    const res = await postNota(
      req(`/api/v1/conversations/${CONVERSA}/notes`, { body: "oi", mentions: [{ tipo: "todos" }] }),
      params(CONVERSA),
    );
    expect(res.status).toBe(404);
    expect(marcaveisDaConversaMock).not.toHaveBeenCalled();
    expect(ctx.inserts.conversation_notes).toBeUndefined();
  });
});

describe("POST /team-chat/channels/[id]/messages", () => {
  it("grava a marcação e avisa quem foi escolhido, apontando para o CANAL", async () => {
    const res = await postMensagem(
      req(`/api/v1/team-chat/channels/${CANAL}/messages`, {
        body: "@Beatriz Alves o boleto caiu?",
        mentions: [{ tipo: "pessoa", user_id: BIA }],
      }),
      params(CANAL),
    );
    expect(res.status).toBe(201);
    expect(ctx.inserts.team_messages![0]).toMatchObject({
      channel_id: CANAL,
      mentions: [{ tipo: "pessoa", user_id: BIA, nome: "Beatriz Alves" }],
    });
    expect(emitirMencoesMock).toHaveBeenCalledWith(
      expect.objectContaining({ entityKind: "team_message", avisar: [BIA], destino: { channel_id: CANAL } }),
    );
  });

  it("recusa quem não está no canal (setor alheio, outra organização)", async () => {
    await postMensagem(
      req(`/api/v1/team-chat/channels/${CANAL}/messages`, { body: "@Intruso", mentions: [{ tipo: "pessoa", user_id: FORA }] }),
      params(CANAL),
    );
    expect(ctx.inserts.team_messages![0]).toMatchObject({ mentions: [] });
    expect(emitirMencoesMock).toHaveBeenCalledWith(expect.objectContaining({ avisar: [] }));
  });

  it("mensagem sem marcação não consulta o banco por 'quem pode ser marcado'", async () => {
    await postMensagem(req(`/api/v1/team-chat/channels/${CANAL}/messages`, { body: "bom dia" }), params(CANAL));
    expect(marcaveisDoCanalMock).not.toHaveBeenCalled();
    expect(ctx.inserts.team_messages![0]).toMatchObject({ mentions: [] });
  });

  it("@todos avisa os do canal, menos quem escreveu", async () => {
    await postMensagem(
      req(`/api/v1/team-chat/channels/${CANAL}/messages`, { body: "@todos bom dia", mentions: [{ tipo: "todos" }] }),
      params(CANAL),
    );
    const { avisar } = emitirMencoesMock.mock.calls[0]![0] as { avisar: string[] };
    expect([...avisar].sort()).toEqual([ANA, ANA2, BIA].sort());
    expect(avisar).not.toContain(AUTOR);
  });
});

describe("GET …/mentionable — a lista que a tela mostra", () => {
  it("conversa: devolve id, nome e papel — sem e-mail e sem o próprio usuário", async () => {
    const res = await getMarcaveisDaConversa(req(`/api/v1/conversations/${CONVERSA}/mentionable`), params(CONVERSA));
    const { data } = (await res.json()) as { data: Array<Record<string, unknown>> };
    expect(data.map((m) => m.nome)).toEqual(["Ana Lima", "Ana Souza", "Beatriz Alves"]);
    expect(data.every((m) => Object.keys(m).sort().join() === "nome,role,user_id")).toBe(true);
    expect(JSON.stringify(data)).not.toContain("@x.com");
    expect(data.map((m) => m.user_id)).not.toContain(AUTOR);
  });

  it("conversa que o usuário não vê → 404, sem listar ninguém", async () => {
    ctx.existe.conversations = null;
    const res = await getMarcaveisDaConversa(req(`/api/v1/conversations/${CONVERSA}/mentionable`), params(CONVERSA));
    expect(res.status).toBe(404);
    expect(marcaveisDaConversaMock).not.toHaveBeenCalled();
  });

  it("canal: devolve a lista do canal", async () => {
    const res = await getMarcaveisDoCanal(req(`/api/v1/team-chat/channels/${CANAL}/mentionable`), params(CANAL));
    const { data } = (await res.json()) as { data: unknown[] };
    expect(data).toHaveLength(3);
  });

  it("canal DIRETO: lista vazia (marcar alguém numa conversa de duas pessoas não diz nada)", async () => {
    ctx.existe.team_channels = { id: CANAL, kind: "direto" };
    const res = await getMarcaveisDoCanal(req(`/api/v1/team-chat/channels/${CANAL}/mentionable`), params(CANAL));
    expect(((await res.json()) as { data: unknown[] }).data).toEqual([]);
    expect(marcaveisDoCanalMock).not.toHaveBeenCalled();
  });

  it("canal que o usuário não vê → 404", async () => {
    ctx.existe.team_channels = null;
    const res = await getMarcaveisDoCanal(req(`/api/v1/team-chat/channels/${CANAL}/mentionable`), params(CANAL));
    expect(res.status).toBe(404);
  });
});
