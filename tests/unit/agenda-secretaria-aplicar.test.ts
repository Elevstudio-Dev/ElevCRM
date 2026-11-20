// @vitest-environment node
import { describe, expect, it } from "vitest";

import { aplicarRelato, RelatoIncoerente } from "@/lib/agenda/secretaria/aplicar";
import type { RelatoLido } from "@/lib/agenda/secretaria/relato";

/**
 * APLICAR UM RELATO CONFERIDO — o que vai ao banco e, principalmente, o que NÃO vai.
 *
 * O cliente é um registrador: cada operação vira uma entrada com tabela, tipo, filtros e corpo. Assim o teste enxerga
 * a ORDEM (criar antes de cancelar), os FILTROS (sempre a organização) e o que nunca é tocado.
 */
const ORG = "org-1";
const DONO = "dono-1";
const RELATO = "relato-2";
const FUSO = "America/Sao_Paulo";
const AGORA = new Date("2026-11-18T12:00:00Z"); // 09h em Brasília

interface Chamada {
  tabela: string;
  op: "select" | "insert" | "update" | "delete";
  filtros: Array<[string, ...unknown[]]>;
  payload?: unknown;
}
type Resposta = { data?: unknown; error?: { message: string; code?: string } | null };

function registrador(responder: (c: Chamada) => Resposta) {
  const chamadas: Chamada[] = [];
  const from = (tabela: string) => {
    const c: Chamada = { tabela, op: "select", filtros: [] };
    const q: Record<string, unknown> = {};
    for (const m of ["eq", "neq", "in", "not", "is", "gte", "lte", "lt", "gt", "like", "order", "limit", "select"]) {
      q[m] = (...a: unknown[]) => {
        if (m !== "select") c.filtros.push([m, ...a]);
        return q;
      };
    }
    q.insert = (p: unknown) => {
      c.op = "insert";
      c.payload = p;
      return q;
    };
    q.update = (p: unknown) => {
      c.op = "update";
      c.payload = p;
      return q;
    };
    q.delete = () => {
      c.op = "delete";
      return q;
    };
    const fim = async () => {
      chamadas.push(c);
      const r = responder(c);
      return { data: r.data ?? null, error: r.error ?? null };
    };
    q.maybeSingle = fim;
    q.single = fim;
    q.then = (ok: (v: unknown) => unknown, ko: (e: unknown) => unknown) => fim().then(ok, ko);
    return q;
  };
  return { admin: { from } as never, chamadas };
}

const relato = (over: Partial<RelatoLido> = {}): RelatoLido => ({
  janela: { de: "2026-11-18", ate: "2026-11-19" },
  marcados: [{ nome: "Maria", inicio: "2026-11-18T14:00:00-03:00" }],
  dias_fechados: [],
  duvidas: [],
  ...over,
});

const aplicar = (admin: never, r: RelatoLido) =>
  aplicarRelato(admin, {
    organizationId: ORG,
    relatoId: RELATO,
    donoUserId: DONO,
    relato: r,
    fuso: FUSO,
    duracaoMin: 30,
    agora: AGORA,
  });

const escritas = (chamadas: Chamada[]) => chamadas.filter((c) => c.op !== "select");

describe("aplicarRelato — o que grava", () => {
  it("agenda vazia: cria o compromisso com os campos que o tornam um ESPELHO (origem, sem contato, já 'enviado ao Google')", async () => {
    const { admin, chamadas } = registrador(() => ({ data: [] }));
    const r = await aplicar(admin, relato());
    expect(r).toEqual({ criados: 1, mantidos: 0, cancelados: 0, diasFechados: 0, diasReabertos: 0, conflitos: [] });

    const insert = chamadas.find((c) => c.tabela === "calendar_appointments" && c.op === "insert")!;
    const linha = (insert.payload as Array<Record<string, unknown>>)[0]!;
    expect(linha).toMatchObject({
      organization_id: ORG,
      title: "Maria",
      starts_at: "2026-11-18T17:00:00.000Z",
      ends_at: "2026-11-18T17:30:00.000Z",
      time_zone: FUSO,
      status: "confirmed",
      owner_user_id: DONO,
      created_by_kind: "ai",
      origem_relato_id: RELATO,
      google_synced_at: AGORA.toISOString(),
    });
    // Sem contato e sem tipo: não é consulta de paciente do CRM, é uma hora tomada (e o lembrete nem arma).
    expect("contact_id" in linha).toBe(false);
    expect("event_type_id" in linha).toBe(false);
  });

  it("TODA consulta e escrita filtra pela organização", async () => {
    const { admin, chamadas } = registrador((c) =>
      c.tabela === "calendar_appointments" && c.op === "select"
        ? { data: [{ id: "velho", title: "João", starts_at: "2026-11-18T18:00:00Z", ends_at: "2026-11-18T18:30:00Z" }] }
        : { data: [] },
    );
    await aplicar(admin, relato({ dias_fechados: [{ data: "2026-11-19" }] }));
    for (const c of chamadas) {
      const filtraOrg = c.filtros.some(([m, col, val]) => m === "eq" && col === "organization_id" && val === ORG);
      // O insert carrega a organização no corpo; as demais operações, no filtro.
      const noCorpo =
        c.op === "insert" &&
        [c.payload].flat().every((p) => (p as Record<string, unknown>).organization_id === ORG);
      expect(filtraOrg || noCorpo).toBe(true);
    }
  });

  it("o que sumiu do relato é CANCELADO (com o motivo), e o criar vem ANTES do cancelar", async () => {
    const { admin, chamadas } = registrador((c) =>
      c.tabela === "calendar_appointments" && c.op === "select"
        ? { data: [{ id: "velho", title: "João", starts_at: "2026-11-18T18:00:00Z", ends_at: "2026-11-18T18:30:00Z" }] }
        : { data: [] },
    );
    const r = await aplicar(admin, relato());
    expect(r.criados).toBe(1);
    expect(r.cancelados).toBe(1);

    const ordem = escritas(chamadas).map((c) => `${c.tabela}:${c.op}`);
    expect(ordem.indexOf("calendar_appointments:insert")).toBeLessThan(ordem.indexOf("calendar_appointments:update"));

    const upd = chamadas.find((c) => c.op === "update")!;
    expect(upd.payload).toMatchObject({ status: "cancelled", cancelled_at: AGORA.toISOString() });
    expect((upd.payload as { cancellation_reason: string }).cancellation_reason).toMatch(/relato da secretaria/i);
    expect(upd.filtros).toContainEqual(["in", "id", ["velho"]]);
  });

  it("só enxerga o que um relato criou: a consulta exige origem_relato_id e só estados vivos", async () => {
    const { admin, chamadas } = registrador(() => ({ data: [] }));
    await aplicar(admin, relato());
    const leitura = chamadas.find((c) => c.tabela === "calendar_appointments" && c.op === "select")!;
    expect(leitura.filtros).toContainEqual(["not", "origem_relato_id", "is", null]);
    expect(leitura.filtros).toContainEqual(["in", "status", ["pending", "confirmed"]]);
    expect(leitura.filtros).toContainEqual(["eq", "owner_user_id", DONO]);
  });

  it("o mesmo relato de novo: não grava NADA (idempotente)", async () => {
    const { admin, chamadas } = registrador((c) =>
      c.tabela === "calendar_appointments" && c.op === "select"
        ? { data: [{ id: "a1", title: "Maria", starts_at: "2026-11-18T17:00:00Z", ends_at: "2026-11-18T17:30:00Z" }] }
        : { data: [] },
    );
    const r = await aplicar(admin, relato());
    expect(r).toEqual({ criados: 0, mantidos: 1, cancelados: 0, diasFechados: 0, diasReabertos: 0, conflitos: [] });
    expect(escritas(chamadas)).toEqual([]);
  });
});

describe("aplicarRelato — dias fechados", () => {
  it("fecha o dia inteiro (0–1440), com o prefixo que o identifica depois", async () => {
    const { admin, chamadas } = registrador(() => ({ data: [] }));
    const r = await aplicar(admin, relato({ marcados: [], dias_fechados: [{ data: "2026-11-19", motivo: "feriado" }] }));
    expect(r.diasFechados).toBe(1);
    const ins = chamadas.find((c) => c.tabela === "calendar_availability_exceptions" && c.op === "insert")!;
    expect(ins.payload).toMatchObject({
      organization_id: ORG,
      user_id: DONO,
      exception_date: "2026-11-19",
      is_unavailable: true,
      start_minute: 0,
      end_minute: 1440,
      reason: "[secretaria] feriado",
    });
  });

  it("dia que um humano já fechou (23505) NÃO é erro e não conta como fechado por nós", async () => {
    const { admin } = registrador((c) =>
      c.tabela === "calendar_availability_exceptions" && c.op === "insert"
        ? { error: { message: "duplicate key", code: "23505" } }
        : { data: [] },
    );
    const r = await aplicar(admin, relato({ marcados: [], dias_fechados: [{ data: "2026-11-19" }] }));
    expect(r.diasFechados).toBe(0);
  });

  it("só reconhece como seus os fechamentos com o prefixo (a leitura filtra por LIKE)", async () => {
    const { admin, chamadas } = registrador(() => ({ data: [] }));
    await aplicar(admin, relato());
    const leitura = chamadas.find((c) => c.tabela === "calendar_availability_exceptions" && c.op === "select")!;
    expect(leitura.filtros).toContainEqual(["like", "reason", "[secretaria] %"]);
  });

  it("o relato novo não fecha mais o dia: o fechamento que um relato criou é removido, só pelos ids dele", async () => {
    const { admin, chamadas } = registrador((c) =>
      c.tabela === "calendar_availability_exceptions" && c.op === "select"
        ? { data: [{ id: "f1", exception_date: "2026-11-19" }] }
        : { data: [] },
    );
    const r = await aplicar(admin, relato({ marcados: [], dias_fechados: [] }));
    expect(r.diasReabertos).toBe(1);
    const del = chamadas.find((c) => c.op === "delete")!;
    expect(del.filtros).toContainEqual(["in", "id", ["f1"]]);
    expect(del.filtros).toContainEqual(["eq", "organization_id", ORG]);
  });
});

describe("aplicarRelato — a troca de paciente no MESMO horário (a falha de produção)", () => {
  /** O relato anterior tinha "Fulano" às 14h (17:00Z) e "Zé" às 15h (18:00Z); o novo traz "Maria" às 14h. */
  const doRelato = (c: Chamada) =>
    c.tabela === "calendar_appointments" && c.op === "select" && c.filtros.some(([m, col]) => m === "not" && col === "origem_relato_id");
  const foraDoRelato = (c: Chamada) =>
    c.tabela === "calendar_appointments" && c.op === "select" && c.filtros.some(([m, col]) => m === "is" && col === "origem_relato_id");
  const ANTERIOR = [
    { id: "fulano", title: "Fulano", starts_at: "2026-11-18T17:00:00Z", ends_at: "2026-11-18T17:30:00Z", status: "pending" },
    { id: "ze", title: "Zé", starts_at: "2026-11-18T18:00:00Z", ends_at: "2026-11-18T18:30:00Z", status: "confirmed" },
  ];

  it("cancela o antigo do MESMO horário ANTES do insert; o que só sumiu continua sendo cancelado DEPOIS", async () => {
    const { admin, chamadas } = registrador((c) => (doRelato(c) ? { data: ANTERIOR } : { data: [] }));
    const r = await aplicar(admin, relato());
    expect(r).toMatchObject({ criados: 1, cancelados: 2, conflitos: [] });

    const ordem = escritas(chamadas).map((c) => `${c.op}:${JSON.stringify(c.filtros.find(([m, col]) => m === "in" && col === "id")?.[2] ?? null)}`);
    expect(ordem).toEqual(['update:["fulano"]', "insert:null", 'update:["ze"]']);
    // O cancelamento antecipado só alcança o que um relato criou e ainda está vivo.
    const antecipado = escritas(chamadas)[0]!;
    expect(antecipado.filtros).toContainEqual(["not", "origem_relato_id", "is", null]);
    expect(antecipado.filtros).toContainEqual(["in", "status", ["pending", "confirmed"]]);
    expect(antecipado.filtros).toContainEqual(["eq", "organization_id", ORG]);
  });

  it("o insert FALHA depois do cancelamento antecipado: o antigo é RESTAURADO no estado que tinha, e o erro propaga", async () => {
    const { admin, chamadas } = registrador((c) => {
      if (doRelato(c)) return { data: ANTERIOR };
      if (c.op === "insert") return { error: { message: "boom" } };
      return { data: [] };
    });
    await expect(aplicar(admin, relato())).rejects.toThrow(/criar compromissos do relato: boom/);

    const updates = escritas(chamadas).filter((c) => c.op === "update");
    expect(updates).toHaveLength(2); // o cancelamento antecipado e a restauração; o "Zé" NÃO é cancelado
    const restauracao = updates[1]!;
    expect(restauracao.payload).toMatchObject({ status: "pending", cancelled_at: null, cancellation_reason: null });
    expect(restauracao.filtros).toContainEqual(["in", "id", ["fulano"]]);
    expect(restauracao.filtros).toContainEqual(["eq", "status", "cancelled"]);
    expect(restauracao.filtros).toContainEqual(["eq", "organization_id", ORG]);
  });

  it("a restauração também falha: o erro diz as duas coisas (o relato continua `lido`, reexecutar recalcula)", async () => {
    let updates = 0;
    const { admin } = registrador((c) => {
      if (doRelato(c)) return { data: ANTERIOR };
      if (c.op === "insert") return { error: { message: "boom" } };
      if (c.op === "update" && ++updates === 2) return { error: { message: "sem rede" } };
      return { data: [] };
    });
    await expect(aplicar(admin, relato())).rejects.toThrow(/boom.*restaurar.*sem rede/);
  });

  it("horário tomado por compromisso que NÃO é de relato: não cria o espelho, não toca nele e devolve o conflito", async () => {
    const { admin, chamadas } = registrador((c) =>
      foraDoRelato(c) ? { data: [{ starts_at: "2026-11-18T17:00:00Z" }] } : { data: [] },
    );
    const r = await aplicar(admin, relato());
    expect(r.criados).toBe(0);
    expect(r.conflitos).toEqual([{ inicio: "2026-11-18T17:00:00.000Z", nome: "Maria", porque: "outro_compromisso" }]);
    expect(escritas(chamadas)).toEqual([]);
    // A leitura do que NÃO é de relato filtra pelo dono e pela organização, e só o que está vivo.
    const leitura = chamadas.find(foraDoRelato)!;
    expect(leitura.filtros).toContainEqual(["eq", "organization_id", ORG]);
    expect(leitura.filtros).toContainEqual(["eq", "owner_user_id", DONO]);
    expect(leitura.filtros).toContainEqual(["in", "status", ["pending", "confirmed"]]);
  });
});

describe("aplicarRelato — o ocupante é o MESMO paciente (I2)", () => {
  const foraDoRelato = (c: Chamada) =>
    c.tabela === "calendar_appointments" && c.op === "select" && c.filtros.some(([m, col]) => m === "is" && col === "origem_relato_id");

  it("o nome do CONTATO do compromisso (lido na organização) casa com o relato: nada é criado nem avisado", async () => {
    const { admin, chamadas } = registrador((c) => {
      if (foraDoRelato(c)) return { data: [{ starts_at: "2026-11-18T17:00:00Z", title: "Avaliação", contact_id: "ct-1" }] };
      if (c.tabela === "contacts") return { data: [{ id: "ct-1", display_name: "Maria Aparecida" }] };
      return { data: [] };
    });
    const r = await aplicar(admin, relato());
    expect(r).toMatchObject({ criados: 0, conflitos: [] });
    expect(escritas(chamadas)).toEqual([]);
    const leitura = chamadas.find((c) => c.tabela === "contacts")!;
    expect(leitura.filtros).toContainEqual(["eq", "organization_id", ORG]);
    expect(leitura.filtros).toContainEqual(["in", "id", ["ct-1"]]);
  });

  it("outro paciente no horário: conflito avisado", async () => {
    const { admin } = registrador((c) => {
      if (foraDoRelato(c)) return { data: [{ starts_at: "2026-11-18T17:00:00Z", title: "Avaliação", contact_id: "ct-1" }] };
      if (c.tabela === "contacts") return { data: [{ id: "ct-1", display_name: "Fulano" }] };
      return { data: [] };
    });
    expect((await aplicar(admin, relato())).conflitos).toHaveLength(1);
  });
});

describe("aplicarRelato — o que NUNCA chega ao banco", () => {
  it("relato contraditório (marcado num dia que ele mesmo fecha): lança e não escreve nada", async () => {
    const { admin, chamadas } = registrador(() => ({ data: [] }));
    await expect(
      aplicar(
        admin,
        relato({
          marcados: [{ nome: "Maria", inicio: "2026-11-19T14:00:00-03:00" }],
          dias_fechados: [{ data: "2026-11-19" }],
        }),
      ),
    ).rejects.toBeInstanceOf(RelatoIncoerente);
    expect(chamadas).toEqual([]);
  });

  it("horário fora da janela informada: lança e não escreve nada", async () => {
    const { admin, chamadas } = registrador(() => ({ data: [] }));
    await expect(
      aplicar(admin, relato({ marcados: [{ nome: "Ana", inicio: "2026-11-25T10:00:00-03:00" }] })),
    ).rejects.toThrow(/fora dos dias/);
    expect(chamadas).toEqual([]);
  });

  it("falha ao CRIAR: propaga e NÃO cancela nada (a agenda nunca fica com menos do que a secretaria disse)", async () => {
    const { admin, chamadas } = registrador((c) => {
      if (c.tabela === "calendar_appointments" && c.op === "select") {
        return { data: [{ id: "velho", title: "João", starts_at: "2026-11-18T18:00:00Z", ends_at: "2026-11-18T18:30:00Z" }] };
      }
      if (c.op === "insert") return { error: { message: "boom" } };
      return { data: [] };
    });
    await expect(aplicar(admin, relato())).rejects.toThrow(/criar compromissos do relato: boom/);
    expect(chamadas.some((c) => c.op === "update")).toBe(false);
  });

  it("falha ao LER: propaga sem escrever", async () => {
    const { admin, chamadas } = registrador(() => ({ error: { message: "sem rede" } }));
    await expect(aplicar(admin, relato())).rejects.toThrow(/sem rede/);
    expect(escritas(chamadas)).toEqual([]);
  });
});
