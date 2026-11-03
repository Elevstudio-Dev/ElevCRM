import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MenuDeMencao } from "@/components/mencoes/MenuDeMencao";
import { TextoComMencoes } from "@/components/mencoes/TextoComMencoes";

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (chave: string) => chave }));

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(cleanup);

const itens = [
  { id: "todos", nome: "todos", todos: true },
  { id: "u1", nome: "Ana Souza", detalhe: "Atendente" },
];

describe("MenuDeMencao", () => {
  it("fechado, não desenha nada", () => {
    render(
      <MenuDeMencao aberto={false} itens={itens} ativo={0} onEscolher={vi.fn()} onHover={vi.fn()} detalheDeTodos="x" />,
    );
    expect(screen.queryByTestId("menu-de-mencao")).not.toBeInTheDocument();
  });

  it("é um listbox com uma opção por linha; a ativa vem marcada", () => {
    render(
      <MenuDeMencao aberto itens={itens} ativo={1} onEscolher={vi.fn()} onHover={vi.fn()} detalheDeTodos="Avisa o canal" />,
    );
    expect(screen.getByRole("listbox", { name: "Marcar alguém" })).toBeInTheDocument();
    const opcoes = screen.getAllByRole("option");
    expect(opcoes).toHaveLength(2);
    expect(opcoes[0]).toHaveAttribute("aria-selected", "false");
    expect(opcoes[1]).toHaveAttribute("aria-selected", "true");
  });

  it("a linha do @todos mostra @todos e o texto do lugar; a da pessoa, o detalhe", () => {
    render(
      <MenuDeMencao aberto itens={itens} ativo={0} onEscolher={vi.fn()} onHover={vi.fn()} detalheDeTodos="Avisa o canal" />,
    );
    expect(screen.getByText("@todos")).toBeInTheDocument();
    expect(screen.getByText("Avisa o canal")).toBeInTheDocument();
    expect(screen.getByText("Atendente")).toBeInTheDocument();
    expect(screen.getByText("AS")).toBeInTheDocument(); // iniciais
  });

  it("o clique escolhe SEM tirar o foco do campo (mouseDown com preventDefault)", () => {
    const onEscolher = vi.fn();
    render(
      <MenuDeMencao aberto itens={itens} ativo={0} onEscolher={onEscolher} onHover={vi.fn()} detalheDeTodos="x" />,
    );
    const linha = screen.getAllByRole("option")[1]!;
    const notPrevented = fireEvent.mouseDown(linha); // devolve false quando o preventDefault foi chamado
    expect(notPrevented).toBe(false);
    expect(onEscolher).toHaveBeenCalledWith(itens[1]);
  });
});

describe("TextoComMencoes", () => {
  const ana = { tipo: "pessoa" as const, user_id: "u-ana", nome: "Ana Souza" };

  it("sem marcação, só o texto — com quebra de linha preservada", () => {
    const { container } = render(<TextoComMencoes texto={"linha 1\nlinha 2"} mencoes={[]} />);
    expect(container.textContent).toBe("linha 1\nlinha 2");
    expect(container.firstElementChild!.className).toContain("whitespace-pre-wrap");
    expect(screen.queryByTestId("mencao")).not.toBeInTheDocument();
  });

  it("`mencoes` nulo ou ausente (mensagem antiga) também vira texto puro", () => {
    const { container } = render(<TextoComMencoes texto="oi @Ana Souza" mencoes={null} />);
    expect(container.textContent).toBe("oi @Ana Souza");
    expect(screen.queryByTestId("mencao")).not.toBeInTheDocument();
  });

  it("destaca só o nome marcado e mantém o resto do texto intacto", () => {
    const { container } = render(<TextoComMencoes texto="oi @Ana Souza, tudo bem?" mencoes={[ana]} />);
    expect(container.textContent).toBe("oi @Ana Souza, tudo bem?");
    expect(screen.getByTestId("mencao")).toHaveTextContent("@Ana Souza");
  });

  it("`data-comigo` só quando EU sou o marcado (ou é @todos)", () => {
    const { rerender } = render(<TextoComMencoes texto="@Ana Souza" mencoes={[ana]} euId="u-outro" />);
    expect(screen.getByTestId("mencao")).not.toHaveAttribute("data-comigo");
    rerender(<TextoComMencoes texto="@Ana Souza" mencoes={[ana]} euId="u-ana" />);
    expect(screen.getByTestId("mencao")).toHaveAttribute("data-comigo", "true");
    rerender(<TextoComMencoes texto="@todos" mencoes={[{ tipo: "todos" }]} euId="u-outro" />);
    expect(screen.getByTestId("mencao")).toHaveAttribute("data-comigo", "true");
  });

  it("o nome que o texto NÃO tem mais não ganha destaque", () => {
    render(<TextoComMencoes texto="oi Ana" mencoes={[ana]} />);
    expect(screen.queryByTestId("mencao")).not.toBeInTheDocument();
  });
});
