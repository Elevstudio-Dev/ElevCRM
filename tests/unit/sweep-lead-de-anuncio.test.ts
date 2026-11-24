import { describe, expect, it } from "vitest";

import { createSupabaseSilenceSweepDb } from "@/lib/followup/silence-sweep";

/**
 * A consulta de PRODUÇÃO do varredor de silêncio aplica a regra "lead de anúncio só depois da avaliação".
 *
 * O dublê aqui DEVOLVE DADOS por tabela (conversas e leads), então o filtro é exercitado de verdade — não só a
 * chamada, como no teste de conversa encerrada. A ressalva continua: a semântica do PostgREST (embed
 * `etapa:stage_id(slug)`, ordem decrescente) só é provada por produção.
 */

const LONGE = "2026-11-01T10:00:00.000Z"; // bem antes do corte
const CORTE = new Date("2026-11-20T12:00:00Z").toISOString();

type Linha = Record<string, unknown>;

function conversa(contactId: string, source: string, metadata: Linha | null): Linha {
  return {
    contact_id: contactId,
    last_inbound_at: LONGE,
    contacts: {
      tags: ["followup-ia"],
      is_blocked: false,
      ai_authorized_at: null,
      source,
      source_metadata: metadata,
    },
    sessao: { metadata: {} },
  };
}

function fakeSupabase(tabelas: { conversations: Linha[]; crm_leads: Linha[] }) {
  const consultas: { tabela: string; metodos: { metodo: string; args: unknown[] }[] }[] = [];
  const client = {
    from(tabela: string) {
      const registro = { tabela, metodos: [] as { metodo: string; args: unknown[] }[] };
      consultas.push(registro);
      const proxy: Record<string, unknown> = new Proxy(
        {},
        {
          get(_t, prop) {
            if (prop === "then") {
              const data = tabela === "conversations" ? tabelas.conversations : tabelas.crm_leads;
              return (ok: (v: unknown) => unknown) => ok({ data, error: null });
            }
            return (...args: unknown[]) => {
              registro.metodos.push({ metodo: String(prop), args });
              return proxy;
            };
          },
        },
      ) as Record<string, unknown>;
      return proxy;
    },
  };
  return { client: client as never, consultas };
}

const REGRA = { liberar_nas_etapas: ["compareceu", "orcamento_apresentado", "em_tratamento"] };
const ANUNCIO = { ad_platform: "meta_ads" };

function lead(contactId: string, source: string, slug: string | null): Linha {
  return { contact_id: contactId, source, created_at: LONGE, etapa: slug ? { slug } : null };
}

describe("varredor de silêncio — lead de anúncio só depois da avaliação", () => {
  const conversations = [
    conversa("anuncio-novo", "meta_ads", ANUNCIO),
    conversa("anuncio-avaliado", "meta_ads", ANUNCIO),
    conversa("organico", "whatsapp", null),
    conversa("so-o-lead-tem-marca", "whatsapp", null),
  ];
  const crm_leads = [
    lead("anuncio-novo", "meta_ads", "entendendo_o_caso"),
    lead("anuncio-avaliado", "meta_ads", "compareceu"),
    lead("organico", "whatsapp", "entendendo_o_caso"),
    lead("so-o-lead-tem-marca", "meta_ads", "novo_contato"),
  ];

  it("COM a regra: anúncio antes da avaliação fica de fora; avaliado e orgânico entram", async () => {
    const { client } = fakeSupabase({ conversations, crm_leads });
    const ids = await createSupabaseSilenceSweepDb(client).loadSilentContactIds("org-1", CORTE, [], REGRA);
    expect([...ids].sort()).toEqual(["anuncio-avaliado", "organico"]);
  });

  it("SEM a regra: todos entram, como sempre (e nem consulta os leads)", async () => {
    const { client, consultas } = fakeSupabase({ conversations, crm_leads });
    const ids = await createSupabaseSilenceSweepDb(client).loadSilentContactIds("org-1", CORTE, [], null);
    expect([...ids].sort()).toEqual(["anuncio-avaliado", "anuncio-novo", "organico", "so-o-lead-tem-marca"]);
    expect(consultas.map((c) => c.tabela)).not.toContain("crm_leads");
  });

  it("a consulta de leads é da ORGANIZAÇÃO e pega o mais recente primeiro", async () => {
    const { client, consultas } = fakeSupabase({ conversations, crm_leads });
    await createSupabaseSilenceSweepDb(client).loadSilentContactIds("org-1", CORTE, [], REGRA);
    const q = consultas.find((c) => c.tabela === "crm_leads");
    expect(q, "a regra ligada tem de consultar os leads").toBeDefined();
    expect(q!.metodos.some((m) => m.metodo === "eq" && m.args[0] === "organization_id" && m.args[1] === "org-1")).toBe(true);
    expect(q!.metodos.some((m) => m.metodo === "order" && m.args[0] === "created_at")).toBe(true);
  });

  it("o lead MAIS RECENTE manda: se o primeiro da lista já é a etapa liberada, entra", async () => {
    const { client } = fakeSupabase({
      conversations: [conversa("a", "meta_ads", ANUNCIO)],
      // ordem decrescente de created_at: o primeiro é o mais recente
      crm_leads: [lead("a", "meta_ads", "em_tratamento"), lead("a", "meta_ads", "novo_contato")],
    });
    const ids = await createSupabaseSilenceSweepDb(client).loadSilentContactIds("org-1", CORTE, [], REGRA);
    expect(ids).toEqual(["a"]);
  });

  it("anúncio sem lead nenhum não entra", async () => {
    const { client } = fakeSupabase({ conversations: [conversa("a", "meta_ads", ANUNCIO)], crm_leads: [] });
    const ids = await createSupabaseSilenceSweepDb(client).loadSilentContactIds("org-1", CORTE, [], REGRA);
    expect(ids).toEqual([]);
  });
});
