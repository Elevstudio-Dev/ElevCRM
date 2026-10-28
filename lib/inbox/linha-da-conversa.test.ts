import { enUS, es, ptBR } from "date-fns/locale";
import { describe, expect, it } from "vitest";

import { horaDaLinha, previaDaLinha, tiqueDaUltima } from "./linha-da-conversa";

// Quarta-feira, 28/10/2026, 15:00 no fuso da máquina. As datas dos casos são construídas no mesmo
// fuso (`new Date(a, m, d, h, min)`), então o teste não muda de resultado conforme onde roda.
const AGORA = new Date(2026, 9, 28, 15, 0);
const iso = (d: number, h = 12, min = 0) => new Date(2026, 9, d, h, min).toISOString();

describe("horaDaLinha — a hora como o WhatsApp a escreve", () => {
  it("hoje: só a hora", () => {
    expect(horaDaLinha(iso(28, 9, 5), AGORA, ptBR, "Ontem")).toBe("09:05");
    // 00:01 de hoje continua sendo hoje, mesmo a 14h59 de distância do "agora".
    expect(horaDaLinha(iso(28, 0, 1), AGORA, ptBR, "Ontem")).toBe("00:01");
  });

  it("ontem: o rótulo que veio de fora (já traduzido)", () => {
    expect(horaDaLinha(iso(27, 18, 30), AGORA, ptBR, "Ontem")).toBe("Ontem");
    expect(horaDaLinha(iso(27, 18, 30), AGORA, es, "Ayer")).toBe("Ayer");
  });

  it("ontem é pelo DIA do calendário, não por 24 horas", () => {
    // 23:59 de ontem, visto à 00:01 de hoje: 2 minutos atrás, e mesmo assim é "Ontem".
    const quaseMeiaNoite = new Date(2026, 9, 28, 0, 1);
    expect(horaDaLinha(iso(27, 23, 59), quaseMeiaNoite, ptBR, "Ontem")).toBe("Ontem");
    // E 00:01 de ontem, visto às 23:59 de hoje, também: quase 48 horas, mas é o dia de ontem.
    const quaseAmanha = new Date(2026, 9, 28, 23, 59);
    expect(horaDaLinha(iso(27, 0, 1), quaseAmanha, ptBR, "Ontem")).toBe("Ontem");
  });

  it("de 2 a 6 dias atrás: o dia da semana, no idioma da interface", () => {
    expect(horaDaLinha(iso(25), AGORA, ptBR, "Ontem")).toBe("domingo");
    expect(horaDaLinha(iso(25), AGORA, es, "Ayer")).toBe("domingo");
    expect(horaDaLinha(iso(25), AGORA, enUS, "Yesterday")).toBe("Sunday");
    // O sexto dia ainda é dia da semana (22/10 foi quinta-feira).
    expect(horaDaLinha(iso(22), AGORA, ptBR, "Ontem")).toBe("quinta-feira");
  });

  it("a partir de 7 dias: a data completa — o dia da semana já seria ambíguo", () => {
    expect(horaDaLinha(iso(21), AGORA, ptBR, "Ontem")).toBe("21/10/2026");
    expect(horaDaLinha(new Date(2025, 11, 31, 10, 0).toISOString(), AGORA, ptBR, "Ontem")).toBe(
      "31/12/2025",
    );
  });

  it("data no futuro (relógio do servidor adiantado): a data, nunca 'Ontem' nem um dia da semana", () => {
    expect(horaDaLinha(iso(30), AGORA, ptBR, "Ontem")).toBe("30/10/2026");
  });

  it("sem data ou data inválida: vazio, sem quebrar a linha", () => {
    expect(horaDaLinha(null, AGORA, ptBR, "Ontem")).toBe("");
    expect(horaDaLinha(undefined, AGORA, ptBR, "Ontem")).toBe("");
    expect(horaDaLinha("não é data", AGORA, ptBR, "Ontem")).toBe("");
  });
});

describe("tiqueDaUltima — só a nossa mensagem tem tique", () => {
  it.each([
    ["queued", "relogio"],
    ["sending", "relogio"],
    ["sent", "enviada"],
    ["delivered", "entregue"],
    ["read", "lida"],
    ["failed", "falhou"],
  ] as const)("outbound %s → %s", (status, tique) => {
    expect(tiqueDaUltima("outbound", status)).toBe(tique);
  });

  it("mensagem do cliente não tem tique, qualquer que seja o status", () => {
    for (const status of ["received", "delivered", "read", "sent", null]) {
      expect(tiqueDaUltima("inbound", status)).toBeNull();
    }
  });

  it("status desconhecido ou ausente: sem tique (calar é melhor que afirmar um estado que não se sabe)", () => {
    expect(tiqueDaUltima("outbound", "received")).toBeNull();
    expect(tiqueDaUltima("outbound", "algo-novo")).toBeNull();
    expect(tiqueDaUltima("outbound", null)).toBeNull();
    expect(tiqueDaUltima(null, "read")).toBeNull();
    expect(tiqueDaUltima(undefined, undefined)).toBeNull();
  });
});

describe("previaDaLinha — o que a linha mostra da última mensagem", () => {
  it("texto: o texto, e 'Você:' só quando fomos nós", () => {
    expect(previaDaLinha({ type: "text", preview: "bom dia", direction: "inbound" })).toEqual({
      voce: false,
      icone: null,
      trecho: "bom dia",
      rotulo: null,
    });
    expect(previaDaLinha({ type: "text", preview: "bom dia", direction: "outbound" }).voce).toBe(
      true,
    );
  });

  it("o literal [audio] do envio vira ícone + 'Áudio', não colchetes", () => {
    expect(previaDaLinha({ type: "audio", preview: "[audio]", direction: "outbound" })).toEqual({
      voce: true,
      icone: "audio",
      trecho: null,
      rotulo: "Áudio",
    });
  });

  it("os rótulos com emoji do canal oficial também não viram 'legenda'", () => {
    for (const [type, preview, icone, rotulo] of [
      ["audio", "🎤 Mensagem de voz", "audio", "Áudio"],
      ["audio", "🎵 Áudio", "audio", "Áudio"],
      ["image", "📷 Imagem", "imagem", "Foto"],
      ["video", "🎬 Vídeo", "video", "Vídeo"],
      ["document", "📎 Documento", "documento", "Documento"],
    ] as const) {
      expect(previaDaLinha({ type, preview, direction: "inbound" })).toMatchObject({
        icone,
        trecho: null,
        rotulo,
      });
    }
  });

  it("foto com legenda: o ícone E a legenda (como no WhatsApp)", () => {
    expect(
      previaDaLinha({ type: "image", preview: "olha o orçamento", direction: "inbound" }),
    ).toEqual({ voce: false, icone: "imagem", trecho: "olha o orçamento", rotulo: null });
  });

  it("contato compartilhado pelo canal oficial: o nome, sem o emoji que o canal pôs na frente", () => {
    expect(previaDaLinha({ type: "contact", preview: "👤 Maria", direction: "inbound" })).toEqual({
      voce: false,
      icone: "contato",
      trecho: "Maria",
      rotulo: null,
    });
    expect(previaDaLinha({ type: "contact", preview: "[contato]", direction: "inbound" })).toEqual({
      voce: false,
      icone: "contato",
      trecho: null,
      rotulo: "Contato",
    });
  });

  it("conversa sem o tipo (cache antigo, sem backfill): o literal [tipo] ainda é lido", () => {
    expect(previaDaLinha({ type: null, preview: "[image]", direction: null })).toMatchObject({
      icone: "imagem",
      rotulo: "Foto",
    });
    expect(previaDaLinha({ type: undefined, preview: "[sticker]", direction: undefined })).toMatchObject(
      { icone: "figurinha", rotulo: "Figurinha" },
    );
  });

  it("MAS se o banco diz que é texto, '[audio]' é o que a pessoa digitou", () => {
    expect(previaDaLinha({ type: "text", preview: "[audio]", direction: "inbound" })).toEqual({
      voce: false,
      icone: null,
      trecho: "[audio]",
      rotulo: null,
    });
  });

  it("tipo que não é mídia (reação, sistema, template) mostra o texto", () => {
    for (const type of ["reaction", "system", "template"]) {
      expect(previaDaLinha({ type, preview: "👍", direction: "inbound" })).toMatchObject({
        icone: null,
        trecho: "👍",
      });
    }
  });

  it("tipo vindo do banco que coincide com membro do protótipo não vira mídia", () => {
    expect(
      previaDaLinha({ type: "constructor", preview: "oi", direction: "inbound" }),
    ).toMatchObject({ icone: null, trecho: "oi" });
    expect(
      previaDaLinha({ type: "__proto__", preview: "oi", direction: "inbound" }),
    ).toMatchObject({ icone: null, trecho: "oi" });
  });

  it("sem texto e sem tipo: 'Sem mensagens'", () => {
    expect(previaDaLinha({ type: null, preview: "", direction: null })).toEqual({
      voce: false,
      icone: null,
      trecho: null,
      rotulo: "Sem mensagens",
    });
    expect(previaDaLinha({ type: null, preview: "   ", direction: null }).rotulo).toBe(
      "Sem mensagens",
    );
    expect(previaDaLinha({ type: null, preview: null, direction: null }).rotulo).toBe(
      "Sem mensagens",
    );
  });

  it("mídia sem texto nenhum (preview vazio) ainda mostra o nome do tipo", () => {
    expect(previaDaLinha({ type: "audio", preview: "", direction: "inbound" })).toMatchObject({
      icone: "audio",
      rotulo: "Áudio",
    });
  });
});
