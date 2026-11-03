import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A MARCAÇÃO QUE CHEGA NUM GRUPO — `@117137179947104` vira `@Gabriel Lima`.
 *
 * Medido no grupo de um cliente: a mensagem de quem marcou outra pessoa aparecia só como o número cru,
 * que o aparelho resolve pelo nome e o CRM não. A fila inteira: o fio descobre se há `@<número>` na
 * tela, só então pergunta quem está no grupo, e a bolha troca o número pelo nome — quando o sabe.
 */

let mensagens: Array<Record<string, unknown>> = [];
let participantes: Array<Record<string, unknown>> = [];
const pedidosDeParticipantes: Array<{ id: string | null; enabled: boolean }> = [];

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (chave: string) => chave }));
vi.mock("@/hooks/i18n/useLocaleDeData", () => ({ useLocaleDeData: () => undefined }));
vi.mock("@/hooks/auth/AuthProvider", () => ({
  useActiveOrg: () => ({ orgId: "org-1", role: "agent" }),
  useUser: () => ({ id: "u-eu" }),
}));
vi.mock("@/hooks/inbox/useMessagesRealtime", () => ({
  useMessagesRealtime: () => ({
    data: { pages: [{ data: mensagens }] },
    isLoading: false,
    isError: false,
    hasNextPage: false,
    isFetchingNextPage: false,
    realtimeStatus: "SUBSCRIBED",
    seguranca: { divergencias: 0 },
    refetch: vi.fn(),
    fetchNextPage: vi.fn(),
  }),
}));
vi.mock("@/hooks/inbox/useConversationNotes", () => ({ useConversationNotes: () => [] }));
vi.mock("@/hooks/inbox/useConversationAssignmentEvents", () => ({ useConversationAssignmentEvents: () => [] }));
vi.mock("@/hooks/inbox/useDeleteNote", () => ({ useDeleteNote: () => ({ mutate: vi.fn() }) }));
vi.mock("@/hooks/ai/useDebugToggle", () => ({ useDebugToggle: () => ({ enabled: false }) }));
vi.mock("@/hooks/mencoes/useParticipantesDoGrupo", () => ({
  useParticipantesDoGrupo: (id: string | null, enabled: boolean) => {
    pedidosDeParticipantes.push({ id, enabled });
    return { data: enabled ? participantes : undefined };
  },
}));

import { ChatThread } from "@/components/inbox/ChatThread";

function msg(over: Record<string, unknown>) {
  return {
    id: "m1",
    conversation_id: "c1",
    contact_id: "ct1",
    channel_session_id: "s1",
    external_id: "x1",
    type: "text",
    direction: "inbound",
    status: "delivered",
    ack: null,
    body: "@117137179947104",
    media_url: null,
    media_mime: null,
    media_size_bytes: null,
    media_storage_path: null,
    sent_via: "external_device",
    sent_at: "2026-10-27T12:00:00.000Z",
    delivered_at: null,
    read_at: null,
    error_code: null,
    error_message: null,
    metadata: {},
    created_at: "2026-10-27T12:00:00.000Z",
    ...over,
  };
}

const GABRIEL = { jid: "117137179947104@lid", nome: "Gabriel Lima", telefone: null, admin: false, conhecido: true };

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  mensagens = [msg({})];
  participantes = [GABRIEL];
  pedidosDeParticipantes.length = 0;
});
afterEach(cleanup);

const ultimoPedido = () => pedidosDeParticipantes.at(-1)!;

describe("o número marcado que chega num grupo", () => {
  it("vira o nome do participante, em destaque", () => {
    render(<ChatThread conversationId="c1" ehGrupo />);
    expect(screen.getByTestId("mencao")).toHaveTextContent("@Gabriel Lima");
    expect(screen.queryByText("@117137179947104")).not.toBeInTheDocument();
  });

  it("participante SEM nome conhecido: o número fica como chegou", () => {
    participantes = [{ ...GABRIEL, nome: "Participante 947104", conhecido: false }];
    render(<ChatThread conversationId="c1" ehGrupo />);
    expect(screen.queryByTestId("mencao")).not.toBeInTheDocument();
    expect(screen.getByText("@117137179947104")).toBeInTheDocument();
  });

  it("a marcação que o CRM ENVIOU (guardada) não é refeita pelo número", () => {
    mensagens = [
      msg({
        direction: "outbound",
        body: "oi @Maria Souza",
        metadata: { mentions: [{ tipo: "participante", jid: "5511999990001@c.us", nome: "Maria Souza" }] },
      }),
    ];
    render(<ChatThread conversationId="c1" ehGrupo />);
    expect(screen.getByTestId("mencao")).toHaveTextContent("@Maria Souza");
  });
});

describe("quando o fio pergunta quem está no grupo", () => {
  it("só num GRUPO e só havendo `@<número>` na tela", () => {
    render(<ChatThread conversationId="c1" ehGrupo />);
    expect(ultimoPedido()).toEqual({ id: "c1", enabled: true });
  });

  it("grupo sem nenhuma marcação nas mensagens: não pergunta", () => {
    mensagens = [msg({ body: "bom dia pessoal" }), msg({ id: "m2", body: "ligue 5511999990001" })];
    render(<ChatThread conversationId="c1" ehGrupo />);
    expect(pedidosDeParticipantes.every((p) => p.enabled === false)).toBe(true);
  });

  it("conversa 1:1 com um texto parecido: não pergunta", () => {
    render(<ChatThread conversationId="c1" ehGrupo={false} />);
    expect(pedidosDeParticipantes.every((p) => p.enabled === false)).toBe(true);
    expect(screen.queryByTestId("mencao")).not.toBeInTheDocument();
  });

  it("e-mail não conta como marcação", () => {
    mensagens = [msg({ body: "escreva para ana@5511999990001.com" })];
    render(<ChatThread conversationId="c1" ehGrupo />);
    expect(pedidosDeParticipantes.every((p) => p.enabled === false)).toBe(true);
  });
});
