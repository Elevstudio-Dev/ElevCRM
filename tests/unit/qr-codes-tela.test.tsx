import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A TELA DE QR CODES.
 *
 * O que se protege: o gestor vê o link por extenso (para conferir), o funil com a taxa entre as etapas, os dois
 * avisos que dizem quando o QR não está funcionando, e que criar/arquivar/copiar fazem o que dizem. O desenho do
 * QR em si (a lib `qrcode`) é simulado: aqui não se mede se a câmera lê — isso é a prova no celular, declarada
 * como NÃO provada no PR.
 */
const get = vi.fn();
const post = vi.fn();
const patch = vi.fn();
vi.mock("@/lib/api/client", () => ({
  apiClient: {
    get: (...a: unknown[]) => get(...a),
    post: (...a: unknown[]) => post(...a),
    patch: (...a: unknown[]) => patch(...a),
  },
}));
vi.mock("qrcode", () => ({
  default: {
    toString: vi.fn(async () => "<svg></svg>"),
    toDataURL: vi.fn(async () => "data:image/png;base64,AA"),
  },
}));
// `vi.mock` sobe para o topo do arquivo: o que a fábrica usa tem de nascer junto, por `vi.hoisted`.
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

import { QrCodesClient } from "@/app/app/relatorios/qr-codes/_components/QrCodesClient";

const CANAL = { id: "c-1", nome: "Recepção", telefone: "+5511987654321", conectado: true };
const QR = {
  id: "qr-1",
  codigo: "R7K2QH",
  nome: "Cartaz da recepção",
  mensagem: "Olá! Vi o cartaz",
  channel_session_id: "c-1",
  arquivado_em: null,
  created_at: "2026-10-28T12:00:00Z",
  updated_at: "2026-10-28T12:00:00Z",
};
const FUNIL = (over: Record<string, number> = {}) => ({
  qr_code_id: "qr-1",
  leituras: 120,
  conversas: 30,
  leads: 22,
  ganhos: 5,
  valor_ganho_cents: 0,
  ...over,
});

let qrs: unknown[];
let canais: unknown[];
let funil: unknown[];

function renderizar() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <QrCodesClient />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  qrs = [QR];
  canais = [CANAL];
  funil = [FUNIL()];
  get.mockReset();
  post.mockReset();
  patch.mockReset();
  toast.success.mockClear();
  toast.error.mockClear();
  get.mockImplementation(async (url: string) =>
    url.startsWith("/api/v1/relatorios/qr-codes")
      ? { data: { funil } }
      : { data: { qr_codes: qrs, canais } },
  );
  post.mockResolvedValue({ data: QR });
  patch.mockResolvedValue({ data: QR });
});
afterEach(cleanup);

describe("a lista de QR codes", () => {
  it("mostra o nome, o link por extenso e a mensagem final com o código", async () => {
    renderizar();
    expect(await screen.findByText("Cartaz da recepção")).toBeTruthy();
    expect(screen.getByText(`${window.location.origin}/q/R7K2QH`)).toBeTruthy();
    expect(screen.getByText("Olá! Vi o cartaz #R7K2QH")).toBeTruthy();
    expect(screen.getByText(/Recepção · \+5511987654321/)).toBeTruthy();
  });

  it("mostra o funil com a taxa entre cada etapa", async () => {
    renderizar();
    await screen.findByText("Cartaz da recepção");
    await waitFor(() => expect(screen.getByTestId("funil-leituras").textContent).toContain("120"));
    expect(screen.getByTestId("funil-conversas").textContent).toContain("25%"); // 30 de 120
    expect(screen.getByTestId("funil-leads").textContent).toContain("73%"); // 22 de 30
    expect(screen.getByTestId("funil-vendas").textContent).toContain("23%"); // 5 de 22
  });

  it("taxa de etapa cujo anterior é zero é '—', nunca '0%' nem NaN", async () => {
    funil = [FUNIL({ leituras: 0, conversas: 0, leads: 0, ganhos: 0 })];
    renderizar();
    await screen.findByText("Cartaz da recepção");
    expect(screen.getByTestId("funil-conversas").textContent).toContain("—");
    expect(screen.getByTestId("funil-conversas").textContent).not.toContain("NaN");
  });

  it("10 leituras e nenhuma conversa: avisa que o código pode estar sendo apagado", async () => {
    funil = [FUNIL({ leituras: 10, conversas: 0, leads: 0, ganhos: 0 })];
    renderizar();
    const aviso = await screen.findByTestId("aviso-leituras_sem_conversa");
    expect(aviso.textContent).toContain("nenhuma conversa");
  });

  it("9 leituras e nenhuma conversa: ainda é cedo, sem aviso", async () => {
    funil = [FUNIL({ leituras: 9, conversas: 0, leads: 0, ganhos: 0 })];
    renderizar();
    await screen.findByText("Cartaz da recepção");
    await waitFor(() => expect(screen.getByTestId("funil-leituras").textContent).toContain("9"));
    expect(screen.queryByTestId("aviso-leituras_sem_conversa")).toBeNull();
  });

  it("sem nenhum número que sirva: avisa que quem ler verá uma página de aviso", async () => {
    canais = [];
    renderizar();
    const aviso = await screen.findByTestId("aviso-sem_numero");
    expect(aviso.textContent).toContain("página de aviso");
  });

  it("QR arquivado vai para 'Arquivados', com selo, e oferece Reativar em vez de Arquivar", async () => {
    qrs = [{ ...QR, arquivado_em: "2026-10-20T00:00:00Z" }];
    renderizar();
    expect(await screen.findByText("Arquivados")).toBeTruthy();
    const cartao = screen.getByTestId("cartao-do-qr");
    expect(within(cartao).getByText("Arquivado")).toBeTruthy();
    expect(within(cartao).getByRole("button", { name: /Reativar/ })).toBeTruthy();
    expect(within(cartao).queryByRole("button", { name: /^Arquivar/ })).toBeNull();
    expect(screen.queryByTestId("aviso-leituras_sem_conversa")).toBeNull(); // arquivado não cobra
  });

  it("sem nenhum QR: explica o que acontece em três passos e oferece criar", async () => {
    qrs = [];
    renderizar();
    expect(await screen.findByText("Nenhum QR code ainda")).toBeTruthy();
    expect(screen.getByText("Crie o QR e imprima.")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: /Novo QR code/ }).length).toBeGreaterThan(0);
  });
});

describe("criar, arquivar e copiar", () => {
  it("criar envia nome, mensagem e número, e fecha o diálogo", async () => {
    const user = userEvent.setup();
    renderizar();
    await screen.findByText("Cartaz da recepção");

    await user.click(screen.getByRole("button", { name: /Novo QR code/ }));
    const dialogo = await screen.findByRole("dialog");
    await user.type(within(dialogo).getByLabelText("Nome"), "  Panfleto do metrô ");
    // a prévia mostra a frase + um código ainda por criar
    expect(within(dialogo).getByTestId("previa-da-mensagem").textContent).toContain("Olá! Gostaria de saber mais. #······");
    await user.click(within(dialogo).getByRole("button", { name: "Criar QR code" }));

    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(post).toHaveBeenCalledWith("/api/v1/qr-codes", {
      nome: "  Panfleto do metrô ",
      mensagem: "Olá! Gostaria de saber mais.",
      channel_session_id: "c-1",
    });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(toast.success).toHaveBeenCalledWith("QR code criado");
  });

  it("sem nome o botão de criar fica desabilitado", async () => {
    const user = userEvent.setup();
    renderizar();
    await screen.findByText("Cartaz da recepção");
    await user.click(screen.getByRole("button", { name: /Novo QR code/ }));
    const dialogo = await screen.findByRole("dialog");
    expect((within(dialogo).getByRole("button", { name: "Criar QR code" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("sem número de WhatsApp com telefone: o diálogo manda conectar, e salvar fica desabilitado", async () => {
    canais = [{ id: "c-2", nome: "Sem telefone", telefone: null, conectado: false }];
    const user = userEvent.setup();
    renderizar();
    await screen.findByText("Cartaz da recepção");
    await user.click(screen.getByRole("button", { name: /Novo QR code/ }));
    const dialogo = await screen.findByRole("dialog");
    expect(within(dialogo).getByText(/Conecte um número de WhatsApp/)).toBeTruthy();
    expect(within(dialogo).getByRole("link", { name: "Ir para Conexões" }).getAttribute("href")).toBe("/app/connections");
    await user.type(within(dialogo).getByLabelText("Nome"), "Qualquer");
    expect((within(dialogo).getByRole("button", { name: "Criar QR code" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("editar mostra o código que NÃO muda e envia só o PATCH do QR certo", async () => {
    const user = userEvent.setup();
    renderizar();
    await screen.findByText("Cartaz da recepção");
    await user.click(screen.getByRole("button", { name: /Editar/ }));
    const dialogo = await screen.findByRole("dialog");
    expect(within(dialogo).getByTestId("previa-da-mensagem").textContent).toContain("#R7K2QH");
    expect(within(dialogo).getByText(/O código não muda/)).toBeTruthy();
    const nome = within(dialogo).getByLabelText("Nome");
    await user.clear(nome);
    await user.type(nome, "Cartaz novo");
    await user.click(within(dialogo).getByRole("button", { name: "Salvar" }));

    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
    expect(patch.mock.calls[0]![0]).toBe("/api/v1/qr-codes/qr-1");
    expect(patch.mock.calls[0]![1]).toMatchObject({ nome: "Cartaz novo" });
    expect(patch.mock.calls[0]![1]).not.toHaveProperty("codigo");
  });

  it("arquivar PEDE confirmação, e só depois dela envia { arquivado: true }", async () => {
    const user = userEvent.setup();
    renderizar();
    await screen.findByText("Cartaz da recepção");

    await user.click(within(screen.getByTestId("cartao-do-qr")).getByRole("button", { name: /Arquivar/ }));
    const confirmacao = await screen.findByRole("alertdialog");
    expect(within(confirmacao).getByText(/não está mais ativo/)).toBeTruthy();
    expect(patch).not.toHaveBeenCalled(); // abrir a confirmação não arquiva

    await user.click(within(confirmacao).getByRole("button", { name: "Arquivar" }));

    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
    expect(patch).toHaveBeenCalledWith("/api/v1/qr-codes/qr-1", { arquivado: true });
  });

  it("cancelar a confirmação não arquiva nada", async () => {
    const user = userEvent.setup();
    renderizar();
    await screen.findByText("Cartaz da recepção");
    await user.click(within(screen.getByTestId("cartao-do-qr")).getByRole("button", { name: /Arquivar/ }));
    const confirmacao = await screen.findByRole("alertdialog");
    await user.click(within(confirmacao).getByRole("button", { name: "Cancelar" }));
    expect(patch).not.toHaveBeenCalled();
  });

  it("copiar link grava o link completo na área de transferência", async () => {
    const user = userEvent.setup();
    const escrever = vi.spyOn(navigator.clipboard, "writeText");
    renderizar();
    await screen.findByText("Cartaz da recepção");
    await user.click(screen.getByRole("button", { name: /Copiar link/ }));
    await waitFor(() => expect(escrever).toHaveBeenCalledWith(`${window.location.origin}/q/R7K2QH`));
    expect(toast.success).toHaveBeenCalledWith("Link copiado");
  });
});
