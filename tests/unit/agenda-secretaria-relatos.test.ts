// @vitest-environment node
import { describe, expect, it } from "vitest";

import {
  conferirEAplicarRelato,
  descartarRelato,
  marcarRelatoCorrigido,
  registrarRelato,
} from "@/lib/agenda/secretaria/relatos";
import type { RelatoLido } from "@/lib/agenda/secretaria/relato";

/**
 * O CICLO DE VIDA DO RELATO: registrar (a mesma mensagem não vira dois), conferir e aplicar (só depois do "sim"),
 * corrigir e descartar. Cliente de mentira que registra cada operação.
 */
const ORG = "org-1";
const DONO = "11111111-1111-4111-8111-111111111111";
const AGORA = new Date("2026-11-18T12:00:00Z");

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

const LIDO: RelatoLido = {
  janela: { de: "2026-11-18", ate: "2026-11-18" },
  marcados: [{ nome: "Maria", inicio: "2026-11-18T14:00:00-03:00" }],
  dias_fechados: [],
  duvidas: [],
};

describe("registrarRelato", () => {
  it("grava o texto bruto, o que foi entendido, a janela e o estado 'lido'", async () => {
    const { admin, chamadas } = registrador(() => ({ data: { id: "r1" } }));
    const r = await registrarRelato(admin, {
      organizationId: ORG,
      contactId: "sec-1",
      messageId: "m1",
      texto: "hoje 14h Maria",
      lido: LIDO,
    });
    expect(r).toEqual({ id: "r1", duplicado: false });
    expect(chamadas[0]?.payload).toMatchObject({
      organization_id: ORG,
      contact_id: "sec-1",
      message_id: "m1",
      texto: "hoje 14h Maria",
      janela_de: "2026-11-18",
      janela_ate: "2026-11-18",
      estado: "lido",
    });
  });

  it("a MESMA mensagem (23505) devolve o relato que já existe, marcado como duplicado", async () => {
    const { admin } = registrador((c) =>
      c.op === "insert" ? { error: { message: "duplicate", code: "23505" } } : { data: { id: "existente" } },
    );
    const r = await registrarRelato(admin, {
      organizationId: ORG,
      contactId: "sec-1",
      messageId: "m1",
      texto: "x",
      lido: LIDO,
    });
    expect(r).toEqual({ id: "existente", duplicado: true });
  });

  it("outro erro do banco propaga", async () => {
    const { admin } = registrador(() => ({ error: { message: "boom" } }));
    await expect(
      registrarRelato(admin, { organizationId: ORG, contactId: "s", messageId: null, texto: "x", lido: LIDO }),
    ).rejects.toThrow(/registrar o relato: boom/);
  });
});

/** O mundo de um relato 'lido' pronto para ser conferido, com a secretaria configurada. */
function mundo(over: { estado?: string; lido?: unknown; settings?: unknown } = {}) {
  return registrador((c) => {
    if (c.tabela === "agenda_relatos" && c.op === "select") {
      return { data: { id: "r1", estado: over.estado ?? "lido", lido: over.lido ?? LIDO } };
    }
    if (c.tabela === "organizations") {
      return {
        data: {
          timezone: "America/Sao_Paulo",
          settings: over.settings ?? { secretaria: { ativa: true, dono_da_agenda_user_id: DONO } },
        },
      };
    }
    if (c.tabela === "attendant_availability") {
      return { data: { schedule: { timezone: "America/Sao_Paulo", windows: [] } } };
    }
    return { data: [] };
  });
}

describe("conferirEAplicarRelato", () => {
  it("aplica o relato na agenda e SÓ DEPOIS o marca como conferido (com o carimbo)", async () => {
    const { admin, chamadas } = mundo();
    const r = await conferirEAplicarRelato(admin, { organizationId: ORG, relatoId: "r1", agora: AGORA });
    expect(r).toMatchObject({ relatoId: "r1", jaConferido: false, criados: 1 });

    const escritas = chamadas.filter((c) => c.op !== "select").map((c) => `${c.tabela}:${c.op}`);
    expect(escritas).toEqual(["calendar_appointments:insert", "agenda_relatos:update"]);

    const marca = chamadas.find((c) => c.tabela === "agenda_relatos" && c.op === "update")!;
    expect(marca.payload).toEqual({ estado: "conferido", conferido_em: AGORA.toISOString() });
    // Só marca o que ainda estava 'lido': conferir duas vezes não troca o carimbo do relato.
    expect(marca.filtros).toContainEqual(["in", "estado", ["lido"]]);
    expect(marca.filtros).toContainEqual(["eq", "organization_id", ORG]);
  });

  it("usa a duração configurada para quem só disse a hora de início", async () => {
    const { admin, chamadas } = mundo({
      settings: { secretaria: { ativa: true, dono_da_agenda_user_id: DONO, duracao_min: 45 } },
    });
    await conferirEAplicarRelato(admin, { organizationId: ORG, relatoId: "r1", agora: AGORA });
    const ins = chamadas.find((c) => c.tabela === "calendar_appointments" && c.op === "insert")!;
    const linha = (ins.payload as Array<{ starts_at: string; ends_at: string }>)[0]!;
    expect(new Date(linha.ends_at).getTime() - new Date(linha.starts_at).getTime()).toBe(45 * 60_000);
  });

  it("relato JÁ conferido: não regrava nada", async () => {
    const { admin, chamadas } = mundo({ estado: "conferido" });
    const r = await conferirEAplicarRelato(admin, { organizationId: ORG, relatoId: "r1", agora: AGORA });
    expect(r.jaConferido).toBe(true);
    expect(chamadas.filter((c) => c.op !== "select")).toEqual([]);
  });

  it.each(["descartado", "corrigido"])("relato %s não pode ser conferido", async (estado) => {
    const { admin } = mundo({ estado });
    await expect(
      conferirEAplicarRelato(admin, { organizationId: ORG, relatoId: "r1", agora: AGORA }),
    ).rejects.toThrow(`relato_${estado}`);
  });

  it("relato de OUTRA organização (a consulta filtra pela organização e não acha): não encontrado", async () => {
    const { admin } = registrador(() => ({ data: null }));
    await expect(
      conferirEAplicarRelato(admin, { organizationId: ORG, relatoId: "r1", agora: AGORA }),
    ).rejects.toThrow("relato_nao_encontrado");
  });

  it("sem dono da agenda configurado: recusa em vez de gravar a agenda de ninguém", async () => {
    const { admin, chamadas } = mundo({ settings: { secretaria: { ativa: true } } });
    await expect(
      conferirEAplicarRelato(admin, { organizationId: ORG, relatoId: "r1", agora: AGORA }),
    ).rejects.toThrow("dono_da_agenda_nao_definido");
    expect(chamadas.filter((c) => c.op !== "select")).toEqual([]);
  });

  it("o que está gravado como 'lido' mas não obedece ao formato: ilegível, sem gravar", async () => {
    const { admin, chamadas } = mundo({ lido: { marcados: "nada" } });
    await expect(
      conferirEAplicarRelato(admin, { organizationId: ORG, relatoId: "r1", agora: AGORA }),
    ).rejects.toThrow("relato_ilegivel");
    expect(chamadas.filter((c) => c.op !== "select")).toEqual([]);
  });

  it("se a aplicação falha no meio, o relato NÃO é marcado como conferido (e rodar de novo é seguro)", async () => {
    const { admin, chamadas } = registrador((c) => {
      if (c.tabela === "agenda_relatos" && c.op === "select") return { data: { id: "r1", estado: "lido", lido: LIDO } };
      if (c.tabela === "organizations") {
        return { data: { timezone: "America/Sao_Paulo", settings: { secretaria: { ativa: true, dono_da_agenda_user_id: DONO } } } };
      }
      if (c.tabela === "attendant_availability") return { data: { schedule: { timezone: "America/Sao_Paulo" } } };
      if (c.op === "insert") return { error: { message: "boom" } };
      return { data: [] };
    });
    await expect(
      conferirEAplicarRelato(admin, { organizationId: ORG, relatoId: "r1", agora: AGORA }),
    ).rejects.toThrow(/boom/);
    expect(chamadas.some((c) => c.tabela === "agenda_relatos" && c.op === "update")).toBe(false);
  });
});

describe("marcarRelatoCorrigido e descartarRelato", () => {
  it("só mudam o que ainda está 'lido', dentro da organização", async () => {
    const a = registrador(() => ({ data: null }));
    await marcarRelatoCorrigido(a.admin, { organizationId: ORG, relatoId: "r1" });
    const b = registrador(() => ({ data: null }));
    await descartarRelato(b.admin, { organizationId: ORG, relatoId: "r1" });

    expect(a.chamadas[0]?.payload).toEqual({ estado: "corrigido" });
    expect(b.chamadas[0]?.payload).toEqual({ estado: "descartado" });
    for (const c of [a.chamadas[0]!, b.chamadas[0]!]) {
      expect(c.filtros).toContainEqual(["in", "estado", ["lido"]]);
      expect(c.filtros).toContainEqual(["eq", "organization_id", ORG]);
      expect(c.filtros).toContainEqual(["eq", "id", "r1"]);
    }
  });
});
