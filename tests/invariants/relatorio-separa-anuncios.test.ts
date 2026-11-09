import { execFileSync } from "node:child_process";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * RELATÓRIO DE ORIGENS (0223): o anúncio é identificado pelo CÓDIGO que o WhatsApp entrega no clique
 * (`source_metadata.ad_raw.sourceId`), não só pelo título.
 *
 * A função devolve `<código>␟<título>` no `detalhe` das origens de anúncio. O que se trava aqui é o contrato com
 * o leitor (`agruparOrigens`): dois anúncios de mesmo título têm detalhes DIFERENTES, e um negócio sem código
 * continua saindo com o título (o comportamento de antes). Como a função é `security invoker`, a prova roda como
 * `authenticated` — como `postgres` (rolbypassrls) a RLS não mediria nada.
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

const ORG = "eeeeeeee-0000-4000-8000-0000000000a1";
const GESTOR = "eeeeeeee-1111-4000-8000-0000000000a1";
const lead = (n: number) => `eeeeeeee-3333-4000-8000-0000000000${n.toString(16).padStart(2, "0")}`;

const leadSql = (id: string, source: string, metadata: Record<string, unknown>) => `
  insert into public.crm_leads (id, organization_id, pipeline_id, stage_id, title, status, owner_user_id, source, source_metadata)
  select '${id}', '${ORG}', s.pipeline_id, s.id, 'Negócio ${id.slice(-2)}', 'open', '${GESTOR}', '${source}',
         '${JSON.stringify(metadata).replace(/'/g, "''")}'::jsonb
    from public.crm_stages s
   where s.organization_id = '${ORG}' and not s.is_won and not s.is_lost
   order by s.position limit 1
  on conflict (id) do nothing;`;

/** `detalhe` de cada linha de anúncio, com o separador visível, ordenado. */
function detalhesDeAnuncio(): string[] {
  const out = sql(`
    set role authenticated;
    select set_config('request.jwt.claims', '{"sub":"${GESTOR}"}', false);
    select replace(detalhe, chr(31), '|') || ' = ' || leads
      from public.fn_relatorio_de_origens('${ORG}', now() - interval '1 day', now() + interval '1 day')
     where source = 'meta_ads'
     order by 1;
  `);
  return out === "" ? [] : out.split("\n").filter((l) => l.includes(" = "));
}

beforeAll(() => {
  sql(`
    insert into auth.users (id, email) values ('${GESTOR}', 'anuncios-mgr@invariant.test') on conflict (id) do nothing;
    insert into public.organizations (id, slug, legal_name, display_name) values
      ('${ORG}', 'anuncios-inv', 'Anuncios Invariant', 'Anuncios')
      on conflict (id) do nothing;
    insert into public.user_organizations (user_id, organization_id, role, accepted_at) values
      ('${GESTOR}', '${ORG}', 'manager', now())
      on conflict do nothing;
  `);
  // Dois anúncios DIFERENTES com o MESMO título; um terceiro negócio do primeiro anúncio com o título trocado;
  // um sem código (formato antigo) e um sem nada.
  sql(leadSql(lead(1), "meta_ads", { ad_title: "Clareamento", ad_raw: { sourceId: "111" } }));
  sql(leadSql(lead(2), "meta_ads", { ad_title: "Clareamento", ad_raw: { sourceId: "222" } }));
  sql(leadSql(lead(3), "meta_ads", { ad_title: "Clareamento v2", ad_raw: { sourceId: "111" } }));
  sql(leadSql(lead(4), "meta_ads", { ad_title: "Implante" }));
  sql(leadSql(lead(5), "meta_ads", {}));
});

describe("fn_relatorio_de_origens — anúncio pelo código (0223)", () => {
  it("devolve código e título; mesmo título com códigos diferentes NÃO se funde no banco", () => {
    const d = detalhesDeAnuncio();
    expect(d).toContain("111|Clareamento = 1");
    expect(d).toContain("222|Clareamento = 1");
  });

  it("o mesmo código com o título trocado sai em linhas separadas (quem junta é o leitor, pelo código)", () => {
    expect(detalhesDeAnuncio()).toContain("111|Clareamento v2 = 1");
  });

  it("sem código a linha sai com o título depois do separador (o leitor agrupa pelo título, como antes)", () => {
    const d = detalhesDeAnuncio();
    expect(d).toContain("|Implante = 1");
    expect(d).toContain("| = 1");
  });

  it("segue `security invoker`: quem não é da organização não vê linha nenhuma", () => {
    const out = sql(`
      insert into auth.users (id, email) values ('eeeeeeee-1111-4000-8000-0000000000a2', 'anuncios-fora@invariant.test') on conflict (id) do nothing;
      set role authenticated;
      select set_config('request.jwt.claims', '{"sub":"eeeeeeee-1111-4000-8000-0000000000a2"}', false);
      select count(*) from public.fn_relatorio_de_origens('${ORG}', now() - interval '1 day', now() + interval '1 day');
    `);
    expect(out.split("\n").pop()).toBe("0");
  });
});
