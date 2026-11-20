// @vitest-environment node
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * O EMBRULHO de shell do reprocessamento (`hostgator-setup-kit/reprocessar-resposta-da-secretaria.sh`): o que ele
 * recusa ANTES de tocar em banco. O SQL é provado contra o Postgres em
 * tests/invariants/reprocessar-resposta-da-secretaria.test.ts; aqui, só os argumentos.
 */
const SCRIPT = join(process.cwd(), "hostgator-setup-kit/reprocessar-resposta-da-secretaria.sh");
const ORG = "4e940000-0000-4000-8000-000000000001";
const MSG = "4e940000-0000-4000-8000-0000000000b2";

const rodar = (...args: string[]) => {
  // Numa pasta vazia: se a validação deixar passar, o script morre no `enter_project` (sem compose/.env), nunca no banco.
  const r = spawnSync("bash", [SCRIPT, ...args], { cwd: mkdtempSync(join(tmpdir(), "reproc-")), encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } });
  return { status: r.status, saida: `${r.stdout}${r.stderr}` };
};

describe("reprocessar-resposta-da-secretaria.sh — argumentos", () => {
  it("o script é shell válido", () => {
    expect(spawnSync("bash", ["-n", SCRIPT]).status).toBe(0);
  });

  it("sem organização: uso, e para", () => {
    const r = rodar("--mensagem", MSG);
    expect(r.status).toBe(1);
    expect(r.saida).toMatch(/--organizacao precisa ser um uuid/);
    expect(r.saida).toMatch(/Uso: reprocessar-resposta-da-secretaria\.sh/);
  });

  it("sem mensagem, relato nem job: para", () => {
    const r = rodar("--organizacao", ORG);
    expect(r.status).toBe(1);
    expect(r.saida).toMatch(/Informe --job, --mensagem ou --relato/);
  });

  it("id que não é uuid (copiado errado, ou tentativa de injetar SQL): para antes de qualquer conexão", () => {
    const r = rodar("--organizacao", ORG, "--mensagem", "x'; drop table messages; --");
    expect(r.status).toBe(1);
    expect(r.saida).toMatch(/id inválido/);
  });

  it("opção desconhecida: uso", () => {
    expect(rodar("--organizacao", ORG, "--mensagem", MSG, "--forcar").status).toBe(1);
  });

  it("argumentos válidos passam da validação e só então procuram o projeto (aqui não há: para sem tocar em nada)", () => {
    const r = rodar("--organizacao", ORG, "--mensagem", MSG);
    expect(r.status).toBe(1);
    expect(r.saida).toMatch(/Não achei .*compose/i);
  });
});
