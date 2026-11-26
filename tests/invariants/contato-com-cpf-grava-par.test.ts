import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import pg from "pg";

import { createContactHandler, patchContactHandler } from "@/app/api/v1/contacts/_handler";
import { ApiError } from "@/lib/api/types";
import type { HandlerCtx } from "@/lib/api/handlers/types";
import { MOTIVO_CPF_SEM_CIFRA } from "@/lib/contacts/cpf";
import type { ContactCreate } from "@/lib/schemas";

import { pgComoSupabase } from "../pg-como-supabase";

/**
 * CONTATO COM CPF GRAVA O PAR (HASH + CIFRA) — OU RECUSA COM MOTIVO LEGÍVEL.
 *
 * O defeito de 25/11/2026: a importação por planilha perdeu as 408 linhas com CPF de uma clínica, todas com o erro
 * cru `violates check constraint "contacts_cpf_consistency"`. O helper de cifra engolia o erro da RPC (que nem
 * existia) e o código gravava o hash sozinho. O create e o PATCH unitários usavam o mesmo helper.
 * `cpf-cifrado-na-gravacao.test.ts` prova o BANCO; este arquivo roda o CÓDIGO das três portas de entrada contra o
 * Postgres de verdade (`pgComoSupabase` troca só o transporte — e entrega `bytea` como o PostgREST, `\x<hex>`):
 *
 *   - importação por planilha (`POST /api/v1/contacts/import`), a rota do incidente;
 *   - create unitário (`createContactHandler`);
 *   - PATCH unitário (`patchContactHandler`), que além do erro cru podia deixar hash de um CPF e cifra de OUTRO.
 *
 * Decisão documentada: SEM cifra a linha/requisição FALHA com motivo legível — não entra sem CPF. Entrar sem CPF
 * faria o reimport da mesma planilha contar o contato como duplicado (pelo telefone) e o CPF nunca mais entraria.
 *
 * CPFs sintéticos (dígitos verificadores calculados aqui), telefones e e-mails de teste — nenhum dado de paciente.
 */

// ─── A rota de importação lê sessão e papel do request; aqui vêm do teste ────
const estado = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => estado.db }));
vi.mock("@/lib/auth/require-role", () => ({
  requireRole: async () => ({
    ok: true,
    user: { id: "c9f00000-1111-4000-8000-0000000000a1" },
    org: { orgId: "c9f00000-0000-4000-8000-0000000000a1", role: "agent" },
  }),
}));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));

const container = process.env.TEST_DB_CONTAINER;
if (!container) throw new Error("TEST_DB_CONTAINER not set — rode via `pnpm test:db` (scripts/test-db.sh)");

const PORT = Number(process.env.TEST_DB_PORT ?? 54329);
const pool = new pg.Pool({ connectionString: `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`, max: 3 });
const db = pgComoSupabase(pool);
estado.db = db;

const ORG = "c9f00000-0000-4000-8000-0000000000a1";
const USUARIO = "c9f00000-1111-4000-8000-0000000000a1";
const CHAVE = "chave-de-teste-0123456789abcdef0123456789abcdef";

/** CPF válido a partir de 9 dígitos-base: calcula os dois verificadores. */
function cpfSintetico(base9: string): string {
  const dv = (digitos: string): number => {
    const peso = digitos.length + 1;
    const soma = [...digitos].reduce((s, d, i) => s + Number(d) * (peso - i), 0);
    const r = (soma * 10) % 11;
    return r === 10 ? 0 : r;
  };
  const d1 = dv(base9);
  return `${base9}${d1}${dv(`${base9}${d1}`)}`;
}

const ctx = (): HandlerCtx => ({
  organization_id: ORG,
  actor: { type: "user", id: USUARIO },
  requestId: "req-cpf-par",
});

const ligarChave = () =>
  pool.query(
    `insert into private.app_secrets (name, value) values ('nuvemshop_oauth_key', $1)
       on conflict (name) do update set value = excluded.value`,
    [CHAVE],
  );
const desligarChave = () => pool.query(`delete from private.app_secrets where name = 'nuvemshop_oauth_key'`);

interface ParDoCpf {
  cpf_hash: string | null;
  tem_cifra: boolean;
  decifrado: string | null;
}

async function parDoCpf(where: string, valor: string): Promise<ParDoCpf | null> {
  await ligarChave(); // para decifrar na conferência
  const { rows } = await pool.query<ParDoCpf>(
    `select cpf_hash, cpf_encrypted is not null as tem_cifra,
            case when cpf_encrypted is null then null else public.fn_decrypt_oauth(cpf_encrypted) end as decifrado
       from public.contacts where organization_id = $1 and ${where} = $2`,
    [ORG, valor],
  );
  return rows[0] ?? null;
}

beforeAll(async () => {
  await pool.query(
    `insert into auth.users (id, email) values ($1, 'cpf-par@invariant.test') on conflict do nothing`,
    [USUARIO],
  );
  await pool.query(
    `insert into public.organizations (id, slug, legal_name, display_name)
       values ($1, 'cpf-par-inv', 'CPF Par Invariant', 'CPF Par') on conflict (id) do nothing`,
    [ORG],
  );
  await pool.query(
    `insert into public.user_organizations (user_id, organization_id, role, accepted_at)
       values ($1, $2, 'agent', now()) on conflict do nothing`,
    [USUARIO, ORG],
  );
});

beforeEach(async () => {
  await pool.query(`delete from public.contacts where organization_id = $1`, [ORG]);
});

afterAll(async () => {
  await pool.end();
});

// ─── Importação por planilha: a rota do incidente ───────────────────────────
async function importar(csv: string): Promise<{
  imported: number;
  skipped_duplicates: number;
  errors: Array<{ linha: number; motivo: string }>;
}> {
  const { POST } = await import("@/app/api/v1/contacts/import/route");
  const form = new FormData();
  form.append("file", new File([csv], "contatos.csv", { type: "text/csv" }));
  const req = new Request("http://teste.local/api/v1/contacts/import", { method: "POST", body: form });
  const res = await POST(req as never);
  expect(res.status).toBe(200);
  const corpo = (await res.json()) as { data: Awaited<ReturnType<typeof importar>> };
  return corpo.data;
}

describe("importação por planilha (POST /api/v1/contacts/import)", () => {
  const CPF_A = cpfSintetico("100200300");
  const CPF_B = cpfSintetico("100200301");
  const planilha = [
    "nome;telefone;email;cpf",
    `Paciente Teste A;+5511900000101;;${CPF_A}`,
    `Paciente Teste B;+5511900000102;;${CPF_B.slice(0, 3)}.${CPF_B.slice(3, 6)}.${CPF_B.slice(6, 9)}-${CPF_B.slice(9)}`,
    "Paciente Teste C;+5511900000103;;",
  ].join("\n");

  it("com a cifra no ar: as linhas com CPF entram com hash E cifra, e a cifra volta ao CPF", async () => {
    await ligarChave();
    const r = await importar(planilha);

    expect(r.errors, JSON.stringify(r.errors)).toEqual([]);
    expect(r.imported).toBe(3);

    const a = await parDoCpf("phone_number", "+5511900000101");
    expect(a?.cpf_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(a?.tem_cifra).toBe(true);
    expect(a?.decifrado).toBe(CPF_A);
    // Formatado na planilha (000.000.000-00): cifrado normalizado.
    expect((await parDoCpf("phone_number", "+5511900000102"))?.decifrado).toBe(CPF_B);
    // Sem CPF: nem hash nem cifra.
    const c = await parDoCpf("phone_number", "+5511900000103");
    expect(c?.cpf_hash).toBeNull();
    expect(c?.tem_cifra).toBe(false);
  });

  it("sem a cifra: a linha com CPF falha com motivo LEGÍVEL (não o erro do banco), a sem CPF entra", async () => {
    await desligarChave();
    const r = await importar(planilha);

    expect(r.imported).toBe(1);
    expect(r.errors.map((e) => e.linha).sort()).toEqual([2, 3]);
    for (const e of r.errors) {
      expect(e.motivo).toBe(MOTIVO_CPF_SEM_CIFRA);
      expect(e.motivo).not.toMatch(/constraint|violates|encrypt_cpf/);
      expect(e.motivo).not.toContain(CPF_A);
    }
    // Nada gravado pela metade: as linhas com CPF não existem (o reimport as traz inteiras).
    expect(await parDoCpf("phone_number", "+5511900000101")).toBeNull();
    expect(await parDoCpf("phone_number", "+5511900000102")).toBeNull();
  });

  it("reimportar a mesma planilha depois que a cifra volta traz exatamente as linhas que faltaram", async () => {
    await desligarChave();
    await importar(planilha);
    await ligarChave();
    const r = await importar(planilha);

    expect(r.errors).toEqual([]);
    expect(r.imported).toBe(2);
    expect(r.skipped_duplicates).toBe(1);
    expect((await parDoCpf("phone_number", "+5511900000101"))?.decifrado).toBe(CPF_A);
  });
});

// ─── Create e PATCH unitários ───────────────────────────────────────────────
describe("create unitário de contato com CPF", () => {
  const CPF = cpfSintetico("200300400");

  it("com a cifra no ar: grava hash e cifra", async () => {
    await ligarChave();
    await createContactHandler(db, ctx(), {
      name: "Contato Unitario",
      email: "unitario-cpf@invariant.test",
      cpf: CPF,
      source: "manual",
    } as ContactCreate);

    const par = await parDoCpf("email", "unitario-cpf@invariant.test");
    expect(par?.cpf_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(par?.decifrado).toBe(CPF);
  });

  it("sem a cifra: 503 com motivo legível, e nenhum contato criado", async () => {
    await desligarChave();
    const erro = await createContactHandler(db, ctx(), {
      name: "Contato Unitario",
      email: "unitario-cpf@invariant.test",
      cpf: CPF,
      source: "manual",
    } as ContactCreate).catch((e: unknown) => e);

    expect(erro).toBeInstanceOf(ApiError);
    expect((erro as ApiError).status).toBe(503);
    expect((erro as ApiError).message).toBe(MOTIVO_CPF_SEM_CIFRA);
    expect(await parDoCpf("email", "unitario-cpf@invariant.test")).toBeNull();
  });
});

describe("PATCH unitário do CPF", () => {
  const ANTIGO = cpfSintetico("300400500");
  const NOVO = cpfSintetico("300400501");

  async function contatoComCpfAntigo(): Promise<string> {
    await ligarChave();
    await createContactHandler(db, ctx(), {
      name: "Contato Patch",
      email: "patch-cpf@invariant.test",
      cpf: ANTIGO,
      source: "manual",
    } as ContactCreate);
    const { rows } = await pool.query<{ id: string }>(
      `select id from public.contacts where organization_id = $1 and email = 'patch-cpf@invariant.test'`,
      [ORG],
    );
    return rows[0]!.id;
  }

  it("troca o PAR: a cifra passa a ser a do CPF novo (não fica hash de um e cifra de outro)", async () => {
    const id = await contatoComCpfAntigo();
    const hashAntigo = (await parDoCpf("email", "patch-cpf@invariant.test"))?.cpf_hash;

    await patchContactHandler(db, ctx(), id, { cpf: NOVO });

    const par = await parDoCpf("email", "patch-cpf@invariant.test");
    expect(par?.cpf_hash).not.toBe(hashAntigo);
    expect(par?.decifrado).toBe(NOVO);
  });

  it("sem a cifra: 503 legível e o CPF antigo fica intacto (hash E cifra)", async () => {
    const id = await contatoComCpfAntigo();
    const antes = await parDoCpf("email", "patch-cpf@invariant.test");
    await desligarChave();

    const erro = await patchContactHandler(db, ctx(), id, { cpf: NOVO }).catch((e: unknown) => e);
    expect(erro).toBeInstanceOf(ApiError);
    expect((erro as ApiError).status).toBe(503);
    expect((erro as ApiError).message).toBe(MOTIVO_CPF_SEM_CIFRA);

    const depois = await parDoCpf("email", "patch-cpf@invariant.test");
    expect(depois?.cpf_hash).toBe(antes?.cpf_hash);
    expect(depois?.decifrado).toBe(ANTIGO);
  });
});
