import { describe, expect, it, vi } from "vitest";

import { ApiError } from "@/lib/api/types";
import {
  processarLembrete,
  type Alerta,
  type CompromissoDevido,
  type ConversaDeEnvio,
  type EnvioFeito,
  type EnvioPedido,
  type ModeloAprovado,
  type PortasDoLembrete,
} from "@/lib/agenda/lembrete/executar";

type Desfecho = Parameters<PortasDoLembrete["registrar"]>[1];

/**
 * O EXECUTOR DO LEMBRETE, PELAS PORTAS.
 *
 * Mora em `tests/unit/` (e não ao lado do código) por um motivo concreto: os casos
 * precisam dizer QUE canal está em jogo, e a catraca `lint:channels` proíbe nome de
 * provedor dentro de `lib/`. O código de produção só repassa o identificador a
 * `estadoDaJanela`; é o teste que o escolhe.
 *
 * Cenário-base: consulta segunda 26/10 às 14h (Brasília), lembrete 24 h antes, tick
 * no domingo às 14h05 — dentro do prazo e da cortesia.
 */

const AGORA = new Date("2026-10-25T17:05:00Z");
const ARMADO = new Date("2026-10-20T12:00:00Z");
const DEVIDO = { id: "ap-1", organizationId: "org-1" };

const COMPROMISSO: CompromissoDevido = {
  id: "ap-1",
  organizationId: "org-1",
  contactId: "ct-1",
  conversationId: null,
  startsAt: new Date("2026-10-26T17:00:00Z"),
  timeZone: "America/Sao_Paulo",
  localDoCompromisso: null,
  ownerUserId: "u-1",
  titulo: "Avaliação",
  tentativas: 0,
  armadoEm: ARMADO,
  armadoEmBruto: "2026-10-20T12:00:00.123456+00:00",
  detalheAtual: null,
  tipo: { id: "tp-1", nome: "Avaliação", minutosAntes: 1440, modelo: null, localPadrao: null },
  contato: { nome: "MARIA da Silva", semMensagens: false },
};

const MODELO_BOM: ModeloAprovado = {
  nome: "lembrete_consulta",
  idioma: "pt_BR",
  status: "APPROVED",
  formato: "POSITIONAL",
  componentes: [
    { type: "BODY", text: "Olá {{1}}! Seu horário: {{4}}, {{2}} às {{3}}, com {{5}}." },
    { type: "BUTTONS", buttons: [{ type: "QUICK_REPLY", text: "Confirmo" }] },
  ],
};

const CONVERSA_QR: ConversaDeEnvio = {
  id: "cv-1",
  canalNoAr: true,
  provedor: "waha",
  ultimaEntradaEm: null,
};
const CONVERSA_OFICIAL_FECHADA: ConversaDeEnvio = {
  id: "cv-2",
  canalNoAr: true,
  provedor: "meta_cloud",
  ultimaEntradaEm: new Date(AGORA.getTime() - 30 * 3_600_000).toISOString(),
};
const CONVERSA_OFICIAL_ABERTA: ConversaDeEnvio = {
  ...CONVERSA_OFICIAL_FECHADA,
  id: "cv-3",
  ultimaEntradaEm: new Date(AGORA.getTime() - 2 * 3_600_000).toISOString(),
};

interface Cenario {
  compromisso?: Partial<CompromissoDevido> | null;
  tipo?: Partial<CompromissoDevido["tipo"]>;
  conversa?: ConversaDeEnvio | null;
  modelo?: ModeloAprovado | null;
  jaEnviada?: { id: string } | null;
  ganhaAReivindicacao?: boolean;
  envio?: () => Promise<EnvioFeito>;
  agora?: Date;
}

function montar(c: Cenario = {}) {
  const base: CompromissoDevido | null =
    c.compromisso === null
      ? null
      : {
          ...COMPROMISSO,
          ...c.compromisso,
          tipo: { ...COMPROMISSO.tipo, ...c.tipo },
        };
  const portas = {
    agora: () => c.agora ?? AGORA,
    carregar: vi.fn(async () => base),
    nomeDoProfissional: vi.fn(async () => "Dra. Ana"),
    nomeDaClinica: vi.fn(async () => "Sorriso Perfeito"),
    conversaParaOContato: vi.fn(async () => (c.conversa === undefined ? CONVERSA_QR : c.conversa)),
    modeloAprovado: vi.fn(async () => (c.modelo === undefined ? null : c.modelo)),
    mensagemDaChave: vi.fn(async () => c.jaEnviada ?? null),
    reivindicar: vi.fn(async () => c.ganhaAReivindicacao ?? true),
    // Os parâmetros são tipados para `mock.calls[n]` devolver a tupla certa — um
    // `vi.fn(async () => …)` sem parâmetros dá `[]` e some com os argumentos.
    enviar: vi.fn(
      async (_organizacao: string, _pedido: EnvioPedido): Promise<EnvioFeito> =>
        (c.envio ?? (async () => ({ mensagemId: "msg-1", status: "sent", codigoDeErro: null })))(),
    ),
    registrar: vi.fn(async (_c: CompromissoDevido, _desfecho: Desfecho): Promise<void> => undefined),
    alertar: vi.fn(async (_organizacao: string, _alerta: Alerta): Promise<void> => undefined),
  } satisfies PortasDoLembrete;
  return portas;
}

describe("canal sem a regra das 24 h", () => {
  it("sem modelo no tipo: texto padrão, e o desfecho é enviado", async () => {
    const p = montar();
    expect(await processarLembrete(p, DEVIDO)).toBe("enviado");

    const [org, pedido] = p.enviar.mock.calls[0]!;
    expect(org).toBe("org-1");
    expect(pedido.modelo).toBeNull();
    expect(pedido.conversationId).toBe("cv-1");
    expect(pedido.corpo).toContain("Olá, Maria!");
    expect(pedido.corpo).toContain("segunda-feira, 26/10 às 14:00");
    expect(pedido.corpo).toContain("com Dra. Ana");
    expect(p.registrar).toHaveBeenCalledWith(expect.anything(), {
      estado: "sent",
      mensagemId: "msg-1",
      em: AGORA,
    });
  });

  it("com modelo aprovado: manda as palavras do modelo como texto (não há como mandar modelo)", async () => {
    const p = montar({ tipo: { modelo: "lembrete_consulta" }, modelo: MODELO_BOM });
    expect(await processarLembrete(p, DEVIDO)).toBe("enviado");

    const pedido = p.enviar.mock.calls[0]![1];
    expect(pedido.modelo).toBeNull();
    expect(pedido.corpo).toBe(
      "Olá Maria! Seu horário: Avaliação, segunda-feira, 26/10 às 14:00, com Dra. Ana.",
    );
    expect(p.alertar).not.toHaveBeenCalled();
  });

  it("modelo quebrado num canal que não exige modelo: ignora o modelo, manda o padrão, não alerta", async () => {
    const p = montar({ tipo: { modelo: "lembrete_consulta" }, modelo: null });
    expect(await processarLembrete(p, DEVIDO)).toBe("enviado");
    expect(p.enviar.mock.calls[0]![1].corpo).toContain("Lembrete do seu horário");
    expect(p.alertar).not.toHaveBeenCalled();
  });
});

describe("canal oficial, janela fechada", () => {
  it("com modelo aprovado: sai como MODELO, com os valores por slot e o corpo renderizado", async () => {
    const p = montar({
      tipo: { modelo: "lembrete_consulta" },
      modelo: MODELO_BOM,
      conversa: CONVERSA_OFICIAL_FECHADA,
    });
    expect(await processarLembrete(p, DEVIDO)).toBe("enviado");

    const pedido = p.enviar.mock.calls[0]![1];
    expect(pedido.modelo).toEqual({
      nome: "lembrete_consulta",
      idioma: "pt_BR",
      valores: {
        "1": "Maria",
        "2": "segunda-feira, 26/10",
        "3": "14:00",
        "4": "Avaliação",
        "5": "Dra. Ana",
      },
    });
    expect(pedido.corpo).toBe(
      "Olá Maria! Seu horário: Avaliação, segunda-feira, 26/10 às 14:00, com Dra. Ana.",
    );
  });

  it("sem modelo no tipo: NÃO envia, fica pending com o motivo e alerta o tipo (não o paciente)", async () => {
    const p = montar({ conversa: CONVERSA_OFICIAL_FECHADA });
    expect(await processarLembrete(p, DEVIDO)).toBe("esperando");

    expect(p.enviar).not.toHaveBeenCalled();
    expect(p.reivindicar).not.toHaveBeenCalled();
    expect(p.registrar).toHaveBeenCalledWith(expect.anything(), {
      estado: "pending",
      detalhe: "no_template",
    });
    const alerta = p.alertar.mock.calls[0]![1];
    expect(alerta.referencia).toEqual({ tipo: "event_type", id: "tp-1" });
    expect(alerta.titulo).toContain("falta um modelo aprovado");
    expect(alerta.corpo).toContain("Configurações → Tipos de agendamento");
  });

  it("modelo configurado que não existe no espelho: no_template:<nome>", async () => {
    const p = montar({
      tipo: { modelo: "lembrete_consulta" },
      modelo: null,
      conversa: CONVERSA_OFICIAL_FECHADA,
    });
    expect(await processarLembrete(p, DEVIDO)).toBe("esperando");
    expect(p.registrar).toHaveBeenCalledWith(expect.anything(), {
      estado: "pending",
      detalhe: "no_template:lembrete_consulta",
    });
    expect(p.alertar.mock.calls[0]![1].corpo).toContain("«lembrete_consulta»");
  });

  it("modelo ainda em análise (PENDING) não serve — o status vai no motivo", async () => {
    const p = montar({
      tipo: { modelo: "lembrete_consulta" },
      modelo: { ...MODELO_BOM, status: "PENDING" },
      conversa: CONVERSA_OFICIAL_FECHADA,
    });
    expect(await processarLembrete(p, DEVIDO)).toBe("esperando");
    expect(p.registrar).toHaveBeenCalledWith(expect.anything(), {
      estado: "pending",
      detalhe: "no_template:lembrete_consulta:PENDING",
    });
    expect(p.enviar).not.toHaveBeenCalled();
  });

  it("modelo com variável desconhecida: template_slot:<slot>, nunca manda `{{7}}` cru", async () => {
    const p = montar({
      tipo: { modelo: "m" },
      modelo: {
        ...MODELO_BOM,
        nome: "m",
        componentes: [{ type: "BODY", text: "{{1}} {{2}} {{3}} {{4}} {{5}} {{6}} {{7}}" }],
      },
      conversa: CONVERSA_OFICIAL_FECHADA,
    });
    expect(await processarLembrete(p, DEVIDO)).toBe("esperando");
    expect(p.registrar).toHaveBeenCalledWith(expect.anything(), {
      estado: "pending",
      detalhe: "template_slot:7",
    });
    expect(p.alertar.mock.calls[0]![1].titulo).toContain("variável desconhecida");
    expect(p.enviar).not.toHaveBeenCalled();
  });

  it("não reescreve o detalhe a cada tick quando ele não mudou (mas segue alertando — o alerta deduplica)", async () => {
    const p = montar({
      compromisso: { detalheAtual: "no_template" },
      conversa: CONVERSA_OFICIAL_FECHADA,
    });
    expect(await processarLembrete(p, DEVIDO)).toBe("esperando");
    expect(p.registrar).not.toHaveBeenCalled();
    expect(p.alertar).toHaveBeenCalledTimes(1);
  });
});

describe("canal oficial, janela aberta", () => {
  it("com modelo aprovado: ainda prefere o MODELO (texto aprovado, com botões)", async () => {
    const p = montar({
      tipo: { modelo: "lembrete_consulta" },
      modelo: MODELO_BOM,
      conversa: CONVERSA_OFICIAL_ABERTA,
    });
    expect(await processarLembrete(p, DEVIDO)).toBe("enviado");
    expect(p.enviar.mock.calls[0]![1].modelo?.nome).toBe("lembrete_consulta");
  });

  it("sem modelo: texto livre é permitido, o paciente recebe, e nada alerta", async () => {
    const p = montar({ conversa: CONVERSA_OFICIAL_ABERTA });
    expect(await processarLembrete(p, DEVIDO)).toBe("enviado");
    expect(p.enviar.mock.calls[0]![1].modelo).toBeNull();
    expect(p.alertar).not.toHaveBeenCalled();
  });

  it("modelo quebrado: o paciente recebe o texto padrão E a equipe é avisada do cadastro", async () => {
    const p = montar({
      tipo: { modelo: "lembrete_consulta" },
      modelo: null,
      conversa: CONVERSA_OFICIAL_ABERTA,
    });
    expect(await processarLembrete(p, DEVIDO)).toBe("enviado");
    expect(p.enviar.mock.calls[0]![1].modelo).toBeNull();
    expect(p.alertar).toHaveBeenCalledTimes(1);
  });
});

describe("a decisão pura manda", () => {
  it("tarde demais: skipped, sem procurar conversa nem enviar", async () => {
    const p = montar({ agora: new Date("2026-10-26T16:30:00Z") }); // faltam 30 min
    expect(await processarLembrete(p, DEVIDO)).toBe("pulado");
    expect(p.registrar).toHaveBeenCalledWith(expect.anything(), {
      estado: "skipped",
      detalhe: "late",
    });
    expect(p.conversaParaOContato).not.toHaveBeenCalled();
    expect(p.enviar).not.toHaveBeenCalled();
  });

  it("marcado depois do momento devido: skipped booked_inside_horizon", async () => {
    // O momento devido é 25/10 às 17:00Z (24 h antes de 26/10 17:00Z): armado nele ou depois.
    const p = montar({ compromisso: { armadoEm: new Date("2026-10-25T17:00:00Z") } });
    expect(await processarLembrete(p, DEVIDO)).toBe("pulado");
    expect(p.registrar).toHaveBeenCalledWith(expect.anything(), {
      estado: "skipped",
      detalhe: "booked_inside_horizon",
    });
  });

  it("contato que pediu para não receber: skipped blocked", async () => {
    const p = montar({ compromisso: { contato: { nome: "Ana", semMensagens: true } } });
    expect(await processarLembrete(p, DEVIDO)).toBe("pulado");
    expect(p.registrar).toHaveBeenCalledWith(expect.anything(), {
      estado: "skipped",
      detalhe: "blocked",
    });
    expect(p.enviar).not.toHaveBeenCalled();
  });

  it("fora do horário de cortesia: espera e anota o motivo uma vez só", async () => {
    // Consulta segunda às 06:30 locais ⇒ lembrete devido domingo às 06:30; o tick
    // das 06:45 ainda está antes das 7h da cortesia.
    const comeca = new Date("2026-10-26T09:30:00Z");
    const agora = new Date("2026-10-25T09:45:00Z");
    const p = montar({ compromisso: { startsAt: comeca }, agora });
    expect(await processarLembrete(p, DEVIDO)).toBe("esperando");
    expect(p.registrar).toHaveBeenCalledWith(expect.anything(), {
      estado: "pending",
      detalhe: "outside_courtesy_hours",
    });

    const repetido = montar({
      compromisso: { startsAt: comeca, detalheAtual: "outside_courtesy_hours" },
      agora,
    });
    expect(await processarLembrete(repetido, DEVIDO)).toBe("esperando");
    expect(repetido.registrar).not.toHaveBeenCalled();
  });
});

describe("canal ou conversa indisponível", () => {
  it("canal fora do ar: espera, anota channel_down, não reivindica", async () => {
    const p = montar({ conversa: { ...CONVERSA_QR, canalNoAr: false } });
    expect(await processarLembrete(p, DEVIDO)).toBe("esperando");
    expect(p.registrar).toHaveBeenCalledWith(expect.anything(), {
      estado: "pending",
      detalhe: "channel_down",
    });
    expect(p.reivindicar).not.toHaveBeenCalled();
  });

  it("sem nenhuma conversa possível: o mesmo", async () => {
    const p = montar({ conversa: null });
    expect(await processarLembrete(p, DEVIDO)).toBe("esperando");
    expect(p.enviar).not.toHaveBeenCalled();
  });

  it("compromisso que sumiu ou já tem desfecho: ignorado, nada é tocado", async () => {
    const p = montar({ compromisso: null });
    expect(await processarLembrete(p, DEVIDO)).toBe("ignorado");
    expect(p.registrar).not.toHaveBeenCalled();
  });
});

describe("idempotência", () => {
  it("a chave carrega o compromisso E o momento em que foi armado (remarcar gera outra)", async () => {
    const p = montar();
    await processarLembrete(p, DEVIDO);
    expect(p.enviar.mock.calls[0]![1].chave).toBe(`lembrete:ap-1:${ARMADO.getTime()}`);
    // E a busca pela chave é escopada à conversa do envio (messages.metadata não tem índice).
    expect(p.mensagemDaChave).toHaveBeenCalledWith(
      expect.objectContaining({ id: "ap-1" }),
      "cv-1",
      `lembrete:ap-1:${ARMADO.getTime()}`,
    );
  });

  it("queda entre enviar e carimbar: o tick seguinte acha a mensagem e SÓ carimba", async () => {
    const p = montar({ jaEnviada: { id: "msg-antiga" } });
    expect(await processarLembrete(p, DEVIDO)).toBe("enviado");
    expect(p.enviar).not.toHaveBeenCalled();
    expect(p.reivindicar).not.toHaveBeenCalled();
    expect(p.registrar).toHaveBeenCalledWith(expect.anything(), {
      estado: "sent",
      mensagemId: "msg-antiga",
      em: AGORA,
    });
  });

  it("perdeu a reivindicação (outro tick ganhou): não envia", async () => {
    const p = montar({ ganhaAReivindicacao: false });
    expect(await processarLembrete(p, DEVIDO)).toBe("ignorado");
    expect(p.enviar).not.toHaveBeenCalled();
    expect(p.registrar).not.toHaveBeenCalled();
  });
});

describe("quando o envio falha", () => {
  const recusa: () => Promise<EnvioFeito> = async () => ({
    mensagemId: "msg-x",
    status: "failed",
    codigoDeErro: "131047",
  });

  it("primeira e segunda tentativa: continua pending, com o código no detalhe", async () => {
    for (const anteriores of [0, 1]) {
      const p = montar({ compromisso: { tentativas: anteriores }, envio: recusa });
      expect(await processarLembrete(p, DEVIDO)).toBe("esperando");
      expect(p.registrar).toHaveBeenCalledWith(expect.anything(), {
        estado: "pending",
        detalhe: "send_failed:131047",
      });
      expect(p.alertar).not.toHaveBeenCalled();
    }
  });

  it("terceira tentativa: failed e alerta no compromisso", async () => {
    const p = montar({ compromisso: { tentativas: 2 }, envio: recusa });
    expect(await processarLembrete(p, DEVIDO)).toBe("falhou");
    expect(p.registrar).toHaveBeenCalledWith(expect.anything(), {
      estado: "failed",
      detalhe: "send_failed:131047",
    });
    const alerta = p.alertar.mock.calls[0]![1];
    expect(alerta.referencia).toEqual({ tipo: "appointment", id: "ap-1" });
    expect(alerta.corpo).toContain("MARIA da Silva");
    expect(alerta.corpo).toContain("131047");
  });

  it("mensagem que ficou na fila do canal conta como tentativa fracassada, com o prefixo certo", async () => {
    const p = montar({
      envio: async () => ({ mensagemId: "msg-q", status: "queued", codigoDeErro: null }),
    });
    expect(await processarLembrete(p, DEVIDO)).toBe("esperando");
    expect(p.registrar).toHaveBeenCalledWith(expect.anything(), {
      estado: "pending",
      detalhe: "queued:?",
    });
  });

  it("erro inesperado do handler também conta tentativa — e a terceira falha, não lança", async () => {
    const quebra = async () => {
      throw new Error("conexão caiu");
    };
    const p = montar({ compromisso: { tentativas: 2 }, envio: quebra });
    await expect(processarLembrete(p, DEVIDO)).resolves.toBe("falhou");
    expect(p.registrar).toHaveBeenCalledWith(expect.anything(), {
      estado: "failed",
      detalhe: "send_error",
    });
  });

  it("403 do handler (contato bloqueou no meio do caminho): skipped, sem alerta", async () => {
    const p = montar({
      envio: async () => {
        throw new ApiError(403, "forbidden", undefined, "req", "Contato bloqueou o atendimento.");
      },
    });
    expect(await processarLembrete(p, DEVIDO)).toBe("pulado");
    expect(p.registrar).toHaveBeenCalledWith(expect.anything(), {
      estado: "skipped",
      detalhe: "blocked",
    });
    expect(p.alertar).not.toHaveBeenCalled();
  });
});
