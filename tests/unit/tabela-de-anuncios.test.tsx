import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { TabelaDeAnuncios } from "@/app/app/relatorios/_components/TabelaDeAnuncios";
import type { RelatorioDeAnuncios } from "@/hooks/relatorios/useRelatorioDeAnuncios";
import { montarAnuncios, type LinhaDeAnuncio } from "@/lib/relatorios/anuncios";
import { SEM_CONEXAO } from "@/lib/schemas/meta-ads";

/**
 * A TABELA "ANÚNCIOS: GASTO, CUSTO E RETORNO".
 *
 * O que se protege: sem conexão a tabela NÃO mostra colunas de dinheiro (um "—" em cada linha diria que o anúncio
 * foi de graça), com conexão mostra custo por contato / custo por venda / retorno, o anúncio que gastou sem trazer
 * ninguém é marcado, e o estado da conexão (chave recusada, erro da Meta) é dito em cima da tabela.
 */
const linha = (extra: Partial<LinhaDeAnuncio> = {}): LinhaDeAnuncio => ({
  ad_id: "111",
  titulo: "Título do clique",
  campanha: "Campanha A",
  conjunto: "Conjunto A",
  anuncio: "Anúncio A",
  leads: 4,
  abertos: 2,
  ganhos: 1,
  perdidos: 1,
  valor_ganho_cents: 50_000,
  gasto_cents: 20_000,
  impressoes: 1000,
  cliques: 50,
  moeda: "BRL",
  ...extra,
});

const CONECTADA = {
  ...SEM_CONEXAO,
  conectada: true,
  ad_account_id: "1234567",
  account_name: "Clínica",
  currency: "BRL",
  status: "conectada" as const,
  last_synced_at: "2026-11-09T15:00:00.000Z",
};

const dados = (linhas: LinhaDeAnuncio[], conexao: RelatorioDeAnuncios["conexao"]): RelatorioDeAnuncios => ({
  ...montarAnuncios(linhas),
  conexao,
});

describe("TabelaDeAnuncios", () => {
  it("sem conexão: convida a conectar e NÃO desenha colunas de dinheiro", () => {
    render(<TabelaDeAnuncios dados={dados([linha()], SEM_CONEXAO)} />);
    expect(screen.getByTestId("aviso-meta").textContent).toContain("Conecte a conta de anúncios da Meta");
    expect(screen.getByRole("link", { name: "Conectar a conta de anúncios" }).getAttribute("href")).toBe(
      "/app/settings/meta-ads",
    );
    expect(screen.queryByText("Gasto")).toBeNull();
    expect(screen.queryByText("Custo por contato")).toBeNull();
    expect(screen.queryByText("Retorno")).toBeNull();
    expect(screen.getByText("Contatos")).toBeTruthy();
    expect(screen.getByText("Anúncio A")).toBeTruthy();
  });

  it("conectada: mostra gasto, custo por contato, custo por venda e retorno", () => {
    render(<TabelaDeAnuncios dados={dados([linha()], CONECTADA)} />);
    const l = screen.getByTestId("linha-de-anuncio");
    const celulas = within(l).getAllByRole("cell").map((c) => c.textContent?.replace(/\s/g, " "));
    // Anúncio | Gasto | Contatos | Custo por contato | Vendas | Custo por venda | Valor ganho | Retorno
    expect(celulas[0]).toContain("Anúncio A");
    expect(celulas[0]).toContain("Campanha A › Conjunto A");
    expect(celulas[1]).toMatch(/R\$\s?200,00/);
    expect(celulas[2]).toBe("4");
    expect(celulas[3]).toMatch(/R\$\s?50,00/);
    expect(celulas[4]).toBe("1");
    expect(celulas[5]).toMatch(/R\$\s?200,00/);
    expect(celulas[6]).toMatch(/R\$\s?500,00/);
    expect(celulas[7]).toBe("2,50x");
  });

  it("marca o anúncio que gastou e ninguém chamou, com custo por contato '—'", () => {
    render(
      <TabelaDeAnuncios
        dados={dados(
          [linha({ ad_id: "2", anuncio: "Caro e vazio", gasto_cents: 90_000, leads: 0, ganhos: 0, abertos: 0, perdidos: 0, valor_ganho_cents: 0 })],
          CONECTADA,
        )}
      />,
    );
    expect(screen.getByText("Gastou e ninguém chamou")).toBeTruthy();
    const celulas = within(screen.getByTestId("linha-de-anuncio")).getAllByRole("cell").map((c) => c.textContent);
    expect(celulas[3]).toBe("—");
  });

  it("chave recusada pela Meta: avisa e diz que os números são os da última atualização", () => {
    render(<TabelaDeAnuncios dados={dados([linha()], { ...CONECTADA, status: "token_invalido" })} />);
    const aviso = screen.getByTestId("aviso-meta").textContent ?? "";
    expect(aviso).toContain("A Meta recusou a chave de acesso");
    expect(aviso).toContain("última atualização");
  });

  it("erro da Meta: mostra a frase gravada pela sincronização", () => {
    render(
      <TabelaDeAnuncios
        dados={dados([linha()], { ...CONECTADA, status: "erro", last_error: "A Meta pediu para esperar um pouco." })}
      />,
    );
    expect(screen.getByTestId("aviso-meta").textContent).toContain("A Meta pediu para esperar um pouco.");
  });

  it("sem anúncio no período: diz que está vazio em vez de uma tabela de zeros", () => {
    render(<TabelaDeAnuncios dados={dados([], CONECTADA)} />);
    expect(screen.getByText("Nenhum anúncio com contato ou gasto neste período.")).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("o nome do anúncio vindo da Meta entra como texto, nunca como HTML", () => {
    const { container } = render(
      <TabelaDeAnuncios
        dados={dados([linha({ anuncio: "<img src=x onerror=alert(1)>", campanha: "<b>x</b>" })], CONECTADA)}
      />,
    );
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("b")).toBeNull();
    expect(screen.getByText("<img src=x onerror=alert(1)>")).toBeTruthy();
  });
});
