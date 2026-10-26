import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * O ESTADO DO LEMBRETE FALA A MESMA LÍNGUA NO BANCO E NO TYPESCRIPT.
 *
 * Mesma medição de `agenda-vocabulario.test.ts`, num arquivo NOVO pelo motivo que ele
 * mesmo explica: `tests/invariants/**` é congelado contra modificação, e a lista de
 * pares de lá não pode ganhar uma linha sem a env de escape. Quando houver autorização
 * para mexer na lista canônica, este par migra para lá e este arquivo morre.
 *
 * A guarda contra o instrumento quebrado vem antes da comparação: um teste que compara
 * duas listas vazias passa, então cada lado precisa ter ao menos dois valores.
 */

const container = process.env.TEST_DB_CONTAINER;
if (!container) {
  throw new Error(
    "TEST_DB_CONTAINER not set — rode esta suíte via `pnpm test:db` (scripts/test-db.sh)",
  );
}
const containerName: string = container;

function sql(query: string): string {
  return execFileSync(
    "docker",
    ["exec", "-i", containerName, "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-tA", "-f", "-"],
    { input: query, encoding: "utf8" },
  ).trim();
}

const FONTE = readFileSync(join(process.cwd(), "lib", "agenda", "tipos.ts"), "utf8");

function valoresDoTypeScript(simbolo: string): string[] {
  const m = new RegExp(`export const ${simbolo}\\s*=\\s*\\[([^\\]]*)\\]\\s*as const`, "m").exec(FONTE);
  if (!m || m[1] === undefined) {
    throw new Error(`INSTRUMENTO: não achei 'export const ${simbolo} = [...] as const' em lib/agenda/tipos.ts.`);
  }
  return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1] as string);
}

function valoresDoBanco(tabela: string, coluna: string): string[] {
  const def = sql(`
    select pg_get_constraintdef(c.oid)
      from pg_constraint c
      join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any(c.conkey)
     where c.conrelid = 'public.${tabela}'::regclass
       and c.contype = 'c'
       and a.attname = '${coluna}'
       and (pg_get_constraintdef(c.oid) like '%= ANY (ARRAY[%'
            or pg_get_constraintdef(c.oid) like '%= ''%''::text%')
       and pg_get_constraintdef(c.oid) not like '% AND %'
       and pg_get_constraintdef(c.oid) not like '% OR %'
     order by c.conname;
  `);
  const linhas = def.split("\n").filter((l) => l.trim() !== "");
  if (linhas.length !== 1) {
    throw new Error(
      `INSTRUMENTO: ${tabela}.${coluna} devia ter UM CHECK de conjunto e tem ${linhas.length}. ` +
        `A regra de negócio (calendar_appointments_lembrete_coerente) mora em constraint separada.`,
    );
  }
  return [...(linhas[0] as string).matchAll(/'([^']+)'::text/g)].map((x) => x[1] as string);
}

describe("calendar_appointments.reminder_state espelha ESTADOS_DO_LEMBRETE", () => {
  it("os dois lados têm vocabulário (guarda de vacuidade)", () => {
    expect(valoresDoBanco("calendar_appointments", "reminder_state").length).toBeGreaterThanOrEqual(2);
    expect(valoresDoTypeScript("ESTADOS_DO_LEMBRETE").length).toBeGreaterThanOrEqual(2);
  });

  it("e são o mesmo", () => {
    expect([...valoresDoBanco("calendar_appointments", "reminder_state")].sort()).toEqual(
      [...valoresDoTypeScript("ESTADOS_DO_LEMBRETE")].sort(),
    );
  });
});
