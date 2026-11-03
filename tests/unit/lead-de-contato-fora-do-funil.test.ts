// @vitest-environment node
import { describe, expect, it } from "vitest";

import { createLeadHandler } from "@/app/api/v1/leads/_handler";
import { ApiError } from "@/lib/api/types";
import { MOTIVO_DA_RECUSA_LABEL, motivoDaRecusaDoErro } from "@/lib/webhooks/captacao";

/**
 * NENHUM NEGÓCIO NASCE PARA QUEM ESTÁ FORA DO FUNIL — por NENHUMA porta.
 *
 * `createLeadHandler` é a porta única: o POST da API, a importação de planilha, a ferramenta MCP do agente, a ação
 * "criar ou mover negócio" da automação e o webhook de formulário passam todos por ele. Por isso a recusa mora
 * nele, e não em cada chamador — o chamador que esquecesse deixaria a equipe do cliente virar lead por um formulário.
 */
interface Chamada {
  tabela: string;
  filtros: Array<[string, unknown]>;
}

function dublê(contato: { fora_do_funil_em: string | null } | null) {
  const chamadas: Chamada[] = [];
  const supabase = {
    from(tabela: string) {
      const c: Chamada = { tabela, filtros: [] };
      chamadas.push(c);
      const b: Record<string, unknown> = {};
      Object.assign(b, {
        select: () => b,
        eq: (coluna: string, valor: unknown) => {
          c.filtros.push([coluna, valor]);
          return b;
        },
        order: () => b,
        limit: () => b,
        maybeSingle: async () => ({ data: tabela === "contacts" ? contato : null, error: null }),
        insert: () => b,
      });
      return b;
    },
  };
  return { supabase: supabase as never, chamadas };
}

const CTX = { organization_id: "org-1", actor: { type: "user", id: "u-1" }, requestId: "req-1" } as never;
const ENTRADA = {
  pipeline_id: "p-1",
  stage_id: "s-1",
  title: "Negócio",
  contact_id: "ct-1",
  currency: "BRL",
  tags: [],
  source: "manual",
} as never;

describe("createLeadHandler e o contato fora do funil", () => {
  it("recusa com 409 e código PRÓPRIO, e nem chega a tocar em crm_leads", async () => {
    const { supabase, chamadas } = dublê({ fora_do_funil_em: "2026-10-29T12:00:00Z" });
    const erro = await createLeadHandler(supabase, CTX, ENTRADA).catch((e: unknown) => e);
    expect(erro).toBeInstanceOf(ApiError);
    const e = erro as ApiError;
    expect(e.status).toBe(409);
    expect(e.code).toBe("contato_fora_do_funil");
    expect(e.message).toMatch(/fora do funil/i);
    expect(chamadas.map((c) => c.tabela)).not.toContain("crm_leads");
  });

  it("procura o contato SÓ na organização do pedido (nunca confia no id sozinho)", async () => {
    const { supabase, chamadas } = dublê({ fora_do_funil_em: "2026-10-29T12:00:00Z" });
    await createLeadHandler(supabase, CTX, ENTRADA).catch(() => undefined);
    const consulta = chamadas.find((c) => c.tabela === "contacts")!;
    expect(consulta.filtros).toContainEqual(["organization_id", "org-1"]);
    expect(consulta.filtros).toContainEqual(["id", "ct-1"]);
  });

  it("contato do funil: a recusa NÃO acontece (o fluxo segue para a etapa)", async () => {
    const { supabase } = dublê({ fora_do_funil_em: null });
    const erro = await createLeadHandler(supabase, CTX, ENTRADA).catch((e: unknown) => e);
    // O dublê não tem etapa, então o fluxo para na validação da etapa (404) — o que prova que PASSOU pelo contato.
    expect(erro).toBeInstanceOf(ApiError);
    expect((erro as ApiError).code).not.toBe("contato_fora_do_funil");
  });

  it("negócio SEM contato não consulta contato nenhum", async () => {
    const { supabase, chamadas } = dublê(null);
    await createLeadHandler(supabase, CTX, { ...(ENTRADA as object), contact_id: undefined } as never).catch(() => undefined);
    expect(chamadas.map((c) => c.tabela)).not.toContain("contacts");
  });
});

describe("captação por formulário recusada por este motivo", () => {
  it("o código do erro vira o motivo da recusa, com texto em português de gente", () => {
    expect(motivoDaRecusaDoErro("contato_fora_do_funil")).toBe("contato_fora_do_funil");
    expect(MOTIVO_DA_RECUSA_LABEL.contato_fora_do_funil).toMatch(/fora do funil/i);
  });

  it("qualquer outro erro continua sendo 'erro_ao_criar_lead'", () => {
    expect(motivoDaRecusaDoErro("internal_error")).toBe("erro_ao_criar_lead");
    expect(motivoDaRecusaDoErro("not_found")).toBe("erro_ao_criar_lead");
  });
});
