/**
 * A lista de contatos sabe separar quem está "fora do funil" (equipe, prestador, parceiro) de quem é cliente.
 */
import { describe, expect, it } from "vitest";

import { listContactsHandler } from "@/app/api/v1/contacts/_handler";
import { contactListQuerySchema } from "@/lib/schemas/contacts";

const ORG = "11111111-1111-4111-8111-111111111111";
const TIPO = "22222222-2222-4222-8222-222222222222";

function espiao() {
  const eqs: Array<[string, unknown]> = [];
  const isNull: string[] = [];
  const notNull: string[] = [];
  let colunas = "";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const chain: any = {
    select: (c: string) => {
      colunas = c;
      return chain;
    },
    eq: (col: string, v: unknown) => {
      eqs.push([col, v]);
      return chain;
    },
    order: () => chain,
    limit: () => chain,
    contains: () => chain,
    or: () => chain,
    is: (col: string) => {
      isNull.push(col);
      return chain;
    },
    not: (col: string, op: string) => {
      if (op === "is") notNull.push(col);
      return chain;
    },
    then: (res: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(res),
  };
  return { client: { from: () => chain } as never, eqs, isNull, notNull, colunas: () => colunas };
}

const CTX = { organization_id: ORG, actor: { type: "user", id: "u-1" }, requestId: "req" } as never;
const listar = (client: never, query: Record<string, unknown>) =>
  listContactsHandler(client, CTX, { limit: 25, ...query } as never);

describe("GET contatos — filtro 'fora do funil'", () => {
  it("'sim' traz só quem tem o marcador", async () => {
    const e = espiao();
    await listar(e.client, { fora_do_funil: "sim" });
    expect(e.notNull).toEqual(["fora_do_funil_em"]);
    expect(e.isNull).not.toContain("fora_do_funil_em");
  });

  it("'nao' traz só quem NÃO tem o marcador (os clientes)", async () => {
    const e = espiao();
    await listar(e.client, { fora_do_funil: "nao" });
    expect(e.isNull).toContain("fora_do_funil_em");
    expect(e.notNull).toEqual([]);
  });

  it("sem o parâmetro, a lista é a de sempre (todos)", async () => {
    const e = espiao();
    await listar(e.client, {});
    expect(e.isNull).not.toContain("fora_do_funil_em");
    expect(e.notNull).toEqual([]);
  });

  it("filtra por tipo, sempre dentro da organização", async () => {
    const e = espiao();
    await listar(e.client, { tipo_id: TIPO });
    expect(e.eqs).toContainEqual(["fora_do_funil_tipo_id", TIPO]);
    expect(e.eqs).toContainEqual(["organization_id", ORG]);
  });

  it("a lista PEDE as colunas do marcador (sem elas a tela não tem como mostrar o selo)", async () => {
    const e = espiao();
    await listar(e.client, {});
    for (const c of ["fora_do_funil_em", "fora_do_funil_tipo_id"]) expect(e.colunas()).toContain(c);
  });
});

describe("contactListQuerySchema — o que a rota aceita", () => {
  it("aceita sim/nao e um uuid de tipo", () => {
    expect(contactListQuerySchema.safeParse({ fora_do_funil: "sim" }).success).toBe(true);
    expect(contactListQuerySchema.safeParse({ fora_do_funil: "nao", tipo_id: TIPO }).success).toBe(true);
  });
  it("recusa valor solto e tipo que não é uuid", () => {
    expect(contactListQuerySchema.safeParse({ fora_do_funil: "talvez" }).success).toBe(false);
    expect(contactListQuerySchema.safeParse({ tipo_id: "x" }).success).toBe(false);
  });
});
