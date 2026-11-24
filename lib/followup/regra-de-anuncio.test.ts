import { describe, expect, it } from "vitest";

import { regraDeAnuncioSchema } from "./regra-de-anuncio";
import { podeEntrarNoAutomatico, veioDeAnuncio, type PerfilDeOrigem } from "./regra-de-anuncio";
import { triggerConfigSchema } from "./api-schemas";

const REGRA = { liberar_nas_etapas: ["compareceu", "orcamento_apresentado", "em_tratamento"] };

const doAnuncio: PerfilDeOrigem = {
  contatoSource: "meta_ads",
  contatoMetadata: { ad_platform: "meta_ads" },
  leadSource: "meta_ads",
  etapaSlug: "entendendo_o_caso",
};
const organico: PerfilDeOrigem = {
  contatoSource: "whatsapp",
  contatoMetadata: null,
  leadSource: "whatsapp",
  etapaSlug: "entendendo_o_caso",
};

describe("regra de anúncio do follow-up automático", () => {
  it("lead de anúncio ANTES da avaliação não entra", () => {
    expect(podeEntrarNoAutomatico(doAnuncio, REGRA)).toBe(false);
    expect(podeEntrarNoAutomatico({ ...doAnuncio, etapaSlug: "consulta_marcada" }, REGRA)).toBe(false);
    expect(podeEntrarNoAutomatico({ ...doAnuncio, etapaSlug: "faltou_reagendar" }, REGRA)).toBe(false);
  });

  it("lead de anúncio sem lead (sem etapa) não entra", () => {
    expect(podeEntrarNoAutomatico({ ...doAnuncio, leadSource: null, etapaSlug: null }, REGRA)).toBe(false);
  });

  it("lead de anúncio DEPOIS da avaliação entra (as três etapas liberadas)", () => {
    for (const etapaSlug of REGRA.liberar_nas_etapas) {
      expect(podeEntrarNoAutomatico({ ...doAnuncio, etapaSlug }, REGRA)).toBe(true);
    }
  });

  it("contato que NÃO veio de anúncio segue como sempre, em qualquer etapa", () => {
    expect(podeEntrarNoAutomatico(organico, REGRA)).toBe(true);
    expect(podeEntrarNoAutomatico({ ...organico, etapaSlug: null }, REGRA)).toBe(true);
  });

  it("sem regra no fluxo, ninguém é barrado (outras organizações e fluxos não mudam)", () => {
    expect(podeEntrarNoAutomatico(doAnuncio, null)).toBe(true);
    expect(podeEntrarNoAutomatico(doAnuncio, undefined)).toBe(true);
  });

  it("reconhece o anúncio pelo carimbo do CONTATO ou pelo do LEAD", () => {
    // Só o contato carimbado (lead antigo como whatsapp): é anúncio.
    expect(
      veioDeAnuncio({ ...doAnuncio, leadSource: "whatsapp" }),
    ).toBe(true);
    // Só o lead carimbado (contato sem marca): é anúncio.
    expect(
      veioDeAnuncio({ contatoSource: "whatsapp", contatoMetadata: null, leadSource: "meta_ads", etapaSlug: null }),
    ).toBe(true);
    expect(veioDeAnuncio({ ...organico, leadSource: "google_ads" })).toBe(true);
    expect(veioDeAnuncio(organico)).toBe(false);
  });

  it("o schema exige ao menos uma etapa e recusa campo desconhecido", () => {
    expect(regraDeAnuncioSchema.safeParse({ liberar_nas_etapas: [] }).success).toBe(false);
    expect(regraDeAnuncioSchema.safeParse({ liberar_nas_etapas: ["compareceu"], x: 1 }).success).toBe(false);
    expect(regraDeAnuncioSchema.safeParse(REGRA).success).toBe(true);
  });

  it("o gatilho de silêncio aceita a regra e continua aceitando sem ela", () => {
    const base = { kind: "silence", params: { threshold_minutes: 1440, segments: ["followup-ia"] } };
    expect(triggerConfigSchema.safeParse(base).success).toBe(true);
    const com = triggerConfigSchema.safeParse({
      ...base,
      params: { ...base.params, leads_de_anuncio: REGRA },
    });
    expect(com.success).toBe(true);
  });
});
