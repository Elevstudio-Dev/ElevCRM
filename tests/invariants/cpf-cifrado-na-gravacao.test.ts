import { describe, expect, it } from "vitest";

import { sql } from "./gov-helpers";

/**
 * O CPF DO CONTATO É GRAVADO CIFRADO — E A CIFRA EXISTE (migration 0234).
 *
 * ## O defeito que este arquivo prende
 *
 * Em 25/11/2026 a importação por planilha recusou as 408 linhas com CPF válido de uma clínica, todas com
 * `new row for relation "contacts" violates check constraint "contacts_cpf_consistency"`. A constraint exige
 * `cpf_hash` e `cpf_encrypted` JUNTOS (os dois nulos ou os dois preenchidos). A rota gravava o hash e pedia a
 * versão cifrada à RPC `encrypt_cpf` — que nunca tinha sido criada: existia só na spec. O helper engolia o
 * "função não encontrada", devolvia null, e o insert ia só com o hash. O create e o PATCH unitários tinham o
 * mesmo caminho.
 *
 * ## O que é provado aqui, contra o Postgres de verdade
 *
 *  1. a constraint recusa hash sem cifra (é o erro de produção; documenta por que o app não pode "ir sem");
 *  2. `encrypt_cpf` existe, é executável pela sessão do usuário (`authenticated`) e NÃO pela anon key;
 *  3. o caminho do app inteiro: cifra com a sessão do atendente, grava hash + cifra SOB RLS e a cifra volta ao
 *     CPF original com a chave mestra — passando o bytea pela forma de texto `\x…`, que é como o PostgREST o
 *     entrega ao app e como o app o devolve no insert;
 *  4. sem chave, a função recusa com motivo legível e o CPF não aparece na mensagem de erro;
 *  5. entrada que não é CPF normalizado (11 dígitos) é recusada — a função não é um oráculo de cifra genérico
 *     da chave mestra.
 *
 * CPF sintético de exemplo público (111.444.777-35) — nenhum dado de paciente.
 */

const ORG = "cccccccc-0000-4000-8000-0000000000c1";
const AGENTE = "cccccccc-1111-4000-8000-0000000000c1";
const CPF = "11144477735";
const HASH = "e7a6bdbc6b0cab7a7eb8f6dd6bdfff4e5da1fd8ad1ab4efcd4dc68e4f1e4a3d1"; // qualquer hex: o banco só exige par
const CHAVE = "chave-de-teste-0123456789abcdef0123456789abcdef";

/** Última linha de saída do psql (set_config/set role também imprimem). */
const ultima = (saida: string): string => saida.split("\n").at(-1) ?? "";

const comChave = `select set_config('app.nuvemshop_oauth_key', '${CHAVE}', false);`;
const semChave = `
  delete from private.app_secrets where name = 'nuvemshop_oauth_key';
  select set_config('app.nuvemshop_oauth_key', '', false);
`;
const comoAgente = `
  set role authenticated;
  select set_config('request.jwt.claims', '{"sub":"${AGENTE}","role":"authenticated"}', false);
`;

function semear(): void {
  sql(`
    insert into auth.users (id, email) values ('${AGENTE}', 'cpf-agente@invariant.test') on conflict do nothing;
    insert into public.organizations (id, slug, legal_name, display_name)
      values ('${ORG}', 'cpf-cifra-inv', 'CPF Cifra Invariant', 'CPF Cifra') on conflict do nothing;
    insert into public.user_organizations (user_id, organization_id, role, accepted_at)
      values ('${AGENTE}', '${ORG}', 'agent', now()) on conflict do nothing;
    delete from public.contacts where organization_id = '${ORG}';
  `);
}

describe("0234: CPF do contato — hash e cifra andam juntos", () => {
  it("1. a constraint recusa hash sem cifra (o erro de produção de 25/11)", () => {
    semear();
    expect(() =>
      sql(`
        insert into public.contacts (organization_id, display_name, cpf_hash)
          values ('${ORG}', 'Sem Cifra', '${HASH}');
      `),
    ).toThrow(/contacts_cpf_consistency/);
  });

  it("2. encrypt_cpf existe, authenticated executa e anon não", () => {
    const existe = sql(`select count(*) from pg_proc where oid = to_regprocedure('public.encrypt_cpf(text)');`);
    expect(existe, "a função encrypt_cpf(text) não existe — é o defeito de 25/11 de volta").toBe("1");
    const priv = (papel: string) =>
      sql(`select has_function_privilege('${papel}', 'public.encrypt_cpf(text)', 'EXECUTE');`);
    expect(priv("authenticated")).toBe("t");
    expect(priv("service_role")).toBe("t");
    expect(priv("anon"), "a anon key (que vai ao navegador) alcança a cifra com a chave mestra").toBe("f");
  });

  it("3. caminho do app: o atendente cifra, grava hash + cifra sob RLS, e a cifra volta ao CPF", () => {
    semear();
    // A cifra como o PostgREST a entrega ao app: texto `\x<hex>` (bytea_output = hex).
    const cifraComoTexto = ultima(sql(`${comChave}${comoAgente} select public.encrypt_cpf('${CPF}')::text;`));
    expect(cifraComoTexto).toMatch(/^\\x[0-9a-f]+$/);
    expect(cifraComoTexto).not.toContain(Buffer.from(CPF).toString("hex"));

    // E o app a devolve no insert como esse mesmo texto — o Postgres converte para bytea.
    // `returning` imprime o id e depois "INSERT 0 1": pega a linha que é um uuid.
    const id =
      sql(`${comoAgente}
        insert into public.contacts (organization_id, display_name, cpf_hash, cpf_encrypted)
          values ('${ORG}', 'Com Cifra', '${HASH}', '${cifraComoTexto}')
          returning id;
      `)
        .split("\n")
        .find((l) => /^[0-9a-f-]{36}$/.test(l)) ?? "";
    expect(id, "o insert do atendente com hash + cifra não devolveu o contato").toMatch(/^[0-9a-f-]{36}$/);

    const decifrado = ultima(
      sql(`${comChave} select public.fn_decrypt_oauth(cpf_encrypted) from public.contacts where id = '${id}';`),
    );
    expect(decifrado, "a cifra gravada não volta ao CPF original").toBe(CPF);
  });

  it("3b. duas cifras do mesmo CPF diferem (cifra com sal: a coluna não vira índice de busca)", () => {
    const a = ultima(sql(`${comChave} select public.encrypt_cpf('${CPF}')::text;`));
    const b = ultima(sql(`${comChave} select public.encrypt_cpf('${CPF}')::text;`));
    expect(a).not.toBe(b);
  });

  it("4. sem chave: recusa com motivo legível e sem o CPF na mensagem", () => {
    let mensagem = "";
    try {
      sql(`${semChave}${comoAgente} select public.encrypt_cpf('${CPF}');`);
    } catch (e) {
      mensagem = String((e as { stderr?: string }).stderr ?? e);
    }
    expect(mensagem).toMatch(/chave de cifra ausente/);
    expect(mensagem).not.toContain(CPF);
  });

  it("5. só aceita CPF normalizado (11 dígitos) — não é oráculo genérico da chave mestra", () => {
    for (const entrada of ["111.444.777-35", "1114447773", "segredo-qualquer", ""]) {
      let mensagem = "";
      try {
        sql(`${comChave}${comoAgente} select public.encrypt_cpf('${entrada}');`);
      } catch (e) {
        mensagem = String((e as { stderr?: string }).stderr ?? e);
      }
      expect(mensagem, `entrada "${entrada}" foi cifrada`).toMatch(/11 dígitos/);
    }
  });
});
