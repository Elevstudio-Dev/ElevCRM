import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PreviaDoMarcador } from "@/lib/schemas/fora-do-funil";

/**
 * "FORA DO FUNIL" NA TELA: o diálogo, o selo e a tabela de contatos.
 *
 * O que se protege: o dono vê, ANTES de confirmar, o que sai (e é avisado quando sai uma venda ganha); o payload
 * que vai ao servidor é o certo (tipo ou nenhum; desmarcar não carrega tipo); só gestor cria tipo na hora; e o
 * selo só ocupa lugar em quem está marcado.
 */
const get = vi.fn();
const post = vi.fn();
vi.mock("@/lib/api/client", () => ({ apiClient: { get: (...a: unknown[]) => get(...a), post: (...a: unknown[]) => post(...a), patch: vi.fn() } }));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast }));
const auth = vi.hoisted(() => ({ role: "agent" as "agent" | "manager", platform: false }));
vi.mock("@/hooks/auth/AuthProvider", () => ({
  useAuth: () => ({
    user: { is_platform_admin: auth.platform, id: "u-1" },
    activeOrg: { orgId: "org-1", name: "Org", role: auth.role },
  }),
}));

import { ForaDoFunilDialog, resumoDaPrevia } from "@/components/contacts/ForaDoFunilDialog";
import { SeloForaDoFunil } from "@/components/contacts/SeloForaDoFunil";

const A = "6f0d1c1e-3b7a-4c58-9d1e-2a4b5c6d7e8f";
const TIPOS = [
  { id: "t-equipe", nome: "Equipe", arquivado_em: null, created_at: "2026-10-29T00:00:00Z" },
  { id: "t-contador", nome: "Contador", arquivado_em: null, created_at: "2026-10-29T00:00:00Z" },
];
const PREVIA = (over: Partial<PreviaDoMarcador["negocios"]> = {}, aproximado = false): PreviaDoMarcador => ({
  contatos: 1,
  negocios: { abertos: 2, ganhos: 0, perdidos: 0, valor_ganho_cents: 0, ...over },
  aproximado,
});

let previaDoServidor: PreviaDoMarcador | Error;
let tiposDoServidor: typeof TIPOS;

function renderizar(ui: React.ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

beforeEach(() => {
  auth.role = "agent";
  auth.platform = false;
  previaDoServidor = PREVIA();
  tiposDoServidor = [...TIPOS];
  get.mockReset();
  post.mockReset();
  toast.success.mockClear();
  get.mockImplementation(async (url: string) => {
    if (url.startsWith("/api/v1/tipos-fora-do-funil")) return { data: tiposDoServidor };
    return { data: [] };
  });
  post.mockImplementation(async (url: string, corpo: Record<string, unknown>) => {
    if (url.endsWith("/previa")) {
      if (previaDoServidor instanceof Error) throw previaDoServidor;
      return { data: previaDoServidor };
    }
    if (url === "/api/v1/tipos-fora-do-funil") {
      const novo = { id: "t-novo", nome: String(corpo.nome), arquivado_em: null, created_at: "x" };
      tiposDoServidor = [...tiposDoServidor, novo]; // o servidor passa a listá-lo, como o real
      return { data: novo };
    }
    return { data: { alterados: 1, previa: PREVIA() } };
  });
});
afterEach(cleanup);

const T = (s: string) => s;

describe("resumoDaPrevia — a frase que o dono lê antes de confirmar", () => {
  it("lista abertos, vendas (com o valor) e perdidos, no singular e no plural", () => {
    const r = resumoDaPrevia(PREVIA({ abertos: 1, ganhos: 2, valor_ganho_cents: 150000, perdidos: 3 }), true, T);
    expect(r.frase).toBe("Saem do funil e do relatório: 1 negócio aberto, 2 vendas ganhas (R$ 1.500,00), 3 negócios perdidos.");
    expect(r.temVenda).toBe(true);
  });
  it("sem negócio: diz que nada muda, e não finge um zero", () => {
    expect(resumoDaPrevia(PREVIA({ abertos: 0 }), true, T)).toEqual({ frase: "Nenhum negócio será afetado.", temVenda: false });
    expect(resumoDaPrevia(PREVIA({ abertos: 0 }), false, T).frase).toBe("Não há negócio escondido para devolver.");
  });
  it("ao desmarcar a frase é a da VOLTA", () => {
    expect(resumoDaPrevia(PREVIA(), false, T).frase).toMatch(/^Voltam ao funil e ao relatório: 2 negócios abertos\.$/);
  });
  it("mais de mil negócios: a contagem é declarada como piso", () => {
    expect(resumoDaPrevia(PREVIA({ abertos: 1000 }, true), true, T).frase).toContain("mais de 1000 negócios abertos");
  });
});

describe("ForaDoFunilDialog — marcar", () => {
  const abrir = (extra: Partial<React.ComponentProps<typeof ForaDoFunilDialog>> = {}) => {
    const onOpenChange = vi.fn();
    renderizar(
      <ForaDoFunilDialog
        contatos={[{ id: A, nome: "Marcela do Financeiro" }]}
        marcar
        open
        onOpenChange={onOpenChange}
        {...extra}
      />,
    );
    return { onOpenChange };
  };

  it("diz o que muda e mostra, antes de confirmar, quantos negócios saem", async () => {
    abrir();
    const dialogo = await screen.findByTestId("dialogo-fora-do-funil");
    expect(within(dialogo).getByText("Marcela do Financeiro")).toBeTruthy();
    expect(within(dialogo).getByText(/A IA para de atender/)).toBeTruthy();
    expect(within(dialogo).getByText(/Nenhum negócio novo é criado/)).toBeTruthy();
    expect(await within(dialogo).findByText(/Saem do funil e do relatório: 2 negócios abertos\./)).toBeTruthy();
    expect(within(dialogo).queryByTestId("aviso-venda-ganha")).toBeNull();
  });

  it("venda ganha acende um AVISO — sair do relatório é o que o dono não esperaria", async () => {
    previaDoServidor = PREVIA({ ganhos: 1, valor_ganho_cents: 150000 });
    abrir();
    const aviso = await screen.findByTestId("aviso-venda-ganha");
    expect(aviso.getAttribute("role")).toBe("alert");
    expect(aviso.textContent).toMatch(/a venda ganha também sai do relatório/);
  });

  it("confirma com o tipo escolhido, na organização certa, e avisa que deu certo", async () => {
    const user = userEvent.setup();
    const { onOpenChange } = abrir();
    await screen.findByText(/Saem do funil/);
    await user.selectOptions(screen.getByLabelText("Tipo (opcional)"), "t-contador");
    await user.click(screen.getByTestId("confirmar-fora-do-funil"));

    await waitFor(() =>
      expect(post).toHaveBeenCalledWith("/api/v1/contacts/fora-do-funil", { contact_ids: [A], marcar: true, tipo_id: "t-contador" }),
    );
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Contato marcado como fora do funil."));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("sem tipo escolhido, manda tipo_id nulo — e não 'undefined', que deixaria o tipo antigo", async () => {
    const user = userEvent.setup();
    abrir();
    await screen.findByText(/Saem do funil/);
    await user.click(screen.getByTestId("confirmar-fora-do-funil"));
    await waitFor(() => expect(post).toHaveBeenCalledWith("/api/v1/contacts/fora-do-funil", { contact_ids: [A], marcar: true, tipo_id: null }));
  });

  it("contato que já tinha tipo abre com ele escolhido", async () => {
    abrir({ contatos: [{ id: A, nome: "Marcela", tipoId: "t-equipe" }] });
    await waitFor(() => expect((screen.getByLabelText("Tipo (opcional)") as HTMLSelectElement).value).toBe("t-equipe"));
  });

  it("vários contatos: o título fala em quantos, e todos os ids vão no pedido", async () => {
    const user = userEvent.setup();
    abrir({ contatos: [{ id: A, nome: "A" }, { id: "b2b2b2b2-3b7a-4c58-9d1e-2a4b5c6d7e8f", nome: "B" }] });
    expect(await screen.findByText("2 contatos")).toBeTruthy();
    await screen.findByText(/Saem do funil/);
    await user.click(screen.getByTestId("confirmar-fora-do-funil"));
    await waitFor(() => expect(post.mock.calls.at(-1)![1]).toMatchObject({ contact_ids: [A, "b2b2b2b2-3b7a-4c58-9d1e-2a4b5c6d7e8f"] }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Contato marcado como fora do funil."));
  });

  it("a prévia falhou: diz isso, e confirmar continua possível", async () => {
    previaDoServidor = new Error("fora do ar");
    abrir();
    expect(await screen.findByText(/Não foi possível conferir o que muda/)).toBeTruthy();
    expect((screen.getByTestId("confirmar-fora-do-funil") as HTMLButtonElement).disabled).toBe(false);
  });

  it("atendente escolhe entre os tipos que o dono cadastrou, mas NÃO cria tipo", async () => {
    abrir();
    await screen.findByText(/Saem do funil/);
    expect(screen.queryByLabelText("Novo tipo")).toBeNull();
    expect(screen.queryByRole("button", { name: "Criar tipo" })).toBeNull();
  });

  it("gestor cria um tipo na hora, e ele já fica escolhido", async () => {
    auth.role = "manager";
    const user = userEvent.setup();
    abrir();
    await screen.findByText(/Saem do funil/);
    await user.type(screen.getByLabelText("Novo tipo"), "Dentista parceiro");
    await user.click(screen.getByRole("button", { name: "Criar tipo" }));
    await waitFor(() => expect(post).toHaveBeenCalledWith("/api/v1/tipos-fora-do-funil", { nome: "Dentista parceiro" }));
    await waitFor(() => expect((screen.getByLabelText("Tipo (opcional)") as HTMLSelectElement).value).toBe("t-novo"));
  });
});

describe("ForaDoFunilDialog — voltar ao funil", () => {
  it("não pergunta tipo, diz o que volta, e o pedido NÃO carrega tipo_id", async () => {
    const user = userEvent.setup();
    renderizar(
      <ForaDoFunilDialog contatos={[{ id: A, nome: "Marcela" }]} marcar={false} open onOpenChange={vi.fn()} />,
    );
    const dialogo = await screen.findByTestId("dialogo-fora-do-funil");
    expect(within(dialogo).getByRole("heading", { name: "Voltar ao funil" })).toBeTruthy();
    expect(within(dialogo).getByText(/A IA volta a poder atender/)).toBeTruthy();
    expect(screen.queryByLabelText("Tipo (opcional)")).toBeNull();
    expect(await within(dialogo).findByText(/Voltam ao funil e ao relatório: 2 negócios abertos/)).toBeTruthy();
    expect(within(dialogo).queryByTestId("aviso-venda-ganha")).toBeNull(); // o aviso é só de quem SAI

    await user.click(screen.getByTestId("confirmar-fora-do-funil"));
    await waitFor(() => expect(post).toHaveBeenCalledWith("/api/v1/contacts/fora-do-funil", { contact_ids: [A], marcar: false }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Contato voltou ao funil."));
  });
});

describe("SeloForaDoFunil", () => {
  it("quem é do funil não ganha selo nenhum", () => {
    const { container } = renderizar(<SeloForaDoFunil foraDoFunilEm={null} tipoId={null} />);
    expect(container.textContent).toBe("");
    expect(get).not.toHaveBeenCalled(); // nem pergunta a lista de tipos
  });

  it("marcado sem tipo: só 'Fora do funil'", () => {
    renderizar(<SeloForaDoFunil foraDoFunilEm="2026-10-29T12:00:00Z" tipoId={null} />);
    expect(screen.getByTestId("selo-fora-do-funil").textContent).toBe("Fora do funil");
  });

  it("marcado com tipo: 'Fora do funil · Equipe'", async () => {
    renderizar(<SeloForaDoFunil foraDoFunilEm="2026-10-29T12:00:00Z" tipoId="t-equipe" />);
    await waitFor(() => expect(screen.getByTestId("selo-fora-do-funil").textContent).toBe("Fora do funil · Equipe"));
  });
});
