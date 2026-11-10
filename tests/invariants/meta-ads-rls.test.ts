import { execFileSync } from "node:child_process";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * META ADS (0224): quem enxerga o gasto, quem NUNCA enxerga a chave, e como o relatório junta gasto e negócios.
 *
 * Três promessas travadas aqui:
 *  1. `meta_ads_conexoes` (a chave cifrada) não é legível por NINGUÉM da sessão — nem gerente, nem dono da
 *     organização. Só o `service_role` (o servidor) a alcança.
 *  2. `meta_ads_gasto_diario` é legível pelo gestor+ da PRÓPRIA organização; atendente e gestor de outra
 *     organização recebem zero linhas; ninguém da sessão escreve.
 *  3. `fn_relatorio_de_anuncios` junta pelo CÓDIGO do anúncio, com FULL JOIN (gastou-e-ninguém-chamou aparece), e
 *     respeita a RLS (é `security invoker`).
 *
 * `set role authenticated` + `request.jwt.claims` é o caminho da produção; como `postgres` (rolbypassrls) a RLS não
 * mediria nada.
 */
const container = process.env.TEST_DB_CONTAINER;
if (!container) throw new Error("TEST_DB_CONTAINER not set — rode via `pnpm test:db` (scripts/test-db.sh)");
const containerName: string = container;

function sql(script: string): string {
  return execFileSync(
    "docker",
    ["exec", "-i", containerName, "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-tA", "-f", "-"],
    { input: script, encoding: "utf8" },
  ).trim();
}

function comoUsuario(userId: string, consulta: string): string {
  const out = sql(`
    set role authenticated;
    select set_config('request.jwt.claims', '{"sub":"${userId}"}', false);
    ${consulta}
  `);
  return out;
}

const ORG_A = "eeeeeeee-0000-4000-8000-0000000000b1";
const ORG_B = "eeeeeeee-0000-4000-8000-0000000000b2";
const GESTOR_A = "eeeeeeee-1111-4000-8000-0000000000b1";
const ATENDENTE_A = "eeeeeeee-1111-4000-8000-0000000000b2";
const GESTOR_B = "eeeeeeee-1111-4000-8000-0000000000b3";
const lead = (n: number) => `eeeeeeee-3333-4000-8000-0000000000${(0xb0 + n).toString(16)}`;

const leadSql = (
  id: string,
  org: string,
  metadata: Record<string, unknown>,
  extra: { status?: string; foraDoFunil?: boolean } = {},
) => `
  insert into public.crm_leads (id, organization_id, pipeline_id, stage_id, title, status, owner_user_id, source, source_metadata)
  select '${id}', '${org}', s.pipeline_id, s.id, 'Negócio ${id.slice(-2)}', 'open', '${GESTOR_A}', 'meta_ads',
         '${JSON.stringify(metadata).replace(/'/g, "''")}'::jsonb
    from public.crm_stages s
   where s.organization_id = '${org}' and not s.is_won and not s.is_lost
   order by s.position limit 1
  on conflict (id) do nothing;
  ${extra.status === "won" ? `update public.crm_leads set status = 'won', closed_at = now() where id = '${id}';` : ""}
  ${
    // `fora_do_funil` do negócio é ESPELHO do contato, mantido só por gatilho (0221): para tirar o negócio do funil
    // marca-se o CONTATO dele.
    extra.foraDoFunil
      ? `insert into public.contacts (id, organization_id, display_name, fora_do_funil_em)
           values ('eeeeeeee-2222-4000-8000-0000000000b5', '${org}', 'Pessoa da equipe', now()) on conflict do nothing;
         update public.crm_leads set contact_id = 'eeeeeeee-2222-4000-8000-0000000000b5' where id = '${id}';`
      : ""
  }`;

const gastoSql = (org: string, dia: string, adId: string, nome: string, centavos: number) => `
  insert into public.meta_ads_gasto_diario (organization_id, dia, ad_id, ad_name, adset_name, campaign_name, spend_cents, impressions, clicks, currency)
  values ('${org}', '${dia}', '${adId}', '${nome}', 'Conjunto', 'Campanha', ${centavos}, 100, 5, 'BRL')
  on conflict do nothing;`;

const JANELA = `now() - interval '2 days', now() + interval '1 day'`;

beforeAll(() => {
  sql(`
    insert into auth.users (id, email) values
      ('${GESTOR_A}', 'meta-gestor-a@invariant.test'),
      ('${ATENDENTE_A}', 'meta-atendente-a@invariant.test'),
      ('${GESTOR_B}', 'meta-gestor-b@invariant.test')
      on conflict (id) do nothing;
    insert into public.organizations (id, slug, legal_name, display_name) values
      ('${ORG_A}', 'meta-inv-a', 'Meta Invariant A', 'Meta A'),
      ('${ORG_B}', 'meta-inv-b', 'Meta Invariant B', 'Meta B')
      on conflict (id) do nothing;
    insert into public.user_organizations (user_id, organization_id, role, accepted_at) values
      ('${GESTOR_A}', '${ORG_A}', 'manager', now()),
      ('${ATENDENTE_A}', '${ORG_A}', 'agent', now()),
      ('${GESTOR_B}', '${ORG_B}', 'manager', now())
      on conflict do nothing;
    insert into public.meta_ads_conexoes (organization_id, ad_account_id, token_encrypted)
      values ('${ORG_A}', '1234567', '\\x00'::bytea) on conflict do nothing;
  `);
  // Anúncio 111: dois negócios e gasto. Anúncio 222: gasto e NENHUM negócio. Anúncio 333: negócio e NENHUM gasto.
  // Um negócio sem código. Um negócio fora do funil (não conta). Outra organização com gasto próprio.
  sql(leadSql(lead(1), ORG_A, { ad_title: "Clareamento", ad_raw: { sourceId: "111111" } }));
  sql(leadSql(lead(2), ORG_A, { ad_title: "Clareamento", ad_raw: { sourceId: "111111" } }, { status: "won" }));
  sql(leadSql(lead(3), ORG_A, { ad_title: "Só clique", ad_raw: { sourceId: "333333" } }));
  sql(leadSql(lead(4), ORG_A, { ad_title: "Sem código" }));
  sql(leadSql(lead(5), ORG_A, { ad_title: "Equipe", ad_raw: { sourceId: "111111" } }, { foraDoFunil: true }));
  sql(`
    ${gastoSql(ORG_A, "2000-01-01", "999999", "Anúncio antigo", 777)}
    insert into public.meta_ads_gasto_diario (organization_id, dia, ad_id, ad_name, spend_cents, currency)
    select '${ORG_A}', d::date, '111111', 'Clareamento — vídeo', 2500, 'BRL' from generate_series(now() at time zone 'America/Sao_Paulo' - interval '1 day', now() at time zone 'America/Sao_Paulo', interval '1 day') d
      on conflict do nothing;
    insert into public.meta_ads_gasto_diario (organization_id, dia, ad_id, ad_name, spend_cents, currency)
    values ('${ORG_A}', (now() at time zone 'America/Sao_Paulo')::date, '222222', 'Gastou e ninguém chamou', 9000, 'BRL') on conflict do nothing;
    insert into public.meta_ads_gasto_diario (organization_id, dia, ad_id, ad_name, spend_cents, currency)
    values ('${ORG_B}', (now() at time zone 'America/Sao_Paulo')::date, '444444', 'Da outra organização', 5000, 'BRL') on conflict do nothing;
  `);
});

describe("a chave (meta_ads_conexoes) não é legível por ninguém da sessão", () => {
  it("gerente da própria organização leva 'permission denied'", () => {
    expect(() => comoUsuario(GESTOR_A, `select count(*) from public.meta_ads_conexoes;`)).toThrow();
  });

  it("nem anon", () => {
    expect(() => sql(`set role anon; select count(*) from public.meta_ads_conexoes;`)).toThrow();
  });

  it("ninguém da sessão grava na tabela da chave", () => {
    expect(() =>
      comoUsuario(
        GESTOR_A,
        `insert into public.meta_ads_conexoes (organization_id, ad_account_id, token_encrypted) values ('${ORG_B}', '7654321', '\\x00'::bytea);`,
      ),
    ).toThrow();
  });

  it("RLS ligada e a coluna da chave é bytea (o texto da chave nunca é uma coluna legível)", () => {
    expect(sql(`select relrowsecurity from pg_class where oid = 'public.meta_ads_conexoes'::regclass;`)).toBe("t");
    expect(
      sql(`select data_type from information_schema.columns where table_name = 'meta_ads_conexoes' and column_name = 'token_encrypted';`),
    ).toBe("bytea");
  });
});

describe("o gasto (meta_ads_gasto_diario): gestor+ da própria organização", () => {
  const contar = (user: string, org: string) =>
    Number(
      comoUsuario(user, `select count(*) from public.meta_ads_gasto_diario where organization_id = '${org}';`)
        .split("\n")
        .pop(),
    );

  it("o gerente lê o da própria organização e nada da vizinha", () => {
    expect(contar(GESTOR_A, ORG_A)).toBeGreaterThanOrEqual(3);
    expect(contar(GESTOR_A, ORG_B)).toBe(0);
    expect(contar(GESTOR_B, ORG_B)).toBe(1);
    expect(contar(GESTOR_B, ORG_A)).toBe(0);
  });

  it("o atendente não enxerga o investimento da empresa", () => {
    expect(contar(ATENDENTE_A, ORG_A)).toBe(0);
  });

  it("ninguém da sessão escreve (a sincronização é do servidor)", () => {
    expect(() =>
      comoUsuario(
        GESTOR_A,
        `insert into public.meta_ads_gasto_diario (organization_id, dia, ad_id, spend_cents) values ('${ORG_A}', '2026-01-01', '555555', 1);`,
      ),
    ).toThrow();
    // Sem GRANT de UPDATE/DELETE para a sessão: a negativa é "permission denied", mais forte que "zero linhas".
    expect(() => comoUsuario(GESTOR_A, `update public.meta_ads_gasto_diario set spend_cents = 0;`)).toThrow();
    expect(() => comoUsuario(GESTOR_A, `delete from public.meta_ads_gasto_diario;`)).toThrow();
    expect(Number(sql(`select count(*) from public.meta_ads_gasto_diario where spend_cents = 0;`))).toBe(0);
    expect(Number(sql(`select count(*) from public.meta_ads_gasto_diario where organization_id = '${ORG_A}';`))).toBeGreaterThanOrEqual(3);
  });
});

describe("fn_relatorio_de_anuncios", () => {
  /** `ad_id|titulo|anuncio|leads|ganhos|gasto`, ordenado, vazio vira '∅'. */
  function linhas(user: string, org: string, janela = JANELA): string[] {
    const out = comoUsuario(
      user,
      `select coalesce(ad_id, '∅') || '|' || coalesce(titulo, '∅') || '|' || coalesce(anuncio, '∅') || '|' || leads || '|' || ganhos || '|' || gasto_cents
         from public.fn_relatorio_de_anuncios('${org}', ${janela})
        order by 1;`,
    );
    return out.split("\n").filter((l) => l.includes("|"));
  }

  it("junta negócios e gasto pelo código do anúncio", () => {
    const l = linhas(GESTOR_A, ORG_A);
    // 111111: 2 negócios (o fora do funil NÃO conta), 1 ganho; gasto de 2 dias (2 × 2500, ou 1 × 2500 conforme a hora).
    const a111 = l.find((x) => x.startsWith("111111|"))!;
    expect(a111).toMatch(/^111111\|Clareamento\|Clareamento — vídeo\|2\|1\|(2500|5000)$/);
  });

  it("FULL JOIN: o anúncio que gastou e não trouxe ninguém aparece, e o que trouxe sem gasto também", () => {
    const l = linhas(GESTOR_A, ORG_A);
    expect(l).toContain("222222|Gastou e ninguém chamou|Gastou e ninguém chamou|0|0|9000");
    expect(l).toContain("333333|Só clique|∅|1|0|0");
  });

  it("negócios sem código ficam numa linha só, com ad_id nulo", () => {
    expect(linhas(GESTOR_A, ORG_A)).toContain("∅|Sem código|∅|1|0|0");
  });

  it("o gasto fora do período não entra", () => {
    expect(linhas(GESTOR_A, ORG_A).some((x) => x.startsWith("999999|"))).toBe(false);
    const antigo = linhas(GESTOR_A, ORG_A, `'1999-12-31'::timestamptz, '2000-01-02'::timestamptz`);
    expect(antigo).toContain("999999|Anúncio antigo|Anúncio antigo|0|0|777");
  });

  it("é security invoker: atendente e gestor de outra organização recebem zero linhas", () => {
    expect(linhas(ATENDENTE_A, ORG_A).filter((x) => /\|\d+$/.test(x) && !x.endsWith("|0"))).toEqual([]);
    expect(linhas(GESTOR_B, ORG_A)).toEqual([]);
    expect(linhas(GESTOR_B, ORG_B)).toEqual(["444444|Da outra organização|Da outra organização|0|0|5000"]);
  });

  it("a função não é executável por anon", () => {
    expect(
      sql(`select has_function_privilege('anon', 'public.fn_relatorio_de_anuncios(uuid,timestamptz,timestamptz,text)', 'execute');`),
    ).toBe("f");
  });
});
