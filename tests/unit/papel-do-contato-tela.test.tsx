import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * O PAPEL DO CONTATO NA TELA: o diálogo e o selo.
 *
 * O que se protege: o diálogo explica a consequência ANTES de a pessoa escolher (a IA de vendas deixa de falar com
 * ela); "Salvar" só liga quando algo mudou; o payload vai certo ("nenhum papel" = null); erro do servidor deixa o
 * diálogo aberto; e o selo só ocupa lugar em quem tem papel.
 */
const put = vi.fn();
vi.mock("@/lib/api/client", () => ({
  apiClient: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: (...a: unknown[]) => put(...a) },
}));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

import { PapelDoContatoDialog } from "@/components/contacts/PapelDoContatoDialog";
import { SeloDePapel } from "@/components/contacts/SeloDePapel";

const CONTATO = "6f0d1c1e-3b7a-4c58-9d1e-2a4b5c6d7e8f";

function renderizar(ui: React.ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

function dialogo(papelAtual: string | null, onOpenChange = vi.fn()) {
  renderizar(
    <PapelDoContatoDialog contactId={CONTATO} nome="Ana da Recepção" papelAtual={papelAtual} open onOpenChange={onOpenChange} />,
  );
  return onOpenChange;
}

beforeEach(() => {
  put.mockReset();
  toast.success.mockClear();
  put.mockResolvedValue({ data: { papel: "secretaria", alterado: true, fora_do_funil: true } });
});
afterEach(cleanup);

describe("SeloDePapel", () => {
  it("mostra o nome do papel", () => {
    renderizar(<SeloDePapel papel="secretaria" />);
    expect(screen.getByTestId("selo-de-papel").textContent).toBe("Secretaria");
    cleanup();
    renderizar(<SeloDePapel papel="marketing" />);
    expect(screen.getByTestId("selo-de-papel").textContent).toBe("Marketing");
  });

  it("não ocupa lugar sem papel, nem com valor desconhecido", () => {
    for (const papel of [null, undefined, "", "dono"]) {
      const { container } = renderizar(<SeloDePapel papel={papel} />);
      expect(container.textContent).toBe("");
      cleanup();
    }
  });
});

describe("PapelDoContatoDialog", () => {
  it("diz a consequência antes de escolher: fora do funil e a IA de vendas não escreve", () => {
    dialogo(null);
    expect(screen.getByText(/fica fora do funil/i)).toBeTruthy();
    expect(screen.getByText(/IA de vendas nunca escreve/i)).toBeTruthy();
    expect(screen.getByText("Ana da Recepção")).toBeTruthy();
  });

  it("começa no papel atual e o Salvar fica desligado até algo mudar", () => {
    dialogo("secretaria");
    expect((screen.getByTestId("papel-secretaria") as HTMLInputElement).checked).toBe(true);
    expect((screen.getByTestId("salvar-papel") as HTMLButtonElement).disabled).toBe(true);
  });

  it("sem papel: 'Nenhum papel' vem marcado", () => {
    dialogo(null);
    expect((screen.getByTestId("papel-nenhum") as HTMLInputElement).checked).toBe(true);
  });

  it("escolher Secretaria e salvar manda o papel certo, avisa e fecha", async () => {
    const onOpenChange = dialogo(null);
    await userEvent.click(screen.getByTestId("papel-secretaria"));
    await userEvent.click(screen.getByTestId("salvar-papel"));
    await waitFor(() => expect(put).toHaveBeenCalledTimes(1));
    expect(put).toHaveBeenCalledWith(`/api/v1/contacts/${CONTATO}/papel-interno`, { papel: "secretaria" });
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Papel atualizado."));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("escolher Marketing manda 'marketing'", async () => {
    dialogo(null);
    await userEvent.click(screen.getByTestId("papel-marketing"));
    await userEvent.click(screen.getByTestId("salvar-papel"));
    await waitFor(() => expect(put).toHaveBeenCalledWith(expect.any(String), { papel: "marketing" }));
  });

  it("'Nenhum papel' manda null e avisa que o papel foi removido", async () => {
    dialogo("marketing");
    await userEvent.click(screen.getByTestId("papel-nenhum"));
    await userEvent.click(screen.getByTestId("salvar-papel"));
    await waitFor(() => expect(put).toHaveBeenCalledWith(expect.any(String), { papel: null }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Papel removido."));
  });

  it("erro do servidor: o diálogo continua aberto e nada de 'sucesso'", async () => {
    put.mockRejectedValue(new Error("falhou"));
    const onOpenChange = dialogo(null);
    await userEvent.click(screen.getByTestId("papel-secretaria"));
    await userEvent.click(screen.getByTestId("salvar-papel"));
    await waitFor(() => expect(put).toHaveBeenCalled());
    expect(toast.success).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  it("Cancelar fecha sem chamar o servidor", async () => {
    const onOpenChange = dialogo("secretaria");
    await userEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(put).not.toHaveBeenCalled();
  });
});
