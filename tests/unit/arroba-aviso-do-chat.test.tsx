import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * O AVISO NA TELA de quem foi marcado no chat da equipe.
 *
 * O botão do chat assina o tempo real e, com o painel fechado, mostra um aviso (toast) a cada mensagem
 * dos colegas. Quem foi MARCADO precisa saber por que o aviso é dele: "Ana marcou você" diz mais que
 * "Ana" + um texto que talvez nem cite o nome — e é esse o título que o `@todos` também deve ganhar.
 */

const { toastMock, aoReceberRef } = vi.hoisted(() => ({
  toastMock: vi.fn(),
  aoReceberRef: { atual: null as null | ((m: Record<string, unknown>) => void) },
}));

vi.mock("sonner", () => ({ toast: toastMock }));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (chave: string) => chave }));
vi.mock("@/hooks/auth/AuthProvider", () => ({
  useAuth: () => ({
    user: { id: "u-eu", is_platform_admin: false },
    activeOrg: { orgId: "org-1", role: "agent" },
  }),
}));
vi.mock("@/hooks/chat-interno/useChatInterno", () => ({
  useCanaisDaEquipe: () => ({ data: [] }),
  useChatInternoRealtime: (_org: string | null, aoReceber: (m: Record<string, unknown>) => void) => {
    aoReceberRef.atual = aoReceber;
  },
}));
vi.mock("@/components/chat-interno/PainelDoChat", () => ({ PainelDoChat: () => null }));

import { BotaoDoChat } from "@/components/chat-interno/BotaoDoChat";

function chega(over: Record<string, unknown>) {
  aoReceberRef.atual!({
    id: "m1",
    channel_id: "c1",
    sender_user_id: "u-ana",
    sender_name: "Ana",
    body: "oi, tudo bem?",
    created_at: new Date().toISOString(),
    ...over,
  });
}

beforeEach(() => {
  toastMock.mockClear();
  aoReceberRef.atual = null;
  render(<BotaoDoChat />);
});
afterEach(cleanup);

describe("o aviso das mensagens do chat", () => {
  it("mensagem comum: o título é só o nome de quem escreveu", () => {
    chega({});
    expect(toastMock).toHaveBeenCalledWith("Ana", expect.objectContaining({ description: "oi, tudo bem?" }));
  });

  it("quem foi marcado pelo NOME: '<nome> marcou você'", () => {
    chega({ mentions: [{ tipo: "pessoa", user_id: "u-eu", nome: "Eu" }] });
    expect(toastMock).toHaveBeenCalledWith("Ana marcou você", expect.anything());
  });

  it("o @todos também me inclui", () => {
    chega({ mentions: [{ tipo: "todos" }] });
    expect(toastMock).toHaveBeenCalledWith("Ana marcou você", expect.anything());
  });

  it("outra pessoa marcada: o aviso é o comum, sem dizer que me marcaram", () => {
    chega({ mentions: [{ tipo: "pessoa", user_id: "u-outro", nome: "Outro" }] });
    expect(toastMock).toHaveBeenCalledWith("Ana", expect.anything());
  });

  it("a mensagem que EU escrevi não gera aviso, mesmo marcando a mim mesmo", () => {
    chega({ sender_user_id: "u-eu", mentions: [{ tipo: "pessoa", user_id: "u-eu", nome: "Eu" }] });
    expect(toastMock).not.toHaveBeenCalled();
  });

  it("sem nome do remetente, cai para 'Equipe'", () => {
    chega({ sender_name: null, mentions: [{ tipo: "todos" }] });
    expect(toastMock).toHaveBeenCalledWith("Equipe marcou você", expect.anything());
  });
});
