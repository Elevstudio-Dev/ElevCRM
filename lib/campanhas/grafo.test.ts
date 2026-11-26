import { describe, expect, it } from "vitest";

import { flowGraphSchema } from "@/lib/followup/graph-schema";
import { validateFlowForPublish } from "@/lib/followup/validate-publish";
import { triggerConfigSchema } from "@/lib/followup/api-schemas";

import { RITMO_PADRAO } from "./horarios";
import { grafoDaCampanha } from "./servico";
import { NO_GATILHO } from "./situacao";

const CANAL = "6f1c1b7e-2a4d-4f55-9a43-0b6f4b0b8c11";

describe("grafo da campanha", () => {
  it("passa no schema e na validação de publish do motor de follow-up", () => {
    const grafo = grafoDaCampanha("Convidar para a revisão de limpeza", CANAL);
    expect(flowGraphSchema.safeParse(grafo).success).toBe(true);
    const v = validateFlowForPublish(grafo);
    expect(v.ok ? [] : v.errors).toEqual([]);
  });

  it("leva o número escolhido e a abertura de campanha no nó da IA", () => {
    const grafo = grafoDaCampanha("Objetivo qualquer da campanha", CANAL);
    expect(grafo.nodes[0]!.id).toBe(NO_GATILHO);
    const acao = grafo.nodes.find((n) => n.type === "action");
    expect(acao?.config).toMatchObject({ mode: "ai_message", canal_id: CANAL, abertura: "campanha" });
  });

  it("com arte: a imagem vai no nó da IA e o grafo continua válido", () => {
    const imagem = { storage_path: "org/campanhas/arte.jpg", mime: "image/jpeg" };
    const grafo = grafoDaCampanha("Convidar para a limpeza", CANAL, imagem);
    expect(flowGraphSchema.safeParse(grafo).success).toBe(true);
    expect(grafo.nodes.find((n) => n.type === "action")?.config).toMatchObject({ imagem });
    // WEBP nunca chega ao grafo: a rota de upload converte antes
    const webp = grafoDaCampanha("Convidar para a limpeza", CANAL, { ...imagem, mime: "image/webp" });
    expect(flowGraphSchema.safeParse(webp).success).toBe(false);
  });

  it("o trigger_config de campanha parseia (senão o cancel_on_reply some em silêncio)", () => {
    const cfg = {
      kind: "campanha",
      params: {
        etiquetas: ["base-odontocompany"],
        canal_id: CANAL,
        objetivo: "Convidar para a revisão",
        ritmo: RITMO_PADRAO,
        estado: "enviando",
      },
      cancel_on_reply: true,
    };
    const r = triggerConfigSchema.safeParse(cfg);
    expect(r.success).toBe(true);
    expect(r.success && r.data.cancel_on_reply).toBe(true);
  });
});
