/**
 * As listas de specs do CI — UMA leitura, para quem quer que precise delas.
 *
 * `.github/workflows/e2e.yml` declara `SPECS_PARTE_1`, `SPECS_PARTE_2` e
 * `FORA_DO_CI` como blocos `CHAVE: >-`. Dois consumidores leem isso: o gate
 * `tests/unit/e2e-cobertura-completa.test.ts` (que reprova quando uma spec do
 * disco não está em lista nenhuma) e `scripts/elev-testar-tudo.sh` (que roda
 * local exatamente o que o CI roda). Até 2026-09-14 eram dois parsers — um em
 * TypeScript, outro em awk — que precisavam concordar sobre a forma do bloco;
 * o gate reprovaria uma reescrita, mas o script poderia ler uma lista parcial
 * e reportar "as mesmas do CI" rodando um terço das specs. Agora é este
 * arquivo, e só ele.
 *
 * Parser deliberadamente estreito: casa só a forma que o arquivo usa. Um parser
 * de YAML de verdade aceitaria formas que ninguém escreveu e esconderia uma
 * reescrita do bloco — aqui, se a forma mudar, o controle positivo do gate
 * estoura em vez de devolver lista vazia.
 *
 * Como CLI (é o que o script de shell chama):
 *
 *   pnpm exec tsx scripts/listas-do-ci.ts SPECS_PARTE_1   # um caminho por linha
 */
import { readFileSync } from "node:fs";
import path from "node:path";

export const WORKFLOW_E2E = path.join(process.cwd(), ".github", "workflows", "e2e.yml");

/** Lê uma variável de bloco YAML (`CHAVE: >-`) e devolve os nomes de spec. */
export function listaDoWorkflow(yml: string, chave: string): string[] {
  const re = new RegExp(`^\\s*${chave}:\\s*>-\\s*\\n((?:\\s{8,}\\S.*\\n)+)`, "m");
  const m = re.exec(yml);
  if (m === null) return [];
  return m[1]!
    .split(/\s+/)
    .map((s) => s.trim())
    .filter((s) => s.endsWith(".spec.ts"));
}

/** As três listas, lidas do workflow do disco. */
export function listasDoCi(): { parte1: string[]; parte2: string[]; foraDoCi: string[] } {
  const yml = readFileSync(WORKFLOW_E2E, "utf8");
  return {
    parte1: listaDoWorkflow(yml, "SPECS_PARTE_1"),
    parte2: listaDoWorkflow(yml, "SPECS_PARTE_2"),
    foraDoCi: listaDoWorkflow(yml, "FORA_DO_CI"),
  };
}

const CHAVES = ["SPECS_PARTE_1", "SPECS_PARTE_2", "FORA_DO_CI"] as const;

// Só vira CLI quando é o arquivo executado — importado pelo gate, não faz nada.
if (process.argv[1]?.endsWith("listas-do-ci.ts")) {
  const chave = process.argv[2];
  if (!chave || !(CHAVES as readonly string[]).includes(chave)) {
    process.stderr.write(`uso: tsx scripts/listas-do-ci.ts <${CHAVES.join("|")}>\n`);
    process.exit(2);
  }
  const lista = listaDoWorkflow(readFileSync(WORKFLOW_E2E, "utf8"), chave);
  if (lista.length === 0) {
    process.stderr.write(`nenhuma spec lida em ${chave} — a forma do bloco em e2e.yml mudou?\n`);
    process.exit(1);
  }
  process.stdout.write(lista.map((s) => `tests/e2e/${s}`).join("\n") + "\n");
}
