/**
 * O ACK DO WAHA: -1 É FALHA (não "enviando"), E O STATUS NUNCA ANDA PARA TRÁS.
 *
 * ─── O que aconteceu (produção, medido em leitura) ──────────────────────────
 *
 * Texto de atendente enviado a um GRUPO ficava `status=failed`, `ack=-1`, com
 * `external_id` preenchido e `error_code=send_timeout` — com a sessão WORKING.
 * 7 de 12 textos em grupo, em 7 dias; conversas 1:1, todas ok.
 *
 * Causa no código: `ackToStatus` só conhecia ack 0..3. O WAHA usa
 *   -1 ERROR · 0 PENDING · 1 SERVER · 2 DEVICE · 3 READ · 4 PLAYED
 * e o -1 caía no último `return "sending"`. O relógio continuava rodando, e 5
 * min depois o cron `recover-stuck-messages` carimbava "Envio não confirmado
 * em 5 min" / `send_timeout` — escondendo que quem recusou foi o WhatsApp.
 *
 * Além disso `handleAck` gravava `{ack, status}` sem olhar o que já estava
 * lá: um ack menor que chegasse depois (eventos fora de ordem) regredia
 * read → sent.
 *
 * ─── O que este arquivo prova, e o que NÃO prova ────────────────────────────
 *
 * PROVA, pelo `dispatchWahaEvent` real (banco substituído por um dublê COM
 * ESTADO, que filtra de verdade por `eq`/`in` e aplica o `update`): o que o
 * `handleAck` grava para cada ack, em cada estado de partida.
 *
 * NÃO prova: por que o WAHA/NOWEB devolve ack -1 só em grupo. Isso é desconhecido
 * (hipótese, não causa) — o teste só garante que, quando o -1 chega, o CRM
 * conta a verdade em vez de esperar 5 min para inventar um "timeout".
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const envMock: Record<string, string> = {
  ANTHROPIC_API_KEY: "sk-ant-teste",
  AI_GATEWAY_API_KEY: "",
  AI_GATEWAY_BASE_URL: "",
  OPENROUTER_API_KEY: "",
  OPENROUTER_BASE_URL: "",
  OPENAI_API_KEY: "",
};
vi.mock("@/lib/env", () => ({
  get env() {
    return envMock;
  },
}));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => {}), isServiceRoleConfigured: () => false }));
vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/channels/health", () => ({ sincronizarSaudeDaConexao: vi.fn(async () => {}) }));

import { dispatchWahaEvent } from "@/lib/waha/ingest";

const ORG = "org-1";
const SESSION = { id: "sess-1", organization_id: ORG, is_warmup_complete: true, warmup_started_at: null };

type Linha = Record<string, unknown>;

interface Banco {
  messages: Linha[];
  avisos: Linha[];
  eventos: Array<Record<string, unknown>>;
  /** Todo UPDATE em `messages` que o código tentou — mesmo o que não casou. */
  updates: Linha[];
  /** Roda logo DEPOIS de uma leitura em `messages` e ANTES da escrita seguinte: a janela da corrida. */
  aoLer?: () => void;
}

/**
 * Dublê com ESTADO. `eq`/`in`/`gte` filtram de verdade; `update` só altera as
 * linhas que casam. Um dublê que devolve sempre `{data:null}` aprovaria um
 * `handleAck` que não olha o estado — que é exatamente o defeito medido.
 */
function criarBanco(messages: Linha[], avisos: Linha[] = []): { admin: never; banco: Banco } {
  const banco: Banco = { messages, avisos, eventos: [], updates: [] };

  const tabela = (nome: string) => {
    const fonte = nome === "messages" ? banco.messages : nome === "agent_inbox_items" ? banco.avisos : [];
    const filtros: Array<(l: Linha) => boolean> = [];
    let modo: "select" | "update" | "insert" = "select";
    let patch: Linha = {};

    const casadas = () => fonte.filter((l) => filtros.every((f) => f(l)));
    const executar = () => {
      if (modo === "update") {
        const alvo = casadas();
        if (nome === "messages") banco.updates.push(patch);
        for (const l of alvo) Object.assign(l, patch);
        return { data: alvo.map((l) => ({ id: l.id })), error: null };
      }
      const lidas = casadas().map((l) => ({ ...l }));
      if (nome === "messages") banco.aoLer?.();
      return { data: lidas, error: null };
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cadeia: any = {
      select: () => cadeia,
      update: (p: Linha) => {
        modo = "update";
        patch = p;
        return cadeia;
      },
      insert: (linha: Linha) => {
        modo = "insert";
        if (nome === "agent_inbox_items") banco.avisos.push({ status: "open", created_at: new Date().toISOString(), ...linha });
        return Promise.resolve({ data: null, error: null });
      },
      eq: (c: string, v: unknown) => (filtros.push((l) => l[c] === v), cadeia),
      in: (c: string, vs: unknown[]) => (filtros.push((l) => vs.includes(l[c])), cadeia),
      gte: (c: string, v: string) => (filtros.push((l) => String(l[c]) >= v), cadeia),
      limit: () => cadeia,
      order: () => cadeia,
      maybeSingle: () => Promise.resolve({ data: casadas()[0] ?? null, error: null }),
      then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
        Promise.resolve(executar()).then(resolve, reject),
    };
    return cadeia;
  };

  const admin = {
    from: (n: string) => tabela(n),
    rpc: (fn: string, args: Record<string, unknown>) => {
      if (fn === "emit_event") banco.eventos.push(args);
      return Promise.resolve({ data: null, error: null });
    },
  };
  return { admin: admin as never, banco };
}

/** Elemento que o teste SABE que existe (o tsconfig exige checar índice). */
function um<T>(lista: T[], i: number): T {
  const item = lista[i];
  if (item === undefined) throw new Error(`o teste esperava um item na posição ${i}`);
  return item;
}

const EXTERNAL = "3EB0A1B2C3";
const ID_NO_ACK = `true_120363999999999999@g.us_${EXTERNAL}`; // formato completo do WAHA 2026.x (GRUPO)
const ID_1A1 = `true_5511999999999@c.us_${EXTERNAL}`; // o mesmo, numa conversa 1:1

function mensagem(status: string, extra: Linha = {}): Linha {
  return {
    id: "msg-1",
    organization_id: ORG,
    conversation_id: "conv-1",
    external_id: EXTERNAL,
    direction: "outbound",
    sent_via: "user",
    status,
    ack: null,
    delivered_at: null,
    read_at: null,
    error_code: null,
    error_message: null,
    ...extra,
  };
}

async function receberAck(banco: { admin: never }, ack: number, id: string = ID_NO_ACK): Promise<void> {
  await dispatchWahaEvent(banco.admin, SESSION, { event: "message.ack", payload: { id, ack } }, "req-ack");
}

beforeEach(() => vi.clearAllMocks());

describe("ack -1 (ERROR) numa conversa 1:1 é FALHA do WhatsApp — não 'enviando', e não 'send_timeout'", () => {
  it("sending + ack -1 → failed, com código e texto próprios (não vira 'sending')", async () => {
    const b = criarBanco([mensagem("sending")]);
    await receberAck(b, -1, ID_1A1);

    const m = um(b.banco.messages, 0);
    expect(m.status).toBe("failed");
    expect(m.status).not.toBe("sending");
    expect(m.ack).toBe(-1);
    expect(m.error_code).toBe("waha_ack_error");
    expect(m.error_code).not.toBe("send_timeout");
    // Português claro, diz que o WhatsApp não confirmou — e NÃO afirma uma causa.
    expect(String(m.error_message)).toMatch(/WhatsApp/);
    expect(String(m.error_message)).toMatch(/não confirmou/i);
  });

  it("sent + ack -1 → failed (o servidor aceitou e depois deu erro: o último fato vence)", async () => {
    const b = criarBanco([mensagem("sent", { ack: 1 })]);
    await receberAck(b, -1, ID_1A1);
    expect(um(b.banco.messages, 0).status).toBe("failed");
    expect(um(b.banco.messages, 0).error_code).toBe("waha_ack_error");
  });

  it("delivered/read + ack -1 → NÃO vira falha: já chegou ao aparelho do cliente", async () => {
    for (const estado of ["delivered", "read"]) {
      const b = criarBanco([mensagem(estado, { ack: estado === "read" ? 3 : 2 })]);
      await receberAck(b, -1, ID_1A1);
      expect(um(b.banco.messages, 0).status).toBe(estado);
      expect(um(b.banco.messages, 0).error_code).toBeNull();
    }
  });

  it("a falha por ack é anunciada UMA vez: evento message.failed + aviso na Central", async () => {
    const b = criarBanco([mensagem("sending")]);
    await receberAck(b, -1, ID_1A1);

    expect(b.banco.eventos).toHaveLength(1);
    expect(um(b.banco.eventos, 0)).toMatchObject({ p_event_type: "message.failed", p_entity_id: "msg-1" });
    expect(um(b.banco.eventos, 0).p_payload).toMatchObject({ reason: "waha_ack_error", conversation_id: "conv-1" });
    expect(b.banco.avisos).toHaveLength(1);
    expect(um(b.banco.avisos, 0)).toMatchObject({
      kind: "message_send_stuck",
      organization_id: ORG,
      ref_kind: "conversation",
      ref_id: "conv-1",
    });

    // o webhook do WAHA repete: nada de segundo evento nem segundo aviso
    await receberAck(b, -1, ID_1A1);
    expect(b.banco.eventos).toHaveLength(1);
    expect(b.banco.avisos).toHaveLength(1);
  });

  it("aviso aberto há pouco NA MESMA conversa silencia o seguinte (rajada não enterra a Central)", async () => {
    const b = criarBanco(
      [mensagem("sending"), mensagem("sending", { id: "msg-2", external_id: "3EB0FFFF" })],
      [],
    );
    await receberAck(b, -1, ID_1A1);
    await receberAck(b, -1, `true_5511999999999@c.us_3EB0FFFF`);
    expect(b.banco.messages.map((m) => m.status)).toEqual(["failed", "failed"]);
    expect(b.banco.eventos).toHaveLength(2); // o evento é por mensagem
    expect(b.banco.avisos).toHaveLength(1); // o aviso é por conversa
  });

  it("mensagem que veio do celular (external_device) falha na tela, mas não abre aviso crítico", async () => {
    const b = criarBanco([mensagem("sent", { sent_via: "external_device" })]);
    await receberAck(b, -1, ID_1A1);
    expect(um(b.banco.messages, 0).status).toBe("failed");
    expect(b.banco.avisos).toHaveLength(0);
  });

  it("mensagem de ENTRADA nunca vira failed por ack", async () => {
    const b = criarBanco([mensagem("received", { direction: "inbound", sent_via: null })]);
    await receberAck(b, -1, ID_1A1);
    expect(um(b.banco.messages, 0).status).toBe("received");
    expect(b.banco.eventos).toHaveLength(0);
  });
});

describe("ack -1 (ERROR) em GRUPO é ruído do WAHA — a mensagem chegou, e o CRM não a chama de falha", () => {
  // Medido na VPS (04/11): das 14 mensagens de atendente em grupo, NENHUMA teve ack 1/2/3 — só -1 ou 0 —, e o
  // Carlos confirmou no celular que elas CHEGARAM ao grupo (algumas até foram lidas). Em 1:1 os acks andam 1→2→3.
  // O -1 do NOWEB em grupo, portanto, não diz que o envio falhou.
  it("sending + ack -1 em grupo → sobe para 'sent' (o WAHA conhece a mensagem), sem erro, sem evento e sem aviso", async () => {
    const b = criarBanco([mensagem("sending")]);
    await receberAck(b, -1);

    const m = um(b.banco.messages, 0);
    expect(m.status).toBe("sent");
    expect(m.error_code).toBeNull();
    expect(m.error_message).toBeNull();
    expect(b.banco.eventos).toHaveLength(0);
    expect(b.banco.avisos).toHaveLength(0);
  });

  it("sent + ack -1 em grupo → continua 'sent': NÃO vira failed", async () => {
    const b = criarBanco([mensagem("sent", { ack: 1 })]);
    await receberAck(b, -1);
    const m = um(b.banco.messages, 0);
    expect(m.status).toBe("sent");
    expect(m.error_code).toBeNull();
    expect(b.banco.eventos).toHaveLength(0);
    expect(b.banco.avisos).toHaveLength(0);
  });

  it("delivered/read + ack -1 em grupo → nada muda", async () => {
    for (const estado of ["delivered", "read"]) {
      const b = criarBanco([mensagem(estado, { ack: estado === "read" ? 3 : 2 })]);
      await receberAck(b, -1);
      expect(um(b.banco.messages, 0).status).toBe(estado);
    }
  });

  it("se o WAHA depois der ack 2/3 em grupo, a mensagem avança normalmente", async () => {
    const b = criarBanco([mensagem("sent", { ack: -1 })]);
    await receberAck(b, 2);
    expect(um(b.banco.messages, 0).status).toBe("delivered");
    await receberAck(b, 3);
    expect(um(b.banco.messages, 0).status).toBe("read");
  });

  it("o mesmo -1 numa conversa 1:1 CONTINUA sendo falha (a regra só muda onde o WAHA é medido como ruidoso)", async () => {
    const b = criarBanco([mensagem("sent", { ack: 1 })]);
    await receberAck(b, -1, ID_1A1);
    expect(um(b.banco.messages, 0).status).toBe("failed");
  });
});

describe("guarda monotônica: o status só anda para a frente", () => {
  const casos: Array<{ de: string; ack: number; vira: string }> = [
    // para a frente
    { de: "sending", ack: 1, vira: "sent" },
    { de: "sending", ack: 2, vira: "delivered" },
    { de: "sending", ack: 3, vira: "read" },
    { de: "sent", ack: 2, vira: "delivered" },
    { de: "sent", ack: 3, vira: "read" },
    { de: "sent", ack: 4, vira: "read" }, // PLAYED conta como lido
    { de: "delivered", ack: 3, vira: "read" },
    // para trás ou repetido: fica
    { de: "read", ack: 2, vira: "read" },
    { de: "read", ack: 1, vira: "read" },
    { de: "read", ack: 0, vira: "read" },
    { de: "read", ack: 3, vira: "read" },
    { de: "read", ack: 4, vira: "read" },
    { de: "delivered", ack: 1, vira: "delivered" },
    { de: "delivered", ack: 0, vira: "delivered" },
    { de: "delivered", ack: 2, vira: "delivered" },
    { de: "sent", ack: 0, vira: "sent" },
    { de: "sent", ack: 1, vira: "sent" },
  ];

  it.each(casos)("$de + ack $ack → $vira", async ({ de, ack, vira }) => {
    const b = criarBanco([mensagem(de, { ack: 9 })]);
    await receberAck(b, ack);
    expect(um(b.banco.messages, 0).status).toBe(vira);
  });

  it("ack que NÃO avança também não reescreve ack, delivered_at nem read_at", async () => {
    const lidoEm = "2026-11-01T10:00:00.000Z";
    const b = criarBanco([mensagem("read", { ack: 3, delivered_at: lidoEm, read_at: lidoEm })]);
    await receberAck(b, 2);
    expect(um(b.banco.messages, 0)).toMatchObject({ ack: 3, delivered_at: lidoEm, read_at: lidoEm });
    expect(b.banco.updates).toHaveLength(0);
  });

  it("os carimbos acompanham o avanço: delivered grava delivered_at; read grava read_at", async () => {
    const b = criarBanco([mensagem("sent")]);
    await receberAck(b, 2);
    expect(um(b.banco.messages, 0).delivered_at).toEqual(expect.any(String));
    expect(um(b.banco.messages, 0).read_at).toBeNull();
    await receberAck(b, 3);
    expect(um(b.banco.messages, 0).read_at).toEqual(expect.any(String));
  });

  it("failed + ack 0/1 continua failed; failed + ack 2/3 CURA (prova de que chegou ao aparelho) e limpa o erro", async () => {
    for (const ack of [0, 1]) {
      const b = criarBanco([mensagem("failed", { ack: -1, error_code: "waha_ack_error", error_message: "x" })]);
      await receberAck(b, ack);
      expect(um(b.banco.messages, 0).status).toBe("failed");
      expect(um(b.banco.messages, 0).error_code).toBe("waha_ack_error");
    }
    for (const [ack, esperado] of [
      [2, "delivered"],
      [3, "read"],
    ] as const) {
      const b = criarBanco([mensagem("failed", { ack: -1, error_code: "send_timeout", error_message: "x" })]);
      await receberAck(b, ack);
      expect(um(b.banco.messages, 0).status).toBe(esperado);
      expect(um(b.banco.messages, 0).error_code).toBeNull();
      expect(um(b.banco.messages, 0).error_message).toBeNull();
    }
  });

  it("casa pelo external_id nas duas formas (bare gravado, completo no ack) e só na organização certa", async () => {
    const b = criarBanco([mensagem("sending"), mensagem("sending", { id: "msg-de-outra-org", organization_id: "org-2" })]);
    await receberAck(b, 2);
    expect(um(b.banco.messages, 0).status).toBe("delivered");
    expect(um(b.banco.messages, 1).status).toBe("sending");
  });

  it("corrida: se um ack MAIOR grava entre a leitura e a escrita, o UPDATE não o pisa (compare-and-set)", async () => {
    const b = criarBanco([mensagem("sent")]);
    // entre o SELECT do handleAck (que viu 'sent') e o UPDATE, chega o "lido".
    b.banco.aoLer = () => {
      um(b.banco.messages, 0).status = "read";
      b.banco.aoLer = undefined;
    };
    await receberAck(b, 2); // decidiu "sent → delivered" com base em um 'sent' que já não existe
    expect(um(b.banco.messages, 0).status).toBe("read");
    expect(um(b.banco.messages, 0).delivered_at).toBeNull();
  });

  it("linha que não é saída nossa mantém o comportamento antigo para ack positivo (fora do escopo deste conserto)", async () => {
    const b = criarBanco([mensagem("received", { direction: "inbound", sent_via: null })]);
    await receberAck(b, 3);
    expect(um(b.banco.messages, 0).status).toBe("read");
  });
});
