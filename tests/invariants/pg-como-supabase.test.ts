import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

import { pgComoSupabase } from "../pg-como-supabase";

/**
 * O INSTRUMENTO, medido antes de medir.
 *
 * `tests/pg-como-supabase.ts` é o que permite exercitar código que fala
 * `supabase.from(...)` contra o Postgres real do `test:db`. Um adaptador que
 * ignorasse um `.eq()` faria os testes que dependem dele passarem **pelo motivo
 * errado** — e nada vermelharia.
 *
 * Cada caso aqui é a sabotagem de uma peça do adaptador: filtro que não filtra,
 * ordem que não ordena, `maybeSingle` que engole duplicata, erro de constraint
 * que vira exceção em vez de `{error}`. Se um deles for removido, o teste que o
 * usa perde a garantia sem avisar.
 */
const container = process.env.TEST_DB_CONTAINER;
if (!container) {
  throw new Error("TEST_DB_CONTAINER not set — rode via `pnpm test:db` (scripts/test-db.sh)");
}

const PORT = Number(process.env.TEST_DB_PORT ?? 54329);
const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`,
  max: 2,
});
const db = pgComoSupabase(pool);

const ORG = "ada57e00-0000-4000-8000-000000000001";

beforeAll(async () => {
  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name)
     values ($1, 'org-adaptador', 'Adaptador LTDA', 'Adaptador') on conflict (id) do nothing`,
    [ORG],
  );
  // O trigger fn_seed_default_pipeline_for_org já criou "Pedidos". Estes são
  // funis EXTRA, com `position` fora de ordem alfabética de propósito.
  await pool.query(
    `insert into crm_pipelines (organization_id, name, slug, is_default, position) values
       ($1, 'Zulu',  'zulu',  false, 10),
       ($1, 'Alfa',  'alfa',  false, 30),
       ($1, 'Bravo', 'bravo', false, 20)
     on conflict do nothing`,
    [ORG],
  );
});

afterAll(async () => {
  await pool.query("delete from organizations where id = $1", [ORG]);
  await pool.end();
});

describe("o adaptador FILTRA", () => {
  it("`.eq` restringe de verdade — sem isto, todo teste que o usa mede a tabela inteira", async () => {
    const { data, error } = await db
      .from("crm_pipelines")
      .select("name")
      .eq("organization_id", ORG)
      .eq("slug", "bravo")
      .maybeSingle();

    expect(error).toBeNull();
    // Se `.eq("slug",...)` fosse ignorado, viriam 4 linhas e `maybeSingle`
    // devolveria erro — a asserção abaixo morre nos dois casos.
    expect((data as { name: string } | null)?.name).toBe("Bravo");
  });

  it("filtro que não casa devolve `data: null` SEM erro — 'não achei' ≠ 'falhou'", async () => {
    const { data, error } = await db
      .from("crm_pipelines")
      .select("name")
      .eq("organization_id", ORG)
      .eq("slug", "nao-existe-este")
      .maybeSingle();

    expect(error).toBeNull();
    expect(data).toBeNull();
  });
});

describe("o adaptador COMPARA — `lt`/`gt`, não só igualdade", () => {
  // Nasceram por pressão do mesmo mecanismo que trouxe `update` e `rpc`: o
  // `naoImplementado` estourou quando `vencePropostasDeDado` chamou `.lt`. Se
  // tivesse devolvido vazio, os 7 casos de vencimento ficariam VERDES medindo
  // nada — "nenhuma proposta vencida" é o resultado natural de uma lista vazia.
  it("`lt` filtra por menor que, e não devolve a tabela inteira", async () => {
    const { data } = await db
      .from("crm_pipelines")
      .select("name,position")
      .eq("organization_id", ORG)
      .eq("is_default", false)
      .lt("position", 25)
      .order("position", { ascending: true });
    const nomes = (data as Array<{ name: string }>).map((x) => x.name).sort();
    // position 10 e 20 entram; 30 fica de fora.
    expect(nomes).toEqual(["Bravo", "Zulu"]);
  });

  it("`gt` é o espelho — e os dois convivem com `eq` na mesma consulta", async () => {
    const { data } = await db
      .from("crm_pipelines")
      .select("name")
      .eq("organization_id", ORG)
      .eq("is_default", false)
      .gt("position", 25);
    expect((data as Array<{ name: string }>).map((x) => x.name)).toEqual(["Alfa"]);
  });
});

describe("o adaptador testa NULO — `.is(c, null)` e `.not(c, 'is', null)`", () => {
  // Nasceram porque o cron `agenda-google-push` filtra `owner_user_id` não nulo
  // e (agora) `origem_relato_id` nulo. Sem eles o adaptador estourava no
  // `.not(...)` e o invariante do espelho de relato não chegava a medir nada.
  // Dois funis na mesma `position` (25: nem `lt` nem `gt` dos outros casos o enxergam), um com `description`, outro sem: os
  // dois filtros só acertam se cada um separar os dois de verdade.
  beforeAll(async () => {
    await pool.query(
      `insert into crm_pipelines (organization_id, name, slug, position, description) values
         ($1, 'Com descricao', 'nulo-com-descricao', 25, 'tem texto'),
         ($1, 'Sem descricao', 'nulo-sem-descricao', 25, null)
       on conflict do nothing`,
      [ORG],
    );
  });

  it("`.is(c, null)` traz SÓ as linhas de coluna nula", async () => {
    const { data, error } = await db
      .from("crm_pipelines")
      .select("name")
      .eq("organization_id", ORG)
      .eq("position", 25)
      .is("description", null);
    expect(error).toBeNull();
    expect((data as Array<{ name: string }>).map((x) => x.name)).toEqual(["Sem descricao"]);
  });

  it("`.not(c, 'is', null)` traz SÓ as linhas de coluna preenchida — o espelho exato do anterior", async () => {
    const { data, error } = await db
      .from("crm_pipelines")
      .select("name")
      .eq("organization_id", ORG)
      .eq("position", 25)
      .not("description", "is", null);
    expect(error).toBeNull();
    expect((data as Array<{ name: string }>).map((x) => x.name)).toEqual(["Com descricao"]);
  });

  it("o que o adaptador não confere estoura: `.is` com valor e `.not` com outro operador", () => {
    expect(() => db.from("crm_pipelines").select("id").is("description", "x")).toThrow(/não está implementado/);
    expect(() => db.from("crm_pipelines").select("id").not("description", "eq", "x")).toThrow(
      /não está implementado/,
    );
  });
});

describe("o adaptador ORDENA", () => {
  it("`.order(asc).limit(1)` traz o de menor valor, não o primeiro que o Postgres devolver", async () => {
    // Sem ordenação real o Postgres devolveria em ordem de heap — que aqui é a
    // ordem de inserção, e daria 'Zulu'. O caso só passa com ORDER BY aplicado.
    const { data } = await db
      .from("crm_pipelines")
      .select("name,position")
      .eq("organization_id", ORG)
      .eq("is_default", false)
      .order("position", { ascending: true })
      .limit(1)
      .maybeSingle();

    expect((data as { name: string } | null)?.name).toBe("Zulu"); // position 10
  });

  it("descendente inverte — a opção `ascending` é lida, não decorativa", async () => {
    const { data } = await db
      .from("crm_pipelines")
      .select("name")
      .eq("organization_id", ORG)
      .eq("is_default", false)
      .order("position", { ascending: false })
      .limit(1)
      .maybeSingle();

    expect((data as { name: string } | null)?.name).toBe("Alfa"); // position 30
  });
});

describe("o adaptador distingue os desfechos que o PostgREST distingue", () => {
  it("`maybeSingle` com MAIS DE UMA linha é ERRO — engolir a duplicata esconderia dado incoerente", async () => {
    const { data, error } = await db
      .from("crm_pipelines")
      .select("name")
      .eq("organization_id", ORG)
      .eq("is_default", false)
      .maybeSingle();

    expect(error, "3 funis não-default: tem de reclamar").not.toBeNull();
    expect(data).toBeNull();
  });

  it("`insert().select().single()` devolve a linha criada", async () => {
    const { data, error } = await db
      .from("crm_pipelines")
      .insert({ organization_id: ORG, name: "Criado", slug: "criado-pelo-adaptador", position: 99 })
      .select("id,name")
      .single();

    expect(error).toBeNull();
    expect((data as { id: string; name: string }).name).toBe("Criado");
    expect((data as { id: string }).id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("`insert().select().maybeSingle()` também devolve a linha — a forma que o vencimento usa", async () => {
    // Terceira ausência que o `naoImplementado` denunciou em vez de engolir.
    const { data, error } = await db
      .from("crm_pipelines")
      .insert({ organization_id: ORG, name: "Talvez", slug: "talvez-adaptador", position: 98 })
      .select("id,name")
      .maybeSingle();
    expect(error).toBeNull();
    expect((data as { name: string }).name).toBe("Talvez");
  });

  it("violação de constraint vira `{error}`, NUNCA exceção — o chamador trata desfecho, não catch", async () => {
    // `organization_id` inexistente: viola a FK.
    const { data, error } = await db
      .from("crm_pipelines")
      .insert({
        organization_id: "ada57e00-0000-4000-8000-0000000000ff",
        name: "Órfão",
        slug: "orfao",
        position: 1,
      })
      .select("id")
      .single();

    expect(data).toBeNull();
    expect(error?.message).toMatch(/foreign key|violates/i);
  });
});

describe("UPDATE — implementado depois, e por pressão do próprio adaptador", () => {
  // `update` não existia; `patchContactHandler` o chamou e o adaptador ESTOUROU
  // em vez de devolver vazio. Foi o `naoImplementado` fazendo o trabalho dele:
  // se tivesse devolvido `{data:null,error:null}`, os 7 casos de
  // `contato-consent-e-auditoria.test.ts` teriam ficado VERDES medindo nada.
  it("atualiza só as linhas do filtro", async () => {
    const { rows } = await pool.query<{ id: string }>(
      `insert into crm_pipelines (organization_id, name, slug, position)
       values ($1, 'Antes', 'alvo-do-update', 5) returning id`,
      [ORG],
    );
    const alvo = rows[0]!.id;
    const { error } = await db.from("crm_pipelines").update({ name: "Depois" }).eq("id", alvo);
    expect(error).toBeNull();

    const { rows: depois } = await pool.query<{ name: string }>(
      "select name from crm_pipelines where id = $1",
      [alvo],
    );
    expect(depois[0]!.name).toBe("Depois");

    // E não encostou nos vizinhos — sem o filtro, um UPDATE renomearia a org toda.
    const { rows: vizinho } = await pool.query<{ n: string }>(
      "select count(*) as n from crm_pipelines where organization_id = $1 and name = 'Depois'",
      [ORG],
    );
    expect(vizinho[0]!.n).toBe("1");
  });

  it("`.select().maybeSingle()` devolve a linha ATUALIZADA, não a anterior", async () => {
    const { rows } = await pool.query<{ id: string }>(
      `insert into crm_pipelines (organization_id, name, slug, position)
       values ($1, 'Volta Antes', 'alvo-do-returning', 6) returning id`,
      [ORG],
    );
    const { data, error } = await db
      .from("crm_pipelines")
      .update({ name: "Volta Depois" })
      .eq("id", rows[0]!.id)
      .select("id,name")
      .maybeSingle();
    expect(error).toBeNull();
    expect((data as { name: string }).name).toBe("Volta Depois");
  });

  it("com `.select()`, o await direto devolve AS LINHAS — não null", async () => {
    // ⚠️ Este caso nasceu de um furo que o CI pegou. O repo usa
    // `update().eq(id).eq(campo).select("id")` + `if (linhas.length === 0)` como
    // TRAVA otimista ("um humano mexeu no meio da operação"). Devolvendo `null`,
    // toda escrita bem-sucedida virava conflito: o adaptador afirmava que a
    // trava disparou quando o UPDATE tinha funcionado.
    const { rows } = await pool.query<{ id: string }>(
      `insert into crm_pipelines (organization_id, name, slug, position)
       values ($1, 'Trava', 'trava-otimista', 97) returning id`,
      [ORG],
    );
    const { data, error } = await db
      .from("crm_pipelines")
      .update({ name: "Travado" })
      .eq("id", rows[0]!.id)
      .eq("name", "Trava") // a trava: só atualiza se o valor ainda for o lido
      .select("id");
    expect(error).toBeNull();
    expect(Array.isArray(data), "com select, o retorno é uma lista").toBe(true);
    expect((data as unknown[]).length, "uma linha afetada").toBe(1);

    // E quando a trava ATUA (o valor mudou no meio), a lista vem vazia — que é
    // como o chamador detecta o conflito.
    const { data: vazio } = await db
      .from("crm_pipelines")
      .update({ name: "Outro" })
      .eq("id", rows[0]!.id)
      .eq("name", "Trava") // já não é mais
      .select("id");
    expect((vazio as unknown[]).length, "a trava atuou: zero linhas").toBe(0);
  });

  it("SEM `.select()`, `data: null` continua certo — é o que o PostgREST devolve", async () => {
    const { data, error } = await db
      .from("crm_pipelines")
      .update({ name: "Sem retorno" })
      .eq("organization_id", ORG)
      .eq("slug", "trava-otimista");
    expect(error).toBeNull();
    expect(data).toBeNull();
  });

  it("filtro que não casa devolve `data: null` SEM erro", async () => {
    const { data, error } = await db
      .from("crm_pipelines")
      .update({ name: "Ninguém" })
      .eq("id", "ada57e00-0000-4000-8000-0000000000fe")
      .select("id")
      .maybeSingle();
    expect(error).toBeNull();
    expect(data).toBeNull();
  });
});

describe("rpc — argumentos NOMEADOS, como o PostgREST", () => {
  it("chama a função e devolve o valor", async () => {
    // `emit_event` é o que o handler de contatos usa; sem rpc, ele morria no
    // meio e o teste do audit media um caminho que nunca chegou ao fim.
    const r = await (db.rpc as unknown as (n: string, a: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>)(
      "emit_event",
      {
        p_event_type: "contact.updated",
        p_entity_kind: "contact",
        p_entity_id: "ada57e00-0000-4000-8000-0000000000fd",
        p_payload: { fields: ["email"] },
        p_metadata: { request_id: "req-adaptador" },
        p_organization_id: ORG,
      },
    );
    expect(r.error).toBeNull();
  });

  it("função inexistente vira `{error}`, não exceção", async () => {
    const r = await (db.rpc as unknown as (n: string, a: Record<string, unknown>) => Promise<{ data: unknown; error: { message: string } | null }>)(
      "fn_que_nao_existe_no_schema",
      {},
    );
    expect(r.error?.message).toMatch(/does not exist|não existe/i);
  });
});

describe("`in`, `is null`, `not is null`, `like` — nasceram com o aplicador da agenda da secretaria", () => {
  it("`in` restringe à lista (e não devolve a tabela inteira)", async () => {
    const { data, error } = await db
      .from("crm_pipelines")
      .select("name")
      .eq("organization_id", ORG)
      .in("slug", ["zulu", "alfa"]);
    expect(error).toBeNull();
    expect((data as Array<{ name: string }>).map((x) => x.name).sort()).toEqual(["Alfa", "Zulu"]);
  });

  it("`is(col, null)` e `not(col, 'is', null)` separam os dois lados — juntos dão a tabela inteira, nunca a mesma metade", async () => {
    await pool.query(
      `insert into crm_pipelines (organization_id, name, slug, position, description)
       values ($1, 'ComDescricao', 'com-descricao', 50, 'x') on conflict do nothing`,
      [ORG],
    );
    const nulos = await db.from("crm_pipelines").select("slug").eq("organization_id", ORG).is("description", null);
    const naoNulos = await db
      .from("crm_pipelines")
      .select("slug")
      .eq("organization_id", ORG)
      .not("description", "is", null);
    const todos = await db.from("crm_pipelines").select("slug").eq("organization_id", ORG);
    const lista = (r: { data: unknown }) => (r.data as Array<{ slug: string }>).map((x) => x.slug);
    expect(lista(naoNulos)).toContain("com-descricao");
    expect(lista(nulos)).not.toContain("com-descricao");
    expect(lista(nulos)).toContain("bravo");
    expect(lista(naoNulos)).not.toContain("bravo");
    expect(lista(nulos).length + lista(naoNulos).length).toBe(lista(todos).length);
  });

  it("`like` casa por padrão", async () => {
    const { data } = await db.from("crm_pipelines").select("slug").eq("organization_id", ORG).like("slug", "bra%");
    expect((data as Array<{ slug: string }>).map((x) => x.slug)).toEqual(["bravo"]);
  });

  it("`not` com outro operador ESTOURA (só `is null` foi implementado)", () => {
    expect(() => db.from("crm_pipelines").select("id").not("slug", "eq", "x")).toThrow(/não está implementado/);
  });
});

describe("insert em LISTA é um statement só — ou entram todas, ou nenhuma (como no PostgREST)", () => {
  it("duas linhas boas: entram as duas", async () => {
    const { error } = await db.from("crm_pipelines").insert([
      { organization_id: ORG, name: "Lote A", slug: "lote-a", position: 61 },
      { organization_id: ORG, name: "Lote B", slug: "lote-b", position: 62 },
    ]);
    expect(error).toBeNull();
    const { rows } = await pool.query(`select count(*)::int as n from crm_pipelines where organization_id = $1 and slug like 'lote-%'`, [ORG]);
    expect(rows[0].n).toBe(2);
  });

  it("uma boa e uma que viola a FK: NENHUMA entra — o erro volta como `{error}`", async () => {
    const { error } = await db.from("crm_pipelines").insert([
      { organization_id: ORG, name: "Atomica", slug: "atomica-ok", position: 63 },
      { organization_id: "ada57e00-0000-4000-8000-0000000000ff", name: "Orfa", slug: "atomica-orfa", position: 64 },
    ]);
    expect(error?.message).toMatch(/foreign key|violates/i);
    const { rows } = await pool.query(`select count(*)::int as n from crm_pipelines where slug = 'atomica-ok'`);
    expect(rows[0].n).toBe(0);
  });
});

describe("update com `in` e delete com filtro", () => {
  it("update `.in(id, [...])` mexe só nas linhas da lista", async () => {
    const { rows } = await pool.query<{ id: string; slug: string }>(
      `insert into crm_pipelines (organization_id, name, slug, position) values
         ($1, 'U1', 'upd-in-1', 71), ($1, 'U2', 'upd-in-2', 72), ($1, 'U3', 'upd-in-3', 73)
       returning id, slug`,
      [ORG],
    );
    const ids = rows.filter((r) => r.slug !== "upd-in-3").map((r) => r.id);
    const { error } = await db.from("crm_pipelines").update({ name: "Mexido" }).eq("organization_id", ORG).in("id", ids);
    expect(error).toBeNull();
    const { rows: depois } = await pool.query<{ slug: string; name: string }>(
      `select slug, name from crm_pipelines where slug like 'upd-in-%' order by slug`,
    );
    expect(depois.map((d) => d.name)).toEqual(["Mexido", "Mexido", "U3"]);
  });

  it("delete `.eq().in()` apaga só as linhas do filtro; delete SEM filtro estoura (nunca apaga a tabela)", async () => {
    const { rows } = await pool.query<{ id: string }>(
      `insert into crm_pipelines (organization_id, name, slug, position) values
         ($1, 'D1', 'del-1', 81), ($1, 'D2', 'del-2', 82) returning id`,
      [ORG],
    );
    const { error } = await db.from("crm_pipelines").delete().eq("organization_id", ORG).in("id", [rows[0]!.id]);
    expect(error).toBeNull();
    const { rows: restam } = await pool.query<{ slug: string }>(`select slug from crm_pipelines where slug like 'del-%'`);
    expect(restam.map((r) => r.slug)).toEqual(["del-2"]);
    await expect(Promise.resolve().then(() => db.from("crm_pipelines").delete())).rejects.toThrow(/não está implementado/);
  });
});

describe("o que NÃO está implementado estoura", () => {
  it("método ausente lança em vez de devolver vazio — vazio silencioso é teste verde medindo nada", () => {
    expect(() => db.from("crm_pipelines").upsert({})).toThrow(/não está implementado/);
    expect(() => db.from("crm_pipelines").select("id").neq("id", "x")).toThrow(/não está implementado/);
  });
});
