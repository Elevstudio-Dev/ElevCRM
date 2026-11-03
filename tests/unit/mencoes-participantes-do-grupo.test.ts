import { describe, expect, it } from "vitest";

import { limparNomeDeParticipante, nomesDasMensagens, participantesParaATela } from "@/lib/mencoes/participantes-do-grupo";
import { normalizarParticipantes, telefoneDoParticipante } from "@/lib/waha/participantes";

describe("normalizarParticipantes — as formas que o WAHA entrega", () => {
  it("participants/v2: [{ id, role }]", () => {
    expect(
      normalizarParticipantes([
        { id: "5511999990001@c.us", role: "participant" },
        { id: "5511999990002@c.us", role: "admin" },
        { id: "5511999990003@c.us", role: "superadmin" },
      ]),
    ).toEqual([
      { id: "5511999990001@c.us", pn: null, admin: false },
      { id: "5511999990002@c.us", pn: null, admin: true },
      { id: "5511999990003@c.us", pn: null, admin: true },
    ]);
  });

  it("quem saiu do grupo (role 'left') não é marcável", () => {
    expect(normalizarParticipantes([{ id: "5511999990001@c.us", role: "left" }])).toEqual([]);
  });

  it("o objeto do grupo: id como { _serialized } e admin como 'admin' | null | booleano", () => {
    const r = normalizarParticipantes([
      { id: { _serialized: "5511999990001@c.us" }, admin: null },
      { id: "5511999990002@c.us", admin: "superadmin" },
      { id: "5511999990003@c.us", isAdmin: true },
    ]);
    expect(r.map((p) => p.admin)).toEqual([false, true, true]);
    expect(r.map((p) => p.id)).toEqual(["5511999990001@c.us", "5511999990002@c.us", "5511999990003@c.us"]);
  });

  it("aceita um mapa indexado pelo id, como o NOWEB devolve os grupos", () => {
    const r = normalizarParticipantes({ a: { id: "5511999990001@c.us" }, b: { id: "5511999990002@c.us" } });
    expect(r).toHaveLength(2);
  });

  it("@lid com telefone (`pn` ou `phoneNumber`): guarda só os dígitos do telefone", () => {
    const r = normalizarParticipantes([
      { id: "117137179947104@lid", pn: "5511999990001@s.whatsapp.net" },
      { id: "227137179947105@lid", phoneNumber: "+55 11 99999-0002" },
    ]);
    expect(r.map((p) => p.pn)).toEqual(["5511999990001", "5511999990002"]);
  });

  it("descarta o que não é endereço de pessoa: o próprio grupo, id vazio, lixo — e repetidos", () => {
    const r = normalizarParticipantes([
      { id: "120363401969475450@g.us" },
      { id: "" },
      { id: 42 },
      null,
      "texto",
      { id: "5511999990001@c.us" },
      { id: "5511999990001@c.us" },
    ]);
    expect(r).toEqual([{ id: "5511999990001@c.us", pn: null, admin: false }]);
  });

  it("resposta que não é lista nem mapa: nada", () => {
    expect(normalizarParticipantes(null)).toEqual([]);
    expect(normalizarParticipantes("erro")).toEqual([]);
  });
});

describe("telefoneDoParticipante — o telefone só quando ele existe de verdade", () => {
  it("@c.us tem o número no próprio endereço", () => {
    expect(telefoneDoParticipante({ id: "5511999990001@c.us", pn: null, admin: false })).toBe("5511999990001");
  });
  it("@lid COM pn: o pn", () => {
    expect(telefoneDoParticipante({ id: "117137179947104@lid", pn: "5511999990001", admin: false })).toBe("5511999990001");
  });
  it("@lid SEM pn: null — o número de um @lid NÃO é telefone", () => {
    expect(telefoneDoParticipante({ id: "117137179947104@lid", pn: null, admin: false })).toBeNull();
  });
});

describe("limparNomeDeParticipante — o nome é texto de terceiro", () => {
  it("tira quebra de linha, controle e o @ da frente; limita o tamanho", () => {
    expect(limparNomeDeParticipante("  @@Maria\nSouza\t ")).toBe("Maria Souza");
    expect(limparNomeDeParticipante("a".repeat(100))).toHaveLength(40);
  });
  it("vazio, só espaços e não-texto viram null", () => {
    expect(limparNomeDeParticipante("   ")).toBeNull();
    expect(limparNomeDeParticipante("@")).toBeNull();
    expect(limparNomeDeParticipante(undefined)).toBeNull();
    expect(limparNomeDeParticipante(42)).toBeNull();
  });
});

describe("nomesDasMensagens", () => {
  it("o nome mais RECENTE de cada pessoa vence (a lista vem da mais nova para a mais antiga)", () => {
    const m = nomesDasMensagens([
      { grupo_participante: "5511999990001@c.us", grupo_participante_nome: "Maria Souza" },
      { grupo_participante: "5511999990001@c.us", grupo_participante_nome: "Mari" },
      { grupo_participante: "117137179947104@lid", grupo_participante_nome: "Cliente Lid" },
    ]);
    expect(m.get("5511999990001")).toBe("Maria Souza");
    expect(m.get("117137179947104")).toBe("Cliente Lid");
  });

  it("ignora linha sem participante, sem nome ou sem metadata", () => {
    expect(nomesDasMensagens([null, undefined, {}, { grupo_participante: "55@c.us" }, { grupo_participante_nome: "X" }]).size).toBe(0);
  });
});

describe("participantesParaATela", () => {
  const nomes = new Map([["5511999990001", "Maria Souza"]]);

  it("o nome conhecido vence; sem nome, o telefone; sem telefone, um número curto que distingue", () => {
    const r = participantesParaATela(
      [
        { jid: "5511999990001@c.us", phone: "5511999990001", admin: false },
        { jid: "5511999990002@c.us", phone: "5511999990002", admin: false },
        { jid: "117137179947104@lid", phone: null, admin: false },
      ],
      nomes,
    );
    expect(r.map((p) => p.nome)).toEqual(["Maria Souza", "+5511999990002", "Participante 947104"]);
  });

  it("o nome vem pelo telefone também, quando o endereço é @lid e o WAHA disse o telefone", () => {
    const r = participantesParaATela([{ jid: "117137179947104@lid", phone: "5511999990001", admin: false }], nomes);
    expect(r[0]!.nome).toBe("Maria Souza");
  });

  it("duas pessoas com o MESMO nome ganham os últimos dígitos — o rótulo do texto é a chave", () => {
    const r = participantesParaATela(
      [
        { jid: "5511999990001@c.us", phone: "5511999990001", admin: false },
        { jid: "5511999990009@c.us", phone: "5511999990009", admin: false },
      ],
      new Map([
        ["5511999990001", "Maria"],
        ["5511999990009", "Maria"],
      ]),
    );
    expect(r.map((p) => p.nome).sort()).toEqual(["Maria ·0001", "Maria ·0009"]);
    expect(new Set(r.map((p) => p.nome)).size).toBe(2);
  });

  it("quem tem nome vem primeiro, em ordem alfabética", () => {
    const r = participantesParaATela(
      [
        { jid: "5511999990009@c.us", phone: "5511999990009", admin: false },
        { jid: "5511999990003@c.us", phone: "5511999990003", admin: false },
        { jid: "5511999990001@c.us", phone: "5511999990001", admin: false },
      ],
      new Map([
        ["5511999990003", "Zélia"],
        ["5511999990001", "Ana"],
      ]),
    );
    expect(r.map((p) => p.nome)).toEqual(["Ana", "Zélia", "+5511999990009"]);
  });

  it("carrega o admin e o telefone adiante", () => {
    const r = participantesParaATela([{ jid: "5511999990001@c.us", phone: "5511999990001", admin: true }], nomes);
    expect(r[0]).toEqual({ jid: "5511999990001@c.us", nome: "Maria Souza", telefone: "5511999990001", admin: true, conhecido: true });
  });

  it("`conhecido` só quando o nome veio do que a pessoa disse no grupo — telefone e número curto não contam", () => {
    const r = participantesParaATela(
      [
        { jid: "5511999990001@c.us", phone: "5511999990001", admin: false },
        { jid: "5511999990002@c.us", phone: "5511999990002", admin: false },
        { jid: "117137179947104@lid", phone: null, admin: false },
      ],
      nomes,
    );
    expect(r.map((p) => [p.nome, p.conhecido])).toEqual([
      ["Maria Souza", true],
      ["+5511999990002", false],
      ["Participante 947104", false],
    ]);
  });
});
