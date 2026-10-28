import { fireEvent, render, screen } from "@testing-library/react";
import { useEffect } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * O PAINEL QUE O FUNIL ABRE AO LADO DO QUADRO.
 *
 * Duas coisas que a tela promete e que um teste de "renderiza" não pega:
 *
 *  1. TROCAR DE ABA NÃO APAGA O QUE SE FAZIA. Quem olha os dados do lead no meio
 *     de uma resposta volta e encontra o rascunho — por isso as duas abas ficam
 *     MONTADAS (`forceMount`), só uma escondida. A prova é contar quantas vezes a
 *     conversa foi montada, não achar o texto na tela.
 *  2. A conversa é a do INBOX. O painel não monta o campo de envio por conta
 *     própria (a janela de 24h e o contato bloqueado ficariam sem régua); isso
 *     está cercado em `janela-de-atendimento.test.tsx`.
 */

const { montagens, useConversationMock } = vi.hoisted(() => ({
  montagens: { conversa: 0, dossie: 0 },
  useConversationMock: vi.fn(),
}));

vi.mock("@/hooks/inbox/useConversation", () => ({
  useConversation: useConversationMock,
  isNotFound: (e: unknown) => (e as { status?: number } | null)?.status === 404,
}));

vi.mock("@/components/inbox/ConversaAberta", () => ({
  ConversaAberta: ({ conversation }: { conversation: { id: string } }) => {
    useEffect(() => {
      montagens.conversa += 1;
    }, []);
    return <div data-testid="conversa-aberta">conversa {conversation.id}</div>;
  },
}));

vi.mock("@/components/kanban/LeadDossier", () => ({
  LeadDossier: () => {
    useEffect(() => {
      montagens.dossie += 1;
    }, []);
    return <div data-testid="dossie">dados do negócio</div>;
  },
}));

vi.mock("next/link", () => ({
  default: ({ href, children, ...p }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...p}>
      {children}
    </a>
  ),
}));

import { PainelDoLead } from "@/components/kanban/PainelDoLead";
import type { Lead } from "@/lib/types/leads";

function lead(over: Partial<Lead> = {}): Lead {
  return {
    id: "lead-1",
    title: "Maria Silva",
    conversa: { id: "conv-1", preview: "oi", last_message_at: "2026-10-27T15:00:00Z", unread: 0 },
    ...over,
  } as Lead;
}

/**
 * A aba (painel) em que um elemento mora, e se ela está ativa.
 *
 * Não dá para perguntar `toBeVisible()`: com `forceMount` o Radix NUNCA põe `hidden` (o conteúdo
 * "está presente"), e quem esconde é a classe `data-[state=inactive]:hidden` — que o jsdom não
 * aplica. O estado fica no `data-state`; que a classe esconde DE VERDADE é do teste no navegador.
 */
function estadoDaAba(testId: string): string | null {
  return screen.getByTestId(testId).closest('[role="tabpanel"]')?.getAttribute("data-state") ?? null;
}

function montar(l: Lead = lead(), onClose = vi.fn()) {
  render(<PainelDoLead lead={l} pipelineId="p1" stageName="Novo" onClose={onClose} />);
  return onClose;
}

beforeEach(() => {
  montagens.conversa = 0;
  montagens.dossie = 0;
  useConversationMock.mockReset().mockReturnValue({
    isPending: false,
    data: { id: "conv-1" },
    error: null,
  });
});

describe("PainelDoLead", () => {
  it("lead COM conversa abre na conversa, e os dados ficam a um clique (escondidos, não ausentes)", () => {
    montar();
    expect(screen.getByRole("tab", { name: "Conversa" })).toHaveAttribute("aria-selected", "true");
    expect(estadoDaAba("conversa-aberta")).toBe("active");
    // Presente (montado) e inativo — não ausente.
    expect(estadoDaAba("dossie")).toBe("inactive");
  });

  it("lead SEM conversa abre nos dados, a aba da conversa não é clicável e a tela diz por quê", () => {
    montar(lead({ conversa: null }));
    expect(screen.getByRole("tab", { name: "Dados do lead" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "Conversa" })).toBeDisabled();
    expect(estadoDaAba("dossie")).toBe("active");
    expect(useConversationMock).not.toHaveBeenCalled();
  });

  it("trocar de aba NÃO remonta a conversa — o que se digitava continua lá", () => {
    montar();
    expect(montagens.conversa).toBe(1);

    fireEvent.mouseDown(screen.getByRole("tab", { name: "Dados do lead" }));
    expect(estadoDaAba("dossie")).toBe("active");
    expect(estadoDaAba("conversa-aberta")).toBe("inactive");

    fireEvent.mouseDown(screen.getByRole("tab", { name: "Conversa" }));
    expect(estadoDaAba("conversa-aberta")).toBe("active");

    expect(montagens.conversa, "a conversa foi desmontada e remontada ao trocar de aba").toBe(1);
    expect(montagens.dossie).toBe(1);
  });

  it("o botão de fechar chama onClose", () => {
    const onClose = montar();
    fireEvent.click(screen.getByRole("button", { name: "Fechar painel do lead" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("a conversa certa é buscada, e há a saída para o inbox cheio", () => {
    montar();
    expect(useConversationMock).toHaveBeenCalledWith("conv-1", true);
    expect(screen.getByRole("link", { name: /abrir no inbox/i })).toHaveAttribute(
      "href",
      "/app/inbox?id=conv-1",
    );
  });

  it("enquanto carrega mostra o esqueleto, sem montar a conversa", () => {
    useConversationMock.mockReturnValue({ isPending: true, data: undefined, error: null });
    montar();
    expect(screen.queryByTestId("conversa-aberta")).not.toBeInTheDocument();
    expect(document.querySelector("[aria-busy='true']")).not.toBeNull();
  });

  it("conversa fora do acesso diz isso; outro erro não finge que é a mesma coisa", () => {
    useConversationMock.mockReturnValue({ isPending: false, data: undefined, error: { status: 404 } });
    const { unmount } = render(
      <PainelDoLead lead={lead()} pipelineId="p1" stageName="Novo" onClose={vi.fn()} />,
    );
    expect(screen.getByText("Conversa não encontrada ou fora do seu acesso.")).toBeInTheDocument();
    unmount();

    useConversationMock.mockReturnValue({ isPending: false, data: undefined, error: { status: 500 } });
    render(<PainelDoLead lead={lead()} pipelineId="p1" stageName="Novo" onClose={vi.fn()} />);
    expect(screen.getByText(/Não consegui abrir a conversa/)).toBeInTheDocument();
    expect(screen.queryByText("Conversa não encontrada ou fora do seu acesso.")).not.toBeInTheDocument();
  });

  it("é um marco da página, com o nome do lead", () => {
    montar();
    expect(screen.getByRole("complementary", { name: /Maria Silva/ })).toBeInTheDocument();
  });
});
