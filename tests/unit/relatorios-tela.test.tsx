import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RelatorioDeOrigens } from "@/hooks/relatorios/useRelatorioDeOrigens";

/**
 * A TELA DE RELATÓRIO DE ORIGENS.
 *
 * O que se protege: os números chegam formatados como o dono lê (R$ com centavos, conversão "—" enquanto
 * ninguém fechou), o grupo abre nos detalhes (cada QR pelo nome), o botão de período REFAZ a pergunta ao
 * servidor, e o vazio diz que está vazio em vez de mostrar uma tabela de zeros.
 */
const get = vi.fn();
vi.mock("@/lib/api/client", () => ({ apiClient: { get: (...a: unknown[]) => get(...a) } }));

// jsdom não mede layout: o ResponsiveContainer real renderiza 0×0 e o gráfico some.
vi.mock("recharts", async (orig) => {
  const real = await orig<typeof import("recharts")>();
  return {
    ...real,
    ResponsiveContainer: ({ children }: { children: React.ReactElement }) => (
      <div data-testid="grafico">{children && <>{children}</>}</div>
    ),
  };
});

import { RelatoriosClient } from "@/app/app/relatorios/_components/RelatoriosClient";

const T = (over: Partial<RelatorioDeOrigens["total"]> = {}) => ({
  leads: 0,
  abertos: 0,
  ganhos: 0,
  perdidos: 0,
  valorGanhoCents: 0,
  conversao: null,
  ...over,
});

const COM_DADOS: RelatorioDeOrigens = {
  total: T({ leads: 12, abertos: 6, ganhos: 3, perdidos: 1, valorGanhoCents: 150000, conversao: 0.75 }),
  grupos: [
    {
      grupo: "qr",
      ...T({ leads: 7, abertos: 4, ganhos: 2, perdidos: 1, valorGanhoCents: 100000, conversao: 2 / 3 }),
      detalhes: [
        { chave: "qr:1", rotulo: "Cartaz da recepção", ...T({ leads: 5, ganhos: 2, perdidos: 1, valorGanhoCents: 100000 }) },
        { chave: "qr:2", rotulo: "Panfleto do metrô", ...T({ leads: 2 }) },
      ],
    },
    {
      grupo: "whatsapp",
      ...T({ leads: 5, abertos: 2, ganhos: 1, valorGanhoCents: 50000, conversao: 1 }),
      detalhes: [{ chave: "WhatsApp direto", rotulo: "WhatsApp direto", ...T({ leads: 5 }) }],
    },
  ],
  serie: [
    { dia: "2026-10-01", qr: 3, anuncio: 0, formulario: 0, whatsapp: 1, manual: 0, importado: 0, ia: 0, outros: 0 },
    { dia: "2026-10-02", qr: 4, anuncio: 0, formulario: 0, whatsapp: 4, manual: 0, importado: 0, ia: 0, outros: 0 },
  ],
};

const VAZIO: RelatorioDeOrigens = { total: T(), grupos: [], serie: [] };

function renderizar() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <RelatoriosClient />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  get.mockReset();
  get.mockResolvedValue({ data: COM_DADOS });
});
afterEach(cleanup);

/** Espera o relatório sair do esqueleto e devolve o texto de um dos quatro blocos do topo. */
async function bloco(id: "leads" | "vendas" | "conversao" | "valor"): Promise<string> {
  const el = await screen.findByTestId(`resumo-${id}`);
  return el.textContent ?? "";
}

describe("RelatoriosClient", () => {
  it("mostra os quatro números do período já formatados", async () => {
    renderizar();
    expect(await bloco("leads")).toContain("12");
    expect(await bloco("vendas")).toContain("3");
    expect(await bloco("conversao")).toContain("75%");
    expect(await bloco("valor")).toMatch(/R\$\s1\.500,00/); // NBSP depois do R$
  });

  it("conversão null aparece como '—', não como '0%'", async () => {
    get.mockResolvedValue({ data: { ...COM_DADOS, total: T({ leads: 3, abertos: 3 }) } });
    renderizar();
    const texto = await bloco("conversao");
    expect(texto).toContain("—");
    expect(texto).not.toContain("0%");
  });

  it("clicar no grupo 'QR codes' mostra cada QR pelo nome", async () => {
    const user = userEvent.setup();
    renderizar();
    const grupo = await screen.findByRole("button", { name: "QR codes" });
    expect(grupo.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("Cartaz da recepção")).toBeNull();

    await user.click(grupo);

    expect(grupo.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("Cartaz da recepção")).toBeTruthy();
    expect(screen.getByText("Panfleto do metrô")).toBeTruthy();
  });

  it("grupo sem detalhe útil (WhatsApp direto) não ganha botão de expandir", async () => {
    renderizar();
    await screen.findByRole("button", { name: "QR codes" });
    expect(screen.queryByRole("button", { name: "WhatsApp direto" })).toBeNull();
    expect(screen.getByText("WhatsApp direto")).toBeTruthy();
  });

  it("trocar para '7 dias' refaz a consulta com outro período", async () => {
    const user = userEvent.setup();
    renderizar();
    await bloco("leads");
    const primeira = new URLSearchParams(String(get.mock.calls[0]![0]).split("?")[1]);

    await user.click(screen.getByRole("button", { name: "7 dias" }));

    await waitFor(() => expect(get.mock.calls.length).toBeGreaterThan(1));
    const ultima = new URLSearchParams(String(get.mock.calls.at(-1)![0]).split("?")[1]);
    expect(ultima.get("ate")).toBe(primeira.get("ate")); // termina hoje nos dois
    expect(ultima.get("de")).not.toBe(primeira.get("de"));
    expect(screen.getByRole("button", { name: "7 dias" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "30 dias" }).getAttribute("aria-pressed")).toBe("false");
  });

  it("sem lead no período: diz que está vazio, em vez de uma tabela de zeros", async () => {
    get.mockResolvedValue({ data: VAZIO });
    renderizar();
    expect((await screen.findAllByText("Nenhum lead neste período.")).length).toBeGreaterThan(0);
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("erro do servidor mostra a mensagem e deixa tentar de novo", async () => {
    const user = userEvent.setup();
    get.mockRejectedValueOnce(new Error("falhou"));
    renderizar();
    const botao = await screen.findByRole("button", { name: "Tentar de novo" });
    expect(screen.getByText("Não foi possível carregar o relatório.")).toBeTruthy();

    await user.click(botao);

    expect(await bloco("leads")).toContain("12");
  });
});
