import { describe, expect, it, vi } from "vitest";

import { aplicarEventoDeOs } from "@/lib/integrations/despachocerto/aplicar-evento";
import type { EventoDeOs } from "@/lib/integrations/despachocerto/contrato";

vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

/**
 * A OS CHEGA, E AS TAGS NASCEM — no contato e em TODAS as conversas dele.
 *
 * O que cada caso aqui defende, e o que quebraria sem ele:
 *
 *  - **sem vínculo, não inventa.** Uma OS de cliente que nunca falou pelo
 *    WhatsApp não pode marcar "alguém parecido"; marcar a conversa errada é
 *    pior que não marcar nenhuma.
 *  - **todas as conversas.** O orçamento e a entrega são fios diferentes da
 *    mesma pessoa; marcar só o mais recente esconde a OS de quem abrir o outro.
 *  - **arquivada fica fora.** Ela saiu da vista de propósito.
 *  - **evento repetido não escreve.** Uma OS que muda de status cinco vezes
 *    manda cinco eventos iguais; cinco `update` acordam o tempo real do inbox
 *    e mexem no `updated_at` do contato sem nada ter mudado.
 */

interface Linha {
  id: string;
  [k: string]: unknown;
}

/**
 * Dublê do cliente admin que APLICA os filtros e as escritas de verdade — um
 * stub que devolvesse valor fixo deixaria passar a remoção do
 * `.eq("organization_id", …)`, que é o que isola um cliente do outro.
 */
function bancoFalso(dados: {
  vinculos?: Linha[];
  contatos?: Linha[];
  conversas?: Linha[];
}) {
  const tabelas: Record<string, Linha[]> = {
    integration_contact_links: dados.vinculos ?? [],
    contacts: dados.contatos ?? [],
    conversations: dados.conversas ?? [],
  };
  const escritas: Array<{ tabela: string; patch: Record<string, unknown> }> = [];

  class Q implements PromiseLike<unknown> {
    private filtros: Array<[string, unknown]> = [];
    private diferentes: Array<[string, unknown]> = [];
    constructor(
      private readonly tabela: string,
      private readonly op: "select" | "update",
      private readonly patch: Record<string, unknown> | null = null,
    ) {}
    select(): this {
      return this;
    }
    eq(col: string, val: unknown): this {
      this.filtros.push([col, val]);
      return this;
    }
    neq(col: string, val: unknown): this {
      this.diferentes.push([col, val]);
      return this;
    }
    maybeSingle(): this {
      return this;
    }
    private casam(): Linha[] {
      return (tabelas[this.tabela] ?? []).filter(
        (l) =>
          this.filtros.every(([c, v]) => (l[c] ?? null) === v) &&
          this.diferentes.every(([c, v]) => (l[c] ?? null) !== v),
      );
    }
    private executar(): { data: unknown; error: unknown } {
      const alvo = this.casam();
      if (this.op === "select") {
        // `maybeSingle` e lista têm a mesma forma de chamada aqui; devolver o
        // primeiro quando há filtro por id cobre os dois usos do módulo.
        return { data: this.filtros.some(([c]) => c === "id" || c === "external_id") ? (alvo[0] ?? null) : alvo, error: null };
      }
      escritas.push({ tabela: this.tabela, patch: this.patch ?? {} });
      for (const l of alvo) Object.assign(l, this.patch);
      return { data: null, error: null };
    }
    then<R1 = unknown, R2 = never>(
      onOk?: ((v: { data: unknown; error: unknown }) => R1 | PromiseLike<R1>) | null,
      onErr?: ((r: unknown) => R2 | PromiseLike<R2>) | null,
    ): PromiseLike<R1 | R2> {
      return Promise.resolve(this.executar()).then(onOk, onErr);
    }
  }

  const client = {
    from: (tabela: string) => ({
      select: () => new Q(tabela, "select").select(),
      update: (patch: Record<string, unknown>) => new Q(tabela, "update", patch),
    }),
  };
  return { client, tabelas, escritas };
}

const ORG = "org-1";
const evento = (over: Partial<EventoDeOs["work_order"]> = {}): EventoDeOs => ({
  event: "work_order.created",
  work_order: {
    id: "os-uuid",
    number: "1234",
    client_id: "cli-9",
    plate: "abc-1d23",
    additional_plates: [],
    ...over,
  },
});

describe("aplicar evento de OS", () => {
  it("sem vínculo → não marca nada, e diz que não marcou", async () => {
    const db = bancoFalso({ vinculos: [] });
    const r = await aplicarEventoDeOs(db.client as never, ORG, evento(), "req-1");
    expect(r).toEqual({ vinculado: false, tags_novas: [], conversas_marcadas: 0 });
    expect(db.escritas).toEqual([]);
  });

  it("com vínculo → marca o contato e TODAS as conversas não arquivadas", async () => {
    const db = bancoFalso({
      vinculos: [{ id: "v1", organization_id: ORG, provider: "despachocerto", external_id: "cli-9", contact_id: "c1" }],
      contatos: [{ id: "c1", organization_id: ORG, tags: ["VIP"] }],
      conversas: [
        { id: "k1", organization_id: ORG, contact_id: "c1", status: "open", tags: [] },
        { id: "k2", organization_id: ORG, contact_id: "c1", status: "closed", tags: ["Orçamento"] },
        { id: "k3", organization_id: ORG, contact_id: "c1", status: "archived", tags: [] },
        { id: "k4", organization_id: ORG, contact_id: "OUTRO", status: "open", tags: [] },
      ],
    });

    const r = await aplicarEventoDeOs(db.client as never, ORG, evento(), "req-2");

    expect(r.vinculado).toBe(true);
    expect(r.tags_novas).toEqual(["OS 1234", "ABC1D23"]);
    expect(r.conversas_marcadas).toBe(2);
    expect(db.tabelas.contacts![0]!.tags).toEqual(["VIP", "OS 1234", "ABC1D23"]);
    // A arquivada e a de outro contato ficam intactas.
    expect(db.tabelas.conversations!.find((c) => c.id === "k3")!.tags).toEqual([]);
    expect(db.tabelas.conversations!.find((c) => c.id === "k4")!.tags).toEqual([]);
  });

  it("o mesmo evento duas vezes NÃO escreve de novo", async () => {
    const db = bancoFalso({
      vinculos: [{ id: "v1", organization_id: ORG, provider: "despachocerto", external_id: "cli-9", contact_id: "c1" }],
      contatos: [{ id: "c1", organization_id: ORG, tags: [] }],
      conversas: [{ id: "k1", organization_id: ORG, contact_id: "c1", status: "open", tags: [] }],
    });

    await aplicarEventoDeOs(db.client as never, ORG, evento(), "req-3");
    const depoisDoPrimeiro = db.escritas.length;
    const r = await aplicarEventoDeOs(db.client as never, ORG, evento(), "req-4");

    expect(r.tags_novas).toEqual([]);
    expect(r.conversas_marcadas).toBe(0);
    expect(db.escritas.length).toBe(depoisDoPrimeiro);
  });

  it("OS de outra organização não alcança este contato", async () => {
    const db = bancoFalso({
      vinculos: [{ id: "v1", organization_id: "outra-org", provider: "despachocerto", external_id: "cli-9", contact_id: "c1" }],
      contatos: [{ id: "c1", organization_id: ORG, tags: [] }],
    });
    const r = await aplicarEventoDeOs(db.client as never, ORG, evento(), "req-5");
    expect(r.vinculado).toBe(false);
    expect(db.tabelas.contacts![0]!.tags).toEqual([]);
  });

  it("OS sem placa marca só a OS", async () => {
    const db = bancoFalso({
      vinculos: [{ id: "v1", organization_id: ORG, provider: "despachocerto", external_id: "cli-9", contact_id: "c1" }],
      contatos: [{ id: "c1", organization_id: ORG, tags: [] }],
      conversas: [],
    });
    const r = await aplicarEventoDeOs(db.client as never, ORG, evento({ plate: null }), "req-6");
    expect(r.tags_novas).toEqual(["OS 1234"]);
  });
});
