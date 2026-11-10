import { describe, expect, it, vi } from "vitest";

import { centavos, contador, linhaDeGasto } from "@/lib/meta-ads/gasto";
import { classificarErro, lerConta, lerGastoPorAnuncio, MetaAdsError } from "@/lib/channels/meta/ads-graph";

describe("centavos — dinheiro da Meta sem ponto flutuante", () => {
  it("converte texto decimal em centavos exatos", () => {
    expect(centavos("123.45")).toBe(12345);
    expect(centavos("0.29")).toBe(29); // 0.29 * 100 dá 28.999… em ponto flutuante
    expect(centavos("1.1")).toBe(110);
    expect(centavos("7")).toBe(700);
    expect(centavos("1234567.89")).toBe(123456789);
  });

  it("arredonda a terceira casa para cima na metade", () => {
    expect(centavos("0.005")).toBe(1);
    expect(centavos("0.004")).toBe(0);
    expect(centavos("2.999")).toBe(300);
  });

  it("aceita número e recusa o que não é dinheiro bem formado", () => {
    expect(centavos(10)).toBe(1000);
    for (const ruim of ["abc", "-1", "1e3", "12.", ".5", "", "1,5", null, undefined, {}, NaN, -3]) {
      expect(centavos(ruim as never), String(ruim)).toBeNull();
    }
  });
});

describe("contador", () => {
  it("aceita inteiro não negativo, em texto ou número", () => {
    expect(contador("1200")).toBe(1200);
    expect(contador(7)).toBe(7);
    for (const ruim of ["-1", "1.5", "x", null, 1.5, -1]) expect(contador(ruim as never)).toBeNull();
  });
});

const bruta = (extra: Record<string, unknown> = {}) => ({
  ad_id: "120210000000000",
  ad_name: "Clareamento — vídeo 1",
  adset_id: "120200000000001",
  adset_name: "Público frio",
  campaign_id: "120200000000002",
  campaign_name: "Clareamento novembro",
  spend: "12.34",
  impressions: "1500",
  clicks: "40",
  account_currency: "BRL",
  date_start: "2026-11-08",
  date_stop: "2026-11-08",
  ...extra,
});

describe("linhaDeGasto", () => {
  it("normaliza uma linha de insights", () => {
    expect(linhaDeGasto(bruta(), "USD")).toEqual({
      dia: "2026-11-08",
      ad_id: "120210000000000",
      ad_name: "Clareamento — vídeo 1",
      adset_id: "120200000000001",
      adset_name: "Público frio",
      campaign_id: "120200000000002",
      campaign_name: "Clareamento novembro",
      spend_cents: 1234,
      impressions: 1500,
      clicks: 40,
      currency: "BRL",
    });
  });

  it("usa a moeda da conta quando a linha não traz", () => {
    expect(linhaDeGasto(bruta({ account_currency: undefined }), "USD")?.currency).toBe("USD");
  });

  it("descarta linha sem código de anúncio, com data torta ou com gasto inválido", () => {
    expect(linhaDeGasto(bruta({ ad_id: undefined }), null)).toBeNull();
    expect(linhaDeGasto(bruta({ ad_id: "abc" }), null)).toBeNull();
    expect(linhaDeGasto(bruta({ date_start: "08/11/2026" }), null)).toBeNull();
    expect(linhaDeGasto(bruta({ spend: "-5" }), null)).toBeNull();
    expect(linhaDeGasto(null, null)).toBeNull();
    expect(linhaDeGasto([], null)).toBeNull();
  });
});

function resposta(corpo: unknown, status = 200): Response {
  return new Response(JSON.stringify(corpo), { status, headers: { "content-type": "application/json" } });
}

describe("lerGastoPorAnuncio", () => {
  it("manda a chave no cabeçalho, nunca na URL, e só para a Graph", async () => {
    const f = vi.fn().mockResolvedValue(resposta({ data: [bruta()] }));
    const r = await lerGastoPorAnuncio("1234567", "SEGREDO-123", "2026-10-01", "2026-11-08", "BRL", f as never);
    expect(r.linhas).toHaveLength(1);
    const [url, init] = f.mock.calls[0]!;
    expect(String(url)).not.toContain("SEGREDO-123");
    expect(new URL(String(url)).hostname).toBe("graph.facebook.com");
    expect(String(url)).toContain("/act_1234567/insights");
    expect(String(url)).toContain("level=ad");
    expect(String(url)).toContain("time_increment=1");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer SEGREDO-123");
    expect(init.redirect).toBe("error");
  });

  it("segue a próxima página e conta o que descartou", async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(
        resposta({
          data: [bruta(), bruta({ ad_id: "x" })],
          paging: { next: "https://graph.facebook.com/v23.0/act_1234567/insights?after=ABC" },
        }),
      )
      .mockResolvedValueOnce(resposta({ data: [bruta({ date_start: "2026-11-07" })] }));
    const r = await lerGastoPorAnuncio("1234567", "t", "2026-10-01", "2026-11-08", "BRL", f as never);
    expect(r.linhas.map((l) => l.dia)).toEqual(["2026-11-08", "2026-11-07"]);
    expect(r.descartadas).toBe(1);
    expect(f).toHaveBeenCalledTimes(2);
    expect((f.mock.calls[1]![1].headers as Record<string, string>).Authorization).toBe("Bearer t");
  });

  it("RECUSA uma próxima página que aponta para outro host (SSRF) e não manda a chave para lá", async () => {
    const f = vi.fn().mockResolvedValueOnce(
      resposta({ data: [bruta()], paging: { next: "https://atacante.example/colher" } }),
    );
    await expect(
      lerGastoPorAnuncio("1234567", "SEGREDO", "2026-10-01", "2026-11-08", "BRL", f as never),
    ).rejects.toMatchObject({ codigo: "indisponivel" });
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("recusa http simples e conta de anúncios malformada antes de chamar a rede", async () => {
    const f = vi.fn();
    await expect(lerGastoPorAnuncio("abc", "t", "2026-10-01", "2026-11-08", null, f as never)).rejects.toMatchObject({
      codigo: "conta_invalida",
    });
    await expect(lerGastoPorAnuncio("1234567", "t", "ontem", "2026-11-08", null, f as never)).rejects.toMatchObject({
      codigo: "conta_invalida",
    });
    expect(f).not.toHaveBeenCalled();
  });

  it("traduz a falha da Meta para um código nosso, sem repassar a mensagem dela", async () => {
    const f = vi.fn().mockResolvedValue(resposta({ error: { code: 190, message: "texto cru da Meta com detalhes" } }, 400));
    const erro = await lerGastoPorAnuncio("1234567", "t", "2026-10-01", "2026-11-08", null, f as never).catch(
      (e: unknown) => e,
    );
    expect(erro).toBeInstanceOf(MetaAdsError);
    expect((erro as MetaAdsError).codigo).toBe("token_invalido");
    expect((erro as Error).message).not.toContain("texto cru");
  });

  it("falha de rede vira 'indisponivel'", async () => {
    const f = vi.fn().mockRejectedValue(new Error("ECONNRESET"));
    await expect(lerGastoPorAnuncio("1234567", "t", "2026-10-01", "2026-11-08", null, f as never)).rejects.toMatchObject({
      codigo: "indisponivel",
    });
  });

  it("pede também os anúncios arquivados, apagados e de campanha desativada", async () => {
    const f = vi.fn().mockResolvedValue(resposta({ data: [bruta()] }));
    await lerGastoPorAnuncio("1234567", "t", "2026-10-01", "2026-11-08", "BRL", f as never);
    const filtro = JSON.parse(new URL(String(f.mock.calls[0]![0])).searchParams.get("filtering") ?? "[]") as Array<{
      field: string;
      operator: string;
      value: string[];
    }>;
    expect(filtro).toHaveLength(1);
    expect(filtro[0]).toMatchObject({ field: "ad.effective_status", operator: "IN" });
    for (const estado of ["ACTIVE", "PAUSED", "ARCHIVED", "DELETED", "CAMPAIGN_PAUSED", "ADSET_PAUSED"]) {
      expect(filtro[0]!.value).toContain(estado);
    }
  });

  it("se a Meta recusar o filtro, lê de novo sem ele em vez de ficar sem nada", async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(resposta({ error: { code: 100, message: "parâmetro inválido" } }, 400))
      .mockResolvedValueOnce(resposta({ data: [bruta()] }));
    const r = await lerGastoPorAnuncio("1234567", "t", "2026-10-01", "2026-11-08", "BRL", f as never);
    expect(r.linhas).toHaveLength(1);
    expect(f).toHaveBeenCalledTimes(2);
    expect(new URL(String(f.mock.calls[0]![0])).searchParams.has("filtering")).toBe(true);
    expect(new URL(String(f.mock.calls[1]![0])).searchParams.has("filtering")).toBe(false);
  });

  it("chave inválida não é repetida sem filtro: falha na primeira", async () => {
    const f = vi.fn().mockResolvedValue(resposta({ error: { code: 190 } }, 401));
    await expect(lerGastoPorAnuncio("1234567", "t", "2026-10-01", "2026-11-08", null, f as never)).rejects.toMatchObject({
      codigo: "token_invalido",
    });
    expect(f).toHaveBeenCalledTimes(1);
  });
});

describe("classificarErro", () => {
  it("separa chave inválida, limite, permissão e conta inexistente", () => {
    expect(classificarErro(400, { error: { code: 190 } }).codigo).toBe("token_invalido");
    expect(classificarErro(401, null).codigo).toBe("token_invalido");
    expect(classificarErro(400, { error: { code: 17 } }).codigo).toBe("limite");
    expect(classificarErro(429, null).codigo).toBe("limite");
    expect(classificarErro(403, { error: { code: 200 } }).codigo).toBe("sem_permissao");
    expect(classificarErro(400, { error: { code: 100 } }).codigo).toBe("conta_invalida");
    expect(classificarErro(500, null).codigo).toBe("indisponivel");
  });
});

describe("lerConta", () => {
  it("lê nome e moeda", async () => {
    const f = vi.fn().mockResolvedValue(resposta({ name: "Clínica Sorriso", currency: "BRL", id: "act_1234567" }));
    await expect(lerConta("1234567", "t", f as never)).resolves.toEqual({ nome: "Clínica Sorriso", moeda: "BRL" });
    expect(String(f.mock.calls[0]![0])).toContain("/act_1234567?fields=name,currency");
  });

  it("ignora moeda fora do formato", async () => {
    const f = vi.fn().mockResolvedValue(resposta({ name: "X", currency: "reais" }));
    await expect(lerConta("1234567", "t", f as never)).resolves.toEqual({ nome: "X", moeda: null });
  });
});
