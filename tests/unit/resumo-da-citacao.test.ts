/**
 * O QUE A CITAÇÃO DIZ DA MENSAGEM CITADA.
 *
 * O defeito: responder a um áudio ou a uma foto mostrava "(sem texto)" na faixa e na bolha — como se a
 * mensagem estivesse vazia. Em mídia o `body` é nulo (ou é só a legenda), e a citação precisa dizer o
 * que a mensagem É.
 */
import { describe, expect, it } from "vitest";

import { resumoDaCitacao } from "@/lib/inbox/resumo-da-citacao";

type Entrada = Parameters<typeof resumoDaCitacao>[0];
const base: Entrada = {
  type: "text",
  body: null,
  revoked_at: null,
  media_url: null,
  media_storage_path: null,
};
const msg = (over: Partial<Entrada>): Entrada => ({ ...base, ...over });

describe("resumoDaCitacao", () => {
  it("texto: o próprio texto, sem as sobras de espaço, e sem rótulo", () => {
    expect(resumoDaCitacao(msg({ body: "  quero remarcar \n" }))).toEqual({
      icone: null,
      trecho: "quero remarcar",
      rotulo: null,
      apagada: false,
    });
  });

  it.each([
    ["audio", "audio", "Áudio"],
    ["image", "imagem", "Foto"],
    ["video", "video", "Vídeo"],
    ["sticker", "figurinha", "Figurinha"],
    ["document", "documento", "Documento"],
    ["contact", "contato", "Contato"],
    ["location", "localizacao", "Localização"],
  ])("mídia %s SEM legenda: ícone %s e o nome do tipo — nunca '(sem texto)'", (type, icone, rotulo) => {
    const r = resumoDaCitacao(msg({ type, media_storage_path: "org/conv/x" }));
    expect(r.icone).toBe(icone);
    expect(r.rotulo).toBe(rotulo);
    expect(r.trecho).toBeNull();
    expect(r.rotulo).not.toBe("(sem texto)");
  });

  it("mídia COM legenda: o ícone do tipo e a legenda (o que a pessoa escreveu manda no resumo)", () => {
    const r = resumoDaCitacao(msg({ type: "image", body: "  o comprovante  " }));
    expect(r.icone).toBe("imagem");
    expect(r.trecho).toBe("o comprovante");
  });

  it("apagada: o conteúdo NÃO volta — nem o texto, nem a legenda", () => {
    // O "apagar para todos" do cliente sumia da bolha original e continuava legível dentro de cada
    // resposta que a citou: a citação é o mesmo texto num segundo lugar da tela.
    const r = resumoDaCitacao(msg({ body: "segredo", type: "text", revoked_at: "2026-10-27T10:00:00Z" }));
    expect(r.apagada).toBe(true);
    expect(r.trecho).toBeNull();
    expect(r.rotulo).toBe("Esta mensagem foi apagada");
    expect(r.icone).toBeNull();

    const midia = resumoDaCitacao(msg({ type: "image", body: "legenda", revoked_at: "2026-10-27T10:00:00Z" }));
    expect(midia.trecho).toBeNull();
    expect(midia.icone).toBeNull();
  });

  it("tipo desconhecido que carrega arquivo é um anexo, não 'sem texto'", () => {
    expect(resumoDaCitacao(msg({ type: "algo-novo", media_url: "http://x/y" }))).toMatchObject({
      icone: "anexo",
      rotulo: "Anexo",
    });
  });

  it("de fato vazio (nem texto, nem mídia): '(sem texto)' continua sendo a resposta honesta", () => {
    expect(resumoDaCitacao(msg({ body: "   " })).rotulo).toBe("(sem texto)");
    expect(resumoDaCitacao(msg({ body: null })).icone).toBeNull();
  });
});
