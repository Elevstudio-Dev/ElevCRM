import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * O `@` NA NOTA INTERNA — do teclado até o que vai para a API.
 *
 * O que se prova aqui é o COMPORTAMENTO do campo: a lista abre ao digitar `@`, filtra, escolhe por
 * teclado e por clique, não rouba o Enter de quem só quer enviar, e a nota sai com as marcações que o
 * texto AINDA cita. Quem decide quem PODE ser marcado é o banco (`tests/invariants/marcar-com-arroba`),
 * e a posição da lista em cada largura é CSS — que quem prova é o e2e, no navegador.
 */

const sendMock = vi.fn();
const createNoteMock = vi.fn();
let colegas: Array<{ user_id: string; nome: string; role: string }> = [];

vi.mock("@/hooks/inbox/useSendMessage", () => ({
  useSendMessage: () => ({ mutate: sendMock, isPending: false }),
}));
vi.mock("@/hooks/inbox/useCreateNote", () => ({
  useCreateNote: () => ({ mutate: createNoteMock, isPending: false }),
}));
vi.mock("@/hooks/inbox/useUploadMedia", () => ({
  useUploadMedia: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/inbox/useMessageTemplates", () => ({
  useMessageTemplates: () => ({ data: [], isLoading: false }),
}));
vi.mock("@/hooks/inbox/useDraftReply", () => ({
  useDraftReply: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/mencoes/useMarcaveis", () => ({
  useMarcaveisDaConversa: () => ({ data: colegas }),
  useMarcaveisDoCanal: () => ({ data: colegas }),
}));

import { Composer } from "@/components/inbox/Composer";

const ANA = { user_id: "u-ana", nome: "Ana Souza", role: "agent" };
const CAIO = { user_id: "u-caio", nome: "Caio Lima", role: "manager" };

function abrirNota() {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <Composer conversationId="conv-1" />
    </QueryClientProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: /nota interna/i }));
  return screen.getByPlaceholderText(/nota interna/i) as HTMLTextAreaElement;
}

function digitar(campo: HTMLTextAreaElement, valor: string) {
  fireEvent.change(campo, { target: { value: valor } });
}

beforeEach(() => {
  // jsdom não implementa `scrollIntoView`; a lista o usa para manter a linha ativa à vista.
  Element.prototype.scrollIntoView = vi.fn();
  colegas = [ANA, CAIO];
  sendMock.mockClear();
  createNoteMock.mockClear();
});
afterEach(cleanup);

describe("a lista que abre ao digitar @", () => {
  it("abre com o @todos no topo e os colegas, com o papel de cada um", () => {
    const campo = abrirNota();
    digitar(campo, "@");
    const opcoes = screen.getAllByTestId("opcao-de-mencao");
    expect(opcoes.map((o) => o.getAttribute("data-nome"))).toEqual(["todos", "Ana Souza", "Caio Lima"]);
    expect(within(opcoes[1]!).getByText("Atendente")).toBeInTheDocument();
    expect(within(opcoes[2]!).getByText("Gerente")).toBeInTheDocument();
  });

  it("filtra pelo que vem depois do @ (começo de qualquer palavra do nome)", () => {
    const campo = abrirNota();
    digitar(campo, "oi @lim");
    expect(screen.getAllByTestId("opcao-de-mencao").map((o) => o.getAttribute("data-nome"))).toEqual(["Caio Lima"]);
  });

  it("NÃO abre no meio de um e-mail", () => {
    const campo = abrirNota();
    digitar(campo, "ana@empresa.com");
    expect(screen.queryByTestId("menu-de-mencao")).not.toBeInTheDocument();
  });

  it("NÃO abre quando ninguém casa — e o Enter envia a nota como sempre", () => {
    const campo = abrirNota();
    digitar(campo, "@zzz");
    expect(screen.queryByTestId("menu-de-mencao")).not.toBeInTheDocument();
    fireEvent.keyDown(campo, { key: "Enter" });
    expect(createNoteMock).toHaveBeenCalledTimes(1);
  });

  it("NÃO abre sem colegas para marcar (o @ é só um caractere)", () => {
    colegas = [];
    const campo = abrirNota();
    digitar(campo, "@");
    expect(screen.queryByTestId("menu-de-mencao")).not.toBeInTheDocument();
  });

  it("NÃO abre na RESPOSTA ao cliente: a mensagem sai do CRM e não marca ninguém da equipe", () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <Composer conversationId="conv-1" />
      </QueryClientProvider>,
    );
    const campo = screen.getByLabelText(/mensagem/i) as HTMLTextAreaElement;
    digitar(campo, "@");
    expect(screen.queryByTestId("menu-de-mencao")).not.toBeInTheDocument();
  });
});

describe("escolher alguém", () => {
  it("o Enter ESCOLHE (e não envia) quando a lista está aberta", () => {
    const campo = abrirNota();
    digitar(campo, "@an");
    fireEvent.keyDown(campo, { key: "Enter" });
    expect(campo.value).toBe("@Ana Souza ");
    expect(createNoteMock).not.toHaveBeenCalled();
    expect(screen.queryByTestId("menu-de-mencao")).not.toBeInTheDocument();
  });

  it("depois de escolher, o Enter seguinte ENVIA — a lista não reabre sobre o nome já escolhido", () => {
    const campo = abrirNota();
    digitar(campo, "@an");
    fireEvent.keyDown(campo, { key: "Enter" });
    fireEvent.keyDown(campo, { key: "Enter" });
    expect(createNoteMock).toHaveBeenCalledTimes(1);
  });

  it("as setas movem a escolha, e o Tab escolhe", () => {
    const campo = abrirNota();
    digitar(campo, "@");
    fireEvent.keyDown(campo, { key: "ArrowDown" }); // todos → Ana
    fireEvent.keyDown(campo, { key: "ArrowDown" }); // Ana → Caio
    expect(screen.getAllByTestId("opcao-de-mencao")[2]).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(campo, { key: "ArrowUp" }); // Caio → Ana
    fireEvent.keyDown(campo, { key: "Tab" });
    expect(campo.value).toBe("@Ana Souza ");
  });

  it("a seta para cima na primeira linha volta para a última", () => {
    const campo = abrirNota();
    digitar(campo, "@");
    fireEvent.keyDown(campo, { key: "ArrowUp" });
    expect(screen.getAllByTestId("opcao-de-mencao")[2]).toHaveAttribute("aria-selected", "true");
  });

  it("o Esc fecha a lista e deixa o texto como está; o Enter seguinte envia", () => {
    const campo = abrirNota();
    digitar(campo, "@an");
    fireEvent.keyDown(campo, { key: "Escape" });
    expect(screen.queryByTestId("menu-de-mencao")).not.toBeInTheDocument();
    expect(campo.value).toBe("@an");
    fireEvent.keyDown(campo, { key: "Enter" });
    expect(createNoteMock).toHaveBeenCalledTimes(1);
  });

  it("o clique numa linha escolhe, no meio de uma frase, sem apagar o resto", () => {
    const campo = abrirNota();
    digitar(campo, "oi @cai e depois");
    // O cursor fica logo depois de "@cai" — como quando se digita no meio do texto.
    campo.setSelectionRange(7, 7);
    fireEvent.select(campo);
    fireEvent.mouseDown(screen.getByText("Caio Lima"));
    expect(campo.value).toBe("oi @Caio Lima  e depois");
  });

  it("o mouse passando por cima muda a linha ativa", () => {
    const campo = abrirNota();
    digitar(campo, "@");
    fireEvent.mouseEnter(screen.getAllByTestId("opcao-de-mencao")[1]!);
    expect(screen.getAllByTestId("opcao-de-mencao")[1]).toHaveAttribute("aria-selected", "true");
  });
});

describe("o que vai para a API", () => {
  it("a nota sai com a marcação da pessoa escolhida", () => {
    const campo = abrirNota();
    digitar(campo, "@an");
    fireEvent.keyDown(campo, { key: "Enter" });
    digitar(campo, "@Ana Souza vê isso");
    fireEvent.click(screen.getByRole("button", { name: /^enviar$/i }));
    expect(createNoteMock).toHaveBeenCalledWith(
      {
        conversation_id: "conv-1",
        body: "@Ana Souza vê isso",
        mentions: [{ tipo: "pessoa", user_id: "u-ana", nome: "Ana Souza" }],
      },
      expect.anything(),
    );
  });

  it("o @todos vai como { tipo: 'todos' }", () => {
    const campo = abrirNota();
    digitar(campo, "@to");
    fireEvent.keyDown(campo, { key: "Enter" });
    digitar(campo, "@todos reunião às 15h");
    fireEvent.click(screen.getByRole("button", { name: /^enviar$/i }));
    expect(createNoteMock).toHaveBeenCalledWith(
      expect.objectContaining({ mentions: [{ tipo: "todos" }] }),
      expect.anything(),
    );
  });

  it("quem apagou o nome do texto NÃO marca ninguém", () => {
    const campo = abrirNota();
    digitar(campo, "@an");
    fireEvent.keyDown(campo, { key: "Enter" });
    digitar(campo, "mudei de ideia");
    fireEvent.click(screen.getByRole("button", { name: /^enviar$/i }));
    expect(createNoteMock).toHaveBeenCalledWith(
      expect.objectContaining({ body: "mudei de ideia", mentions: [] }),
      expect.anything(),
    );
  });

  it("nota sem @ sai sem marcação", () => {
    const campo = abrirNota();
    digitar(campo, "cliente ligou");
    fireEvent.click(screen.getByRole("button", { name: /^enviar$/i }));
    expect(createNoteMock).toHaveBeenCalledWith(
      expect.objectContaining({ mentions: [] }),
      expect.anything(),
    );
  });

  it("a marcação de UMA nota não vaza para a seguinte", () => {
    const campo = abrirNota();
    digitar(campo, "@an");
    fireEvent.keyDown(campo, { key: "Enter" });
    digitar(campo, "@Ana Souza oi");
    fireEvent.click(screen.getByRole("button", { name: /^enviar$/i }));
    createNoteMock.mockClear();

    // A segunda nota cita o mesmo nome À MÃO, sem escolher na lista: o estado do campo já foi limpo.
    digitar(campo, "@Ana Souza de novo");
    fireEvent.click(screen.getByRole("button", { name: /^enviar$/i }));
    expect(createNoteMock).toHaveBeenCalledWith(
      expect.objectContaining({ mentions: [] }),
      expect.anything(),
    );
  });

  it("se o envio falha, o texto volta COM as marcações", () => {
    const campo = abrirNota();
    digitar(campo, "@an");
    fireEvent.keyDown(campo, { key: "Enter" });
    digitar(campo, "@Ana Souza vê isso");
    fireEvent.click(screen.getByRole("button", { name: /^enviar$/i }));
    expect(campo.value).toBe("");

    // Simula a API recusando: o segundo argumento do mutate traz o `onError`.
    const opcoes = createNoteMock.mock.calls[0]![1] as { onError: () => void };
    act(() => opcoes.onError());
    expect((screen.getByPlaceholderText(/nota interna/i) as HTMLTextAreaElement).value).toBe("@Ana Souza vê isso");

    createNoteMock.mockClear();
    fireEvent.click(screen.getByRole("button", { name: /^enviar$/i }));
    expect(createNoteMock).toHaveBeenCalledWith(
      expect.objectContaining({ mentions: [{ tipo: "pessoa", user_id: "u-ana", nome: "Ana Souza" }] }),
      expect.anything(),
    );
  });
});
