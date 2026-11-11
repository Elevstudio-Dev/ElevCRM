import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AgendarFollowupDialog } from "@/components/inbox/FollowupAgendado";
import type { RetornoDoContato } from "@/hooks/followup/useRetornosDoContato";

/**
 * O DIÁLOGO "AGENDAR FOLLOW-UP".
 *
 * Protege: sem dia e sem instrução o botão não habilita; o servidor recebe um INSTANTE ABSOLUTO (ISO) feito do dia e
 * da hora escolhidos; e quando o cliente já tem um retorno marcado o formulário NÃO aparece (o servidor recusaria) —
 * aparece o que está marcado e a opção de desmarcar.
 */
const estado = vi.hoisted(() => ({
  retornos: [] as RetornoDoContato[],
  agendar: vi.fn(),
  desmarcar: vi.fn(),
}));

vi.mock("@/hooks/followup/useRetornosDoContato", async () => {
  const real = await vi.importActual<typeof import("@/hooks/followup/useRetornosDoContato")>(
    "@/hooks/followup/useRetornosDoContato",
  );
  return {
    ...real,
    useRetornosDoContato: () => ({ data: estado.retornos, isLoading: false }),
    useAgendarRetorno: () => ({ mutate: estado.agendar, isPending: false }),
    useDesmarcarRetorno: () => ({ mutate: estado.desmarcar, isPending: false }),
  };
});

const vivo = (over: Partial<RetornoDoContato> = {}): RetornoDoContato => ({
  id: "ret-1",
  quando: "2099-01-10T12:00:00.000Z",
  situacao: "agendado",
  instrucao: "perguntar se decidiu pelo clareamento",
  motivo: "perguntar se decidiu pelo clareamento",
  promessa: null,
  ...over,
});

function abrir() {
  return render(<AgendarFollowupDialog contactId="c-1" nomeDoContato="Maria" open onOpenChange={() => {}} />);
}

beforeEach(() => {
  estado.retornos = [];
  estado.agendar.mockReset();
  estado.desmarcar.mockReset();
});

describe("AgendarFollowupDialog", () => {
  it("o botão só habilita com dia e instrução", () => {
    abrir();
    const botao = screen.getByTestId("agendar-followup-confirmar") as HTMLButtonElement;
    expect(botao.disabled).toBe(true);

    fireEvent.change(screen.getByLabelText("Dia e hora"), { target: { value: "2099-03-05" } });
    expect(botao.disabled).toBe(true);

    fireEvent.change(screen.getByLabelText("O que a IA deve fazer"), { target: { value: "ligar para confirmar" } });
    expect(botao.disabled).toBe(false);
  });

  it("manda o instante absoluto do dia e da hora escolhidos, com a instrução aparada", () => {
    abrir();
    fireEvent.change(screen.getByLabelText("Dia e hora"), { target: { value: "2099-03-05" } });
    fireEvent.change(screen.getByLabelText("Hora"), { target: { value: "14:30" } });
    fireEvent.change(screen.getByLabelText("O que a IA deve fazer"), { target: { value: "  ligar para confirmar  " } });
    fireEvent.click(screen.getByTestId("agendar-followup-confirmar"));

    expect(estado.agendar).toHaveBeenCalledTimes(1);
    const [args] = estado.agendar.mock.calls[0]!;
    expect(args.instrucao).toBe("ligar para confirmar");
    expect(args.quando).toBe(new Date(2099, 2, 5, 14, 30).toISOString());
  });

  it("dia e hora que já passaram: avisa e não deixa agendar", () => {
    abrir();
    fireEvent.change(screen.getByLabelText("Dia e hora"), { target: { value: "2020-01-01" } });
    fireEvent.change(screen.getByLabelText("O que a IA deve fazer"), { target: { value: "x" } });
    expect(screen.getByText("Escolha um dia e uma hora que ainda não passaram.")).toBeTruthy();
    expect((screen.getByTestId("agendar-followup-confirmar") as HTMLButtonElement).disabled).toBe(true);
  });

  it("os atalhos preenchem o dia", () => {
    abrir();
    fireEvent.click(screen.getByRole("button", { name: "Em 1 semana" }));
    expect((screen.getByLabelText("Dia e hora") as HTMLInputElement).value).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("cliente que já tem retorno marcado: mostra o que está marcado e oferece desmarcar, sem formulário", () => {
    estado.retornos = [vivo()];
    abrir();
    expect(screen.getByTestId("followup-ja-marcado")).toBeTruthy();
    expect(screen.getByText("perguntar se decidiu pelo clareamento")).toBeTruthy();
    expect(screen.queryByTestId("agendar-followup-confirmar")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Desmarcar" }));
    expect(estado.desmarcar).toHaveBeenCalledWith("ret-1");
  });

  it("retorno já disparado ou cancelado não bloqueia um novo", () => {
    estado.retornos = [vivo({ situacao: "disparado" }), vivo({ id: "ret-2", situacao: "cancelado" })];
    abrir();
    expect(screen.queryByTestId("followup-ja-marcado")).toBeNull();
    expect(screen.getByTestId("agendar-followup-confirmar")).toBeTruthy();
  });
});
