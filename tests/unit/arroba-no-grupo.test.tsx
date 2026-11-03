import { NextRequest } from "next/server";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * O `@` NO GRUPO DE WHATSAPP — a rota que lista os participantes, o campo da resposta e a bolha.
 *
 * O que fica de fora, e que só um grupo e um aparelho de verdade provam: que o WhatsApp do participante
 * marcado toque. Aqui se prova o lado do CRM — quem aparece na lista, o que vai para a API e como a
 * mensagem aparece depois.
 */

const { requireRoleMock, getAdapterMock, loggerWarn } = vi.hoisted(() => ({
  requireRoleMock: vi.fn(),
  getAdapterMock: vi.fn(),
  loggerWarn: vi.fn(),
}));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: requireRoleMock }));
vi.mock("@/lib/logger", () => ({ logger: { warn: loggerWarn, info: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock("@/lib/channels", async (original) => {
  const real = await original<typeof import("@/lib/channels")>();
  return { ...real, getAdapter: getAdapterMock };
});

interface Estado {
  conversa: Record<string, unknown> | null;
  mensagens: Array<{ metadata: Record<string, unknown> }>;
}
let estado: Estado;

const supabaseStub = {
  from: (tabela: string) => {
    const b: Record<string, unknown> = {};
    for (const m of ["select", "eq", "not", "order", "limit"]) b[m] = () => b;
    b.maybeSingle = async () => ({ data: tabela === "conversations" ? estado.conversa : null, error: null });
    b.then = (f: (v: unknown) => unknown, r?: (e: unknown) => unknown) =>
      Promise.resolve({ data: tabela === "messages" ? estado.mensagens : null, error: null }).then(f, r);
    return b;
  },
};
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => supabaseStub }));

import { GET as getParticipantes } from "@/app/api/v1/conversations/[id]/group-participants/route";

const ORG = "22222222-2222-4222-8222-222222222222";
const CONVERSA = "44444444-4444-4444-8444-444444444444";
const GRUPO = "120363401969475450@g.us";
const params = { params: Promise.resolve({ id: CONVERSA }) };
const pedir = () => getParticipantes(new NextRequest(`http://localhost/api/v1/conversations/${CONVERSA}/group-participants`), params);

function conversaDeGrupo(over: Record<string, unknown> = {}) {
  return {
    id: CONVERSA,
    is_group: true,
    group_chat_id: GRUPO,
    channel_sessions: { provider: "waha", waha_session_name: "s1", status: "WORKING" },
    ...over,
  };
}

beforeEach(() => {
  estado = { conversa: conversaDeGrupo(), mensagens: [] };
  requireRoleMock.mockReset().mockResolvedValue({
    ok: true,
    user: { id: "u-eu", full_name: "Eu", email: "eu@x.com" },
    org: { orgId: ORG },
  });
  getAdapterMock.mockReset().mockReturnValue({
    listGroupParticipants: vi.fn(async () => [
      { jid: "5511999990001@c.us", phone: "5511999990001", admin: false },
      { jid: "117137179947104@lid", phone: null, admin: true },
    ]),
  });
  loggerWarn.mockClear();
});
afterEach(cleanup);

describe("GET /conversations/[id]/group-participants", () => {
  it("lista os participantes com o nome que o CRM viu de cada um nas mensagens do grupo", async () => {
    estado.mensagens = [
      { metadata: { grupo_participante: "5511999990001@c.us", grupo_participante_nome: "Maria Souza" } },
      { metadata: { grupo_participante: "5511999990001@c.us", grupo_participante_nome: "Mari" } },
    ];
    const res = await pedir();
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: Array<Record<string, unknown>> };
    expect(data).toEqual([
      { jid: "5511999990001@c.us", nome: "Maria Souza", telefone: "5511999990001", admin: false, conhecido: true },
      { jid: "117137179947104@lid", nome: "Participante 947104", telefone: null, admin: true, conhecido: false },
    ]);
  });

  it("a conversa que o usuário não vê é 404 — e o canal nem é consultado", async () => {
    estado.conversa = null;
    const res = await pedir();
    expect(res.status).toBe(404);
    expect(getAdapterMock).not.toHaveBeenCalled();
  });

  it("conversa 1:1: lista vazia, sem perguntar ao canal", async () => {
    estado.conversa = conversaDeGrupo({ is_group: false, group_chat_id: null });
    const res = await pedir();
    expect(((await res.json()) as { data: unknown[] }).data).toEqual([]);
    expect(getAdapterMock).not.toHaveBeenCalled();
  });

  it("canal que não sabe listar participantes: lista vazia (o @ fica desligado)", async () => {
    getAdapterMock.mockReturnValue({});
    const res = await pedir();
    expect(((await res.json()) as { data: unknown[] }).data).toEqual([]);
  });

  it("o canal falha: 200 com lista vazia, e o motivo vai para o log — escrever no grupo não trava", async () => {
    getAdapterMock.mockReturnValue({
      listGroupParticipants: vi.fn(async () => {
        throw new Error("waha_500: boom");
      }),
    });
    const res = await pedir();
    expect(res.status).toBe(200);
    const corpo = (await res.json()) as { data: unknown[]; meta?: { indisponivel?: boolean } };
    expect(corpo.data).toEqual([]);
    expect(corpo.meta?.indisponivel).toBe(true);
    expect(loggerWarn).toHaveBeenCalledWith(
      "grupo.participantes: o canal não devolveu a lista",
      expect.objectContaining({ organization_id: ORG, conversation_id: CONVERSA }),
    );
  });

  it("nome vindo do WhatsApp é texto de terceiro: chega limpo (sem @ na frente, sem quebra de linha)", async () => {
    estado.mensagens = [{ metadata: { grupo_participante: "5511999990001@c.us", grupo_participante_nome: "@@todos\nMaria" } }];
    const { data } = (await (await pedir()).json()) as { data: Array<{ nome: string }> };
    expect(data[0]!.nome).toBe("todos Maria");
  });
});

// ── o campo da resposta ────────────────────────────────────────────────────
const sendMock = vi.fn();
let participantes: Array<Record<string, unknown>> = [];
const argsDoHook: Array<{ id: string | null; enabled: boolean }> = [];

vi.mock("@/hooks/inbox/useSendMessage", () => ({ useSendMessage: () => ({ mutate: sendMock, isPending: false }) }));
vi.mock("@/hooks/inbox/useCreateNote", () => ({ useCreateNote: () => ({ mutate: vi.fn(), isPending: false }) }));
vi.mock("@/hooks/inbox/useUploadMedia", () => ({ useUploadMedia: () => ({ mutateAsync: vi.fn(), isPending: false }) }));
vi.mock("@/hooks/inbox/useMessageTemplates", () => ({ useMessageTemplates: () => ({ data: [], isLoading: false }) }));
vi.mock("@/hooks/inbox/useDraftReply", () => ({ useDraftReply: () => ({ mutate: vi.fn(), isPending: false }) }));
vi.mock("@/hooks/mencoes/useMarcaveis", () => ({
  useMarcaveisDaConversa: () => ({ data: [{ user_id: "u-ana", nome: "Ana Souza", role: "agent" }] }),
  useMarcaveisDoCanal: () => ({ data: [] }),
}));
vi.mock("@/hooks/mencoes/useParticipantesDoGrupo", () => ({
  // Devolve a lista INDEPENDENTE do `enabled` (o hook de verdade, desligado, não devolveria): assim o
  // que impede o `@` numa conversa 1:1 é o próprio Composer — e o `enabled` fica conferido à parte, em
  // `argsDoHook`. Com um mock que já escondesse os dados quando desligado, um dos dois cuidados poderia
  // sumir sem o teste notar.
  useParticipantesDoGrupo: (id: string | null, enabled: boolean) => {
    argsDoHook.push({ id, enabled });
    return { data: participantes };
  },
}));

import { Composer } from "@/components/inbox/Composer";
import { MessageBubble } from "@/components/inbox/MessageBubble";
import type { Message } from "@/lib/types/messaging";

const MARIA = { jid: "5511999990001@c.us", nome: "Maria Souza", telefone: "5511999990001", admin: false, conhecido: true };
const LID = { jid: "117137179947104@lid", nome: "Participante 947104", telefone: null, admin: true, conhecido: false };

function abrir(ehGrupo: boolean) {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <Composer conversationId="conv-1" ehGrupo={ehGrupo} />
    </QueryClientProvider>,
  );
  return screen.getByLabelText(/mensagem/i) as HTMLTextAreaElement;
}
const digitar = (campo: HTMLTextAreaElement, v: string) => fireEvent.change(campo, { target: { value: v } });

describe("o campo da resposta num GRUPO", () => {
  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn();
    participantes = [MARIA, LID];
    sendMock.mockClear();
    argsDoHook.length = 0;
  });

  it("o @ abre os participantes do grupo, com @todos no topo, o telefone e o admin", () => {
    const campo = abrir(true);
    digitar(campo, "@");
    const opcoes = screen.getAllByTestId("opcao-de-mencao");
    expect(opcoes.map((o) => o.getAttribute("data-nome"))).toEqual(["todos", "Maria Souza", "Participante 947104"]);
    expect(screen.getByText("Avisa o grupo inteiro")).toBeInTheDocument();
    expect(screen.getByText("+5511999990001")).toBeInTheDocument();
    expect(screen.getByText("admin do grupo")).toBeInTheDocument();
  });

  it("escolher e enviar leva a marcação do participante (o endereço, não só o nome)", () => {
    const campo = abrir(true);
    digitar(campo, "@mar");
    fireEvent.keyDown(campo, { key: "Enter" });
    expect(campo.value).toBe("@Maria Souza ");
    digitar(campo, "@Maria Souza o orçamento saiu");
    fireEvent.click(screen.getByRole("button", { name: /^enviar$/i }));
    expect(sendMock).toHaveBeenCalledWith(
      expect.objectContaining({
        conversation_id: "conv-1",
        body: "@Maria Souza o orçamento saiu",
        type: "text",
        mentions: [{ tipo: "participante", jid: "5511999990001@c.us", nome: "Maria Souza" }],
      }),
      expect.anything(),
    );
  });

  it("@todos vai como { tipo: 'todos' }", () => {
    const campo = abrir(true);
    digitar(campo, "@to");
    fireEvent.keyDown(campo, { key: "Enter" });
    digitar(campo, "@todos reunião às 15h");
    fireEvent.click(screen.getByRole("button", { name: /^enviar$/i }));
    expect(sendMock).toHaveBeenCalledWith(expect.objectContaining({ mentions: [{ tipo: "todos" }] }), expect.anything());
  });

  it("mensagem sem @ sai sem o campo `mentions` — o corpo é o de sempre", () => {
    const campo = abrir(true);
    digitar(campo, "bom dia pessoal");
    fireEvent.click(screen.getByRole("button", { name: /^enviar$/i }));
    const enviado = sendMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(enviado).toEqual({ conversation_id: "conv-1", body: "bom dia pessoal", type: "text" });
  });

  it("numa conversa 1:1 o @ é só um caractere, e os participantes nem são pedidos", () => {
    const campo = abrir(false);
    digitar(campo, "@");
    expect(screen.queryByTestId("menu-de-mencao")).not.toBeInTheDocument();
    expect(argsDoHook.every((a) => a.enabled === false)).toBe(true);
  });

  it("na NOTA INTERNA do grupo o @ marca colegas da equipe, não participantes — e os participantes não são pedidos", () => {
    const campo = abrir(true);
    fireEvent.click(screen.getByRole("button", { name: /nota interna/i }));
    const notaCampo = screen.getByPlaceholderText(/nota interna/i) as HTMLTextAreaElement;
    digitar(notaCampo, "@");
    expect(screen.getAllByTestId("opcao-de-mencao").map((o) => o.getAttribute("data-nome"))).toEqual(["todos", "Ana Souza"]);
    expect(screen.getByText("Avisa quem enxerga esta conversa")).toBeInTheDocument();
    expect(argsDoHook.at(-1)!.enabled).toBe(false);
    expect(campo).toBeTruthy();
  });

  it("trocar de aba zera o que foi escolhido na outra: colega da nota não vai como participante", () => {
    abrir(true);
    fireEvent.click(screen.getByRole("button", { name: /nota interna/i }));
    const nota = screen.getByPlaceholderText(/nota interna/i) as HTMLTextAreaElement;
    digitar(nota, "@an");
    fireEvent.keyDown(nota, { key: "Enter" });
    expect(nota.value).toBe("@Ana Souza ");

    fireEvent.click(screen.getByRole("button", { name: /^responder$/i }));
    const resposta = screen.getByLabelText(/mensagem/i) as HTMLTextAreaElement;
    digitar(resposta, "@Ana Souza oi");
    fireEvent.click(screen.getByRole("button", { name: /^enviar$/i }));
    expect(sendMock.mock.calls[0]![0]).not.toHaveProperty("mentions");
  });

  it("grupo sem participante conhecido: o @ não abre nada", () => {
    participantes = [];
    const campo = abrir(true);
    digitar(campo, "@");
    expect(screen.queryByTestId("menu-de-mencao")).not.toBeInTheDocument();
  });
});

// ── a bolha ────────────────────────────────────────────────────────────────
function msg(over: Partial<Message> = {}): Message {
  return {
    id: "m1",
    conversation_id: "c1",
    contact_id: "ct1",
    channel_session_id: "s1",
    external_id: "x1",
    type: "text",
    direction: "outbound",
    status: "sent",
    ack: null,
    body: "oi @Maria Souza, tudo bem?",
    media_url: null,
    media_mime: null,
    media_size_bytes: null,
    media_storage_path: null,
    sent_via: "user",
    sent_at: "2026-10-27T12:00:00.000Z",
    delivered_at: null,
    read_at: null,
    error_code: null,
    error_message: null,
    metadata: { mentions: [{ tipo: "participante", jid: "5511999990001@c.us", nome: "Maria Souza" }] },
    created_at: "2026-10-27T12:00:00.000Z",
    ...over,
  } as Message;
}

describe("a bolha da mensagem com marcação", () => {
  it("mostra o nome marcado em destaque, e o texto inteiro continua legível", () => {
    const { container } = render(<MessageBubble message={msg()} />);
    expect(screen.getByTestId("mencao")).toHaveTextContent("@Maria Souza");
    expect(container.textContent).toContain("oi @Maria Souza, tudo bem?");
  });

  it("na bolha de SAÍDA (colorida) o destaque herda a cor do texto; na de ENTRADA usa a cor de destaque", () => {
    const { unmount } = render(<MessageBubble message={msg()} />);
    expect(screen.getByTestId("mencao").className).toContain("bg-white/25");
    expect(screen.getByTestId("mencao").className).not.toContain("text-primary");
    unmount();
    render(<MessageBubble message={msg({ direction: "inbound" })} />);
    expect(screen.getByTestId("mencao").className).toContain("text-primary");
  });

  it("mensagem sem marcação (a imensa maioria) é texto puro, como antes", () => {
    const { container } = render(<MessageBubble message={msg({ metadata: {} })} />);
    expect(screen.queryByTestId("mencao")).not.toBeInTheDocument();
    expect(container.textContent).toContain("oi @Maria Souza, tudo bem?");
  });

  it("`metadata.mentions` com lixo não derruba a bolha", () => {
    render(<MessageBubble message={msg({ metadata: { mentions: "quebrado" } })} />);
    expect(screen.queryByTestId("mencao")).not.toBeInTheDocument();
  });
});
