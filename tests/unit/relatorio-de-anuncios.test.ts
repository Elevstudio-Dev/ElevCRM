import { describe, expect, it } from "vitest";

import { desempenho, montarAnuncios, type LinhaDeAnuncio } from "@/lib/relatorios/anuncios";

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
  conversas: 8,
  moeda: "BRL",
  ...extra,
});

describe("desempenho", () => {
  it("custo por contato, custo por venda e retorno", () => {
    const d = desempenho({ leads: 4, ganhos: 1, valorGanhoCents: 50_000, gastoCents: 20_000, moeda: "BRL" });
    expect(d.custoPorContatoCents).toBe(5000);
    expect(d.custoPorVendaCents).toBe(20_000);
    expect(d.retorno).toBeCloseTo(2.5);
  });

  it("sem contato ou sem gasto: o custo é nulo, nunca zero", () => {
    expect(desempenho({ leads: 0, ganhos: 0, valorGanhoCents: 0, gastoCents: 9000, moeda: "BRL" }).custoPorContatoCents).toBeNull();
    expect(desempenho({ leads: 3, ganhos: 1, valorGanhoCents: 100, gastoCents: 0, moeda: "BRL" })).toMatchObject({
      custoPorContatoCents: null,
      custoPorVendaCents: null,
      retorno: null,
    });
  });

  it("custo por conversa usa as conversas que a Meta informa; sem conversa ou sem gasto é nulo, nunca zero", () => {
    const base = { leads: 0, ganhos: 0, valorGanhoCents: 0, moeda: "BRL" };
    expect(desempenho({ ...base, conversas: 10, gastoCents: 25_000 }).custoPorConversaCents).toBe(2500);
    expect(desempenho({ ...base, conversas: 0, gastoCents: 25_000 }).custoPorConversaCents).toBeNull();
    expect(desempenho({ ...base, conversas: 4, gastoCents: 0 }).custoPorConversaCents).toBeNull();
  });

  it("sem venda, o custo por venda é nulo (e o retorno é 0, porque houve gasto)", () => {
    const d = desempenho({ leads: 3, ganhos: 0, valorGanhoCents: 0, gastoCents: 9000, moeda: "BRL" });
    expect(d.custoPorVendaCents).toBeNull();
    expect(d.retorno).toBe(0);
  });

  it("conta de anúncios fora de reais: sem retorno (reais ÷ dólares seria número bonito e errado)", () => {
    const d = desempenho({ leads: 3, ganhos: 1, valorGanhoCents: 100_000, gastoCents: 9000, moeda: "USD" });
    expect(d.retorno).toBeNull();
    expect(d.custoPorContatoCents).toBe(3000);
    expect(desempenho({ leads: 1, ganhos: 1, valorGanhoCents: 1, gastoCents: 1, moeda: null }).retorno).toBeNull();
  });
});

describe("montarAnuncios", () => {
  it("ordena pelo maior gasto e marca o anúncio que gastou sem trazer ninguém", () => {
    const { anuncios } = montarAnuncios([
      linha({ ad_id: "1", anuncio: "Barato", gasto_cents: 1000 }),
      linha({ ad_id: "2", anuncio: "Caro e vazio", gasto_cents: 90_000, leads: 0, conversas: 0, ganhos: 0, abertos: 0, perdidos: 0, valor_ganho_cents: 0 }),
    ]);
    expect(anuncios.map((a) => a.rotulo)).toEqual(["Caro e vazio", "Barato"]);
    expect(anuncios[0]!.gastouSemContato).toBe(true);
    expect(anuncios[0]!.custoPorContatoCents).toBeNull();
    expect(anuncios[1]!.gastouSemContato).toBe(false);
  });

  it("os números da Meta aparecem completos mesmo quando o CRM não reconheceu ninguém", () => {
    // Gasto e 12 conversas na Meta, 0 contatos marcados no CRM: não é "ninguém chamou" — alguém chamou.
    const { anuncios, total } = montarAnuncios([
      linha({ ad_id: "1", gasto_cents: 36_000, leads: 0, ganhos: 0, abertos: 0, perdidos: 0, valor_ganho_cents: 0, conversas: 12, impressoes: 9000, cliques: 300 }),
    ]);
    expect(anuncios[0]).toMatchObject({
      conversas: 12,
      impressoes: 9000,
      cliques: 300,
      custoPorConversaCents: 3000,
      custoPorContatoCents: null,
      gastouSemContato: false,
    });
    expect(total).toMatchObject({ conversas: 12, impressoes: 9000, cliques: 300, custoPorConversaCents: 3000 });
  });

  it("o total soma conversas, impressões e cliques de todos os anúncios", () => {
    const { total } = montarAnuncios([
      linha({ ad_id: "1", conversas: 5, impressoes: 100, cliques: 10, gasto_cents: 10_000 }),
      linha({ ad_id: "2", conversas: 3, impressoes: 200, cliques: 20, gasto_cents: 6_000 }),
    ]);
    expect(total).toMatchObject({ conversas: 8, impressoes: 300, cliques: 30, custoPorConversaCents: 2000 });
  });

  it("o rótulo é o nome na Meta; sem ele, o título do clique; sem código, 'sem identificação'", () => {
    const { anuncios } = montarAnuncios([
      linha({ ad_id: "1", anuncio: "Nome na Meta" }),
      linha({ ad_id: "2", anuncio: null, titulo: "Só o título", gasto_cents: 0 }),
      linha({ ad_id: null, anuncio: null, titulo: null, campanha: null, conjunto: null, gasto_cents: 0, moeda: null }),
    ]);
    const rotulos = anuncios.map((a) => a.rotulo);
    expect(rotulos).toContain("Nome na Meta");
    expect(rotulos).toContain("Só o título");
    expect(rotulos).toContain("Anúncio sem identificação");
    expect(anuncios.find((a) => a.chave === "sem-codigo")).toBeTruthy();
  });

  it("o total soma gasto, contatos, vendas e valor, e calcula os custos do conjunto", () => {
    const { total } = montarAnuncios([
      linha({ ad_id: "1", leads: 4, ganhos: 1, valor_ganho_cents: 50_000, gasto_cents: 20_000 }),
      linha({ ad_id: "2", leads: 6, ganhos: 1, valor_ganho_cents: 150_000, gasto_cents: 30_000 }),
    ]);
    expect(total).toMatchObject({ leads: 10, ganhos: 2, valorGanhoCents: 200_000, gastoCents: 50_000, moeda: "BRL" });
    expect(total.custoPorContatoCents).toBe(5000);
    expect(total.custoPorVendaCents).toBe(25_000);
    expect(total.retorno).toBeCloseTo(4);
  });

  it("moedas misturadas: não soma gasto (nem inventa custo ou retorno)", () => {
    const { total } = montarAnuncios([
      linha({ ad_id: "1", gasto_cents: 1000, moeda: "BRL" }),
      linha({ ad_id: "2", gasto_cents: 1000, moeda: "USD" }),
    ]);
    expect(total.gastoCents).toBe(0);
    expect(total.moeda).toBeNull();
    expect(total.custoPorContatoCents).toBeNull();
    expect(total.retorno).toBeNull();
  });

  it("lista vazia: total zerado e sem custos", () => {
    const { anuncios, total } = montarAnuncios([]);
    expect(anuncios).toEqual([]);
    expect(total).toMatchObject({ leads: 0, gastoCents: 0, custoPorContatoCents: null, retorno: null });
  });
});
