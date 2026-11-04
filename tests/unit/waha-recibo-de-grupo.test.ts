// @vitest-environment node
/**
 * OS TIQUES DE UMA MENSAGEM DE GRUPO: o recibo de cada participante, e quando a mensagem vira "entregue" e "lida".
 *
 * Contexto medido (produção, 04/11/2026): em grupo o WAHA/NOWEB não manda recibo em `message.ack` — manda em
 * `message.ack.group`, um por participante, com a pessoa em `_data.receipt.userJid` e o `id` terminando na NOSSA conta.
 * O CRM não assinava esse evento, então o tique de grupo nunca passava de "enviada".
 *
 * Regra provada aqui: entregue = alguém do grupo recebeu; lida = TODOS os outros participantes leram; se a lista de
 * participantes não pode ser lida, nunca vira lida.
 */
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import {
  aplicarReciboDeGrupo,
  esquecerParticipantes,
  lerIdDoAck,
  lerRecibos,
  quemMandouORecibo,
  somarRecibo,
  statusDosRecibos,
  tipoDoRecibo,
  type CanalDeParticipantes,
} from "@/lib/waha/recibo-de-grupo";
import type { WahaPayload } from "@/lib/waha/envelope";

const ORG = "org-1";
const SESSAO = { organization_id: ORG, waha_session_name: "org_x" };
const GRUPO = "120363999999999999@g.us";
const NOSSA = "5511900000000@lid";
const EXTERNAL = "3EB0A1B2C3";
const ID_NO_ACK = `true_${GRUPO}_${EXTERNAL}_${NOSSA}`; // o participante do id é a NOSSA conta

type Linha = Record<string, unknown>;

interface Banco {
  messages: Linha[];
  /** Roda depois de uma leitura e antes da escrita seguinte: a janela da corrida. */
  aoLer?: () => void;
}

function criarBanco(messages: Linha[]): { admin: never; banco: Banco } {
  const banco: Banco = { messages };
  const tabela = () => {
    const filtros: Array<(l: Linha) => boolean> = [];
    let modo: "select" | "update" = "select";
    let patch: Linha = {};
    const casadas = () => banco.messages.filter((l) => filtros.every((f) => f(l)));
    const executar = () => {
      if (modo === "update") {
        const alvo = casadas();
        for (const l of alvo) Object.assign(l, patch);
        return { data: alvo.map((l) => ({ id: l.id })), error: null };
      }
      const lidas = casadas().map((l) => ({ ...l }));
      banco.aoLer?.();
      return { data: lidas, error: null };
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cadeia: any = {
      select: () => cadeia,
      update: (p: Linha) => ((modo = "update"), (patch = p), cadeia),
      eq: (c: string, v: unknown) => (filtros.push((l) => l[c] === v), cadeia),
      in: (c: string, vs: unknown[]) => (filtros.push((l) => vs.includes(l[c])), cadeia),
      then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
        Promise.resolve(executar()).then(resolve, reject),
    };
    return cadeia;
  };
  return { admin: { from: () => tabela() } as never, banco };
}

let relogio = 0;
function mensagem(status: string, extra: Linha = {}): Linha {
  return {
    id: "msg-1",
    organization_id: ORG,
    external_id: EXTERNAL,
    direction: "outbound",
    status,
    ack: null,
    delivered_at: null,
    read_at: null,
    error_code: null,
    error_message: null,
    metadata: {},
    updated_at: `t${++relogio}`,
    ...extra,
  };
}

function participantes(n: number): CanalDeParticipantes & { chamadas: number } {
  const canal = {
    chamadas: 0,
    getGroupParticipants: async () => {
      canal.chamadas += 1;
      return Array.from({ length: n }, (_, i) => ({ id: `55119000000${i}@lid` }));
    },
  };
  return canal;
}

const recibo = (ack: number, quem: string | null, id = ID_NO_ACK): WahaPayload =>
  ({ id, ack, ackName: "X", fromMe: true, _data: quem ? { receipt: { userJid: quem } } : {} }) as WahaPayload;

const um = (b: { banco: Banco }) => b.banco.messages[0] as Linha;

beforeEach(() => {
  esquecerParticipantes();
  relogio = 0;
});

describe("peças puras", () => {
  it("lê o id composto com e sem participante, e o id cru do envio", () => {
    expect(lerIdDoAck(ID_NO_ACK)).toEqual({ chatId: GRUPO, mensagemId: EXTERNAL, participante: NOSSA });
    expect(lerIdDoAck(`true_${GRUPO}_${EXTERNAL}`)).toEqual({ chatId: GRUPO, mensagemId: EXTERNAL, participante: null });
    expect(lerIdDoAck(EXTERNAL)).toEqual({ chatId: null, mensagemId: EXTERNAL, participante: null });
  });

  it("1 e 2 são 'chegou'; 3 e 4 são 'leu'; erro e pendente não são recibo", () => {
    expect([1, 2].map(tipoDoRecibo)).toEqual(["entregue", "entregue"]);
    expect([3, 4].map(tipoDoRecibo)).toEqual(["lido", "lido"]);
    expect([-1, 0, null, undefined, 9].map(tipoDoRecibo)).toEqual([null, null, null, null, null]);
  });

  it("quem recebeu vem de _data.receipt.userJid, não do id", () => {
    expect(quemMandouORecibo(recibo(1, "5511911111111@lid"))).toBe("5511911111111@lid");
    expect(quemMandouORecibo(recibo(1, null))).toBeNull();
  });

  it("o mesmo participante lendo duas vezes conta uma vez", () => {
    let r = lerRecibos({});
    r = somarRecibo(r, "a@lid", "lido");
    r = somarRecibo(r, "a@lid", "lido");
    expect(r.lidos).toEqual(["a@lid"]);
  });

  it("lida só quando TODOS os outros leram; entregue quando alguém recebeu; sem lista, nunca lida", () => {
    const leu = (...q: string[]) => ({ entregues: [], lidos: q });
    expect(statusDosRecibos(leu("a"), 3)).toBe("delivered");
    expect(statusDosRecibos(leu("a", "b"), 3)).toBe("delivered");
    expect(statusDosRecibos(leu("a", "b", "c"), 3)).toBe("read");
    expect(statusDosRecibos(leu("a", "b", "c"), null)).toBe("delivered");
    expect(statusDosRecibos({ entregues: [], lidos: [] }, 1)).toBeNull();
    expect(statusDosRecibos({ entregues: ["a"], lidos: [] }, 1)).toBe("delivered");
  });
});

describe("aplicarReciboDeGrupo — a mensagem anda pelos tiques", () => {
  it("grupo de 2 (nós + 1): a pessoa recebe → entregue; lê → lida", async () => {
    const b = criarBanco([mensagem("sent", { ack: 0 })]);
    const canal = participantes(2);

    await aplicarReciboDeGrupo(b.admin, SESSAO, recibo(1, "5511911111111@lid"), canal);
    expect(um(b).status).toBe("delivered");
    expect(um(b).delivered_at).toEqual(expect.any(String));
    expect(um(b).read_at).toBeNull();

    await aplicarReciboDeGrupo(b.admin, SESSAO, recibo(3, "5511911111111@lid"), canal);
    expect(um(b).status).toBe("read");
    expect(um(b).read_at).toEqual(expect.any(String));
  });

  it("grupo de 4 (3 outros): lida só quando os 3 leram; um participante lendo de novo não adianta", async () => {
    const b = criarBanco([mensagem("sent")]);
    const canal = participantes(4);

    await aplicarReciboDeGrupo(b.admin, SESSAO, recibo(3, "a@lid"), canal);
    await aplicarReciboDeGrupo(b.admin, SESSAO, recibo(3, "a@lid"), canal);
    await aplicarReciboDeGrupo(b.admin, SESSAO, recibo(3, "b@lid"), canal);
    expect(um(b).status).toBe("delivered"); // 2 de 3

    await aplicarReciboDeGrupo(b.admin, SESSAO, recibo(4, "c@lid"), canal); // 4 = ouviu: também leu
    expect(um(b).status).toBe("read");
  });

  it("a lista de participantes é lida uma vez por grupo (cache), não a cada recibo", async () => {
    const b = criarBanco([mensagem("sent")]);
    const canal = participantes(4);
    await aplicarReciboDeGrupo(b.admin, SESSAO, recibo(3, "a@lid"), canal);
    await aplicarReciboDeGrupo(b.admin, SESSAO, recibo(3, "b@lid"), canal);
    expect(canal.chamadas).toBe(1);
  });

  it("sem conseguir ler os participantes, a mensagem NUNCA vira lida (fica entregue)", async () => {
    const b = criarBanco([mensagem("sent")]);
    const quebrado: CanalDeParticipantes = {
      getGroupParticipants: async () => {
        throw new Error("waha_500");
      },
    };
    await aplicarReciboDeGrupo(b.admin, SESSAO, recibo(3, "a@lid"), quebrado);
    expect(um(b).status).toBe("delivered");
    await aplicarReciboDeGrupo(b.admin, SESSAO, recibo(3, "b@lid"), null);
    expect(um(b).status).toBe("delivered");
  });

  it("mensagem que ficou 'Falhou' por engano e depois recebe recibo é CURADA, sem o erro", async () => {
    const b = criarBanco([mensagem("failed", { ack: -1, error_code: "waha_ack_error", error_message: "x" })]);
    await aplicarReciboDeGrupo(b.admin, SESSAO, recibo(1, "a@lid"), participantes(3));
    expect(um(b).status).toBe("delivered");
    expect(um(b).error_code).toBeNull();
    expect(um(b).error_message).toBeNull();
  });

  it("o status nunca anda para trás: lida + recibo de entrega atrasado continua lida", async () => {
    const b = criarBanco([mensagem("read", { ack: 3 })]);
    await aplicarReciboDeGrupo(b.admin, SESSAO, recibo(1, "a@lid"), participantes(2));
    expect(um(b).status).toBe("read");
    expect(um(b).ack).toBe(3);
  });

  it("recibo que não muda nada não regrava a linha", async () => {
    const b = criarBanco([mensagem("sent", { metadata: { recibos_de_grupo: { entregues: [], lidos: ["a@lid"] } }, ack: 2, status: "delivered" })]);
    const antes = um(b).updated_at;
    await aplicarReciboDeGrupo(b.admin, SESSAO, recibo(3, "a@lid"), participantes(3));
    expect(um(b).updated_at).toBe(antes);
  });

  it("corrida: dois recibos lidos do mesmo estado — nenhum se perde (compare-and-set)", async () => {
    const b = criarBanco([mensagem("sent")]);
    const canal = participantes(3); // 2 outros
    let primeiraLeitura = true;
    b.banco.aoLer = () => {
      if (!primeiraLeitura) return;
      primeiraLeitura = false;
      // enquanto este recibo ('a') decide, o de 'b' chega e grava primeiro
      const m = um(b);
      m.metadata = { recibos_de_grupo: { entregues: [], lidos: ["b@lid"] } };
      m.updated_at = "mexeram";
    };
    await aplicarReciboDeGrupo(b.admin, SESSAO, recibo(3, "a@lid"), canal);
    expect(lerRecibos(um(b).metadata).lidos.sort()).toEqual(["a@lid", "b@lid"]);
    expect(um(b).status).toBe("read"); // os 2 outros leram
  });

  it("mensagem de ENTRADA e ack de erro/pendente são ignorados; mensagem desconhecida não quebra", async () => {
    const entrada = criarBanco([mensagem("received", { direction: "inbound" })]);
    expect(await aplicarReciboDeGrupo(entrada.admin, SESSAO, recibo(3, "a@lid"), participantes(2))).toBe("sem_mensagem");
    expect(um(entrada).status).toBe("received");

    const b = criarBanco([mensagem("sent")]);
    expect(await aplicarReciboDeGrupo(b.admin, SESSAO, recibo(-1, "a@lid"), participantes(2))).toBe("sem_efeito");
    expect(await aplicarReciboDeGrupo(b.admin, SESSAO, recibo(0, "a@lid"), participantes(2))).toBe("sem_efeito");
    expect(um(b).status).toBe("sent");
    expect(await aplicarReciboDeGrupo(b.admin, SESSAO, recibo(1, "a@lid", `true_${GRUPO}_OUTRA_${NOSSA}`), participantes(2))).toBe("sem_mensagem");
  });

  it("só enxerga a própria organização", async () => {
    const b = criarBanco([mensagem("sent", { organization_id: "org-de-outro" })]);
    expect(await aplicarReciboDeGrupo(b.admin, SESSAO, recibo(3, "a@lid"), participantes(2))).toBe("sem_mensagem");
    expect(um(b).status).toBe("sent");
  });
});

describe("a ligação com o resto do sistema", () => {
  it("o despacho do webhook entrega 'message.ack.group' a este módulo", () => {
    const ingest = readFileSync("lib/waha/ingest.ts", "utf8");
    expect(ingest).toMatch(/eventType === "message\.ack\.group"[\s\S]{0,300}aplicarReciboDeGrupo/);
  });
});
