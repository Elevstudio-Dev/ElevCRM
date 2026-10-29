// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest";

import { aplicarMarcador, previaDoMarcador } from "./fora-do-funil";

/**
 * O marcador "fora do funil", sem HTTP. O dublê do Supabase é um banco em memória de verdade (filtra por `eq` e
 * `in`, aplica `update`): é o que deixa estes casos provarem o RESULTADO — quem mudou, o que ficou — e não só que
 * "foi chamado um método".
 */
const ORG = "org-1";
const OUTRA = "org-2";
const EU = "user-1";

type Linha = Record<string, unknown>;
let tabelas: { contacts: Linha[]; crm_leads: Linha[] };

function dublê() {
  return {
    from(nome: "contacts" | "crm_leads") {
      let filtros: Array<(l: Linha) => boolean> = [];
      let patch: Linha | null = null;
      let teto: number | null = null;
      const executa = () => {
        const alvo = tabelas[nome].filter((l) => filtros.every((f) => f(l)));
        if (patch) {
          for (const l of alvo) Object.assign(l, patch);
          return { data: null, error: null };
        }
        return { data: teto === null ? alvo : alvo.slice(0, teto), error: null };
      };
      const b: Record<string, unknown> = {};
      Object.assign(b, {
        select: () => b,
        update: (p: Linha) => {
          patch = p;
          return b;
        },
        eq: (col: string, v: unknown) => {
          filtros.push((l) => l[col] === v);
          return b;
        },
        in: (col: string, vs: unknown[]) => {
          filtros.push((l) => vs.includes(l[col]));
          return b;
        },
        limit: (n: number) => {
          teto = n;
          return b;
        },
        then: (r: (v: unknown) => void) => Promise.resolve(executa()).then(r),
      });
      filtros = [];
      return b;
    },
  } as never;
}

const contato = (id: string, org = ORG, fora: string | null = null): Linha => ({
  id,
  organization_id: org,
  fora_do_funil_em: fora,
  fora_do_funil_tipo_id: null,
  fora_do_funil_por: null,
});
const negocio = (contact: string, status: string, over: Linha = {}): Linha => ({
  organization_id: ORG,
  contact_id: contact,
  status,
  value_cents: null,
  currency: "BRL",
  fora_do_funil: false,
  ...over,
});

beforeEach(() => {
  tabelas = {
    contacts: [contato("a"), contato("b"), contato("c", ORG, "2026-10-01T00:00:00Z"), contato("z", OUTRA)],
    crm_leads: [
      negocio("a", "open"),
      negocio("a", "won", { value_cents: 150_000 }),
      negocio("a", "won", { value_cents: 99_000, currency: "USD" }),
      negocio("a", "lost"),
      negocio("b", "open"),
      negocio("c", "open", { fora_do_funil: true }),
      negocio("z", "open", { organization_id: OUTRA }),
    ],
  };
});

describe("previaDoMarcador — o que o diálogo mostra antes de confirmar", () => {
  it("ao marcar: conta os negócios que SAEM, por situação, e o valor ganho só em reais", async () => {
    const p = await previaDoMarcador(dublê(), ORG, ["a"], true);
    expect(p.contatos).toBe(1);
    expect(p.negocios).toEqual({ abertos: 1, ganhos: 2, perdidos: 1, valor_ganho_cents: 150_000 });
    expect(p.aproximado).toBe(false);
  });

  it("não conta negócio que já estava escondido, nem contato de OUTRA organização", async () => {
    const p = await previaDoMarcador(dublê(), ORG, ["c", "z"], true);
    expect(p.contatos).toBe(0); // c já está marcado; z não é desta organização
    expect(p.negocios.abertos).toBe(0);
  });

  it("ao desmarcar: conta os negócios que VOLTAM (os escondidos)", async () => {
    const p = await previaDoMarcador(dublê(), ORG, ["c"], false);
    expect(p.contatos).toBe(1);
    expect(p.negocios.abertos).toBe(1);
  });

  it("desmarcar quem nem estava marcado não muda nada", async () => {
    const p = await previaDoMarcador(dublê(), ORG, ["a", "b"], false);
    expect(p.contatos).toBe(0);
  });

  it("mais de mil negócios: a contagem é declarada como piso", async () => {
    tabelas.crm_leads = Array.from({ length: 1001 }, () => negocio("a", "open"));
    const p = await previaDoMarcador(dublê(), ORG, ["a"], true);
    expect(p.aproximado).toBe(true);
    expect(p.negocios.abertos).toBe(1000);
  });
});

describe("aplicarMarcador", () => {
  it("marcar grava quando, quem e o tipo — e devolve só quem de fato mudou", async () => {
    const r = await aplicarMarcador(dublê(), { organizationId: ORG, userId: EU, contactIds: ["a", "c"], marcar: true, tipoId: "tipo-1" });
    expect(r.alterados).toEqual(["a"]); // c já estava marcado
    const a = tabelas.contacts.find((c) => c.id === "a")!;
    expect(a.fora_do_funil_em).toEqual(expect.any(String));
    expect(a.fora_do_funil_por).toBe(EU);
    expect(a.fora_do_funil_tipo_id).toBe("tipo-1");
    expect(r.previa.negocios.abertos).toBe(1);
  });

  it("quem JÁ estava marcado e vem com tipo novo troca só o tipo (data e autor ficam)", async () => {
    await aplicarMarcador(dublê(), { organizationId: ORG, userId: EU, contactIds: ["c"], marcar: true, tipoId: "tipo-2" });
    const c = tabelas.contacts.find((x) => x.id === "c")!;
    expect(c.fora_do_funil_em).toBe("2026-10-01T00:00:00Z");
    expect(c.fora_do_funil_por).toBeNull();
    expect(c.fora_do_funil_tipo_id).toBe("tipo-2");
  });

  it("sem tipo no pedido (undefined), quem já estava marcado NÃO perde o tipo", async () => {
    tabelas.contacts.find((x) => x.id === "c")!.fora_do_funil_tipo_id = "tipo-9";
    await aplicarMarcador(dublê(), { organizationId: ORG, userId: EU, contactIds: ["c"], marcar: true });
    expect(tabelas.contacts.find((x) => x.id === "c")!.fora_do_funil_tipo_id).toBe("tipo-9");
  });

  it("desmarcar limpa o marcador, o tipo e o autor", async () => {
    tabelas.contacts.find((x) => x.id === "c")!.fora_do_funil_tipo_id = "tipo-9";
    const r = await aplicarMarcador(dublê(), { organizationId: ORG, userId: EU, contactIds: ["c"], marcar: false, tipoId: "ignorado" });
    expect(r.alterados).toEqual(["c"]);
    expect(tabelas.contacts.find((x) => x.id === "c")).toMatchObject({
      fora_do_funil_em: null,
      fora_do_funil_tipo_id: null,
      fora_do_funil_por: null,
    });
  });

  it("NUNCA toca contato de outra organização, mesmo com o id certo", async () => {
    const r = await aplicarMarcador(dublê(), { organizationId: ORG, userId: EU, contactIds: ["z"], marcar: true });
    expect(r.alterados).toEqual([]);
    expect(tabelas.contacts.find((x) => x.id === "z")!.fora_do_funil_em).toBeNull();
  });
});
