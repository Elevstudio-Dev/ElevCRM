/**
 * O cadastro público é decidido por UMA variável, e o erro que importa é o
 * silencioso: quem tenta fechar o cadastro, erra a grafia, e o sistema continua
 * aberto sem avisar. Por isso o que não se entende FECHA.
 */
import { describe, expect, it } from "vitest";

import { cadastroPublicoAberto } from "@/lib/auth/cadastro-publico";

describe("cadastroPublicoAberto", () => {
  it("sem a variável, o cadastro continua aberto — quem já instalou não muda", () => {
    expect(cadastroPublicoAberto(undefined)).toBe(true);
    expect(cadastroPublicoAberto(null)).toBe(true);
    expect(cadastroPublicoAberto("")).toBe(true);
    expect(cadastroPublicoAberto("   ")).toBe(true);
  });

  it("`true` abre, com qualquer caixa e espaço (é o que o .env costuma trazer)", () => {
    for (const v of ["true", "TRUE", "True", " true ", "true\n"]) {
      expect(cadastroPublicoAberto(v), JSON.stringify(v)).toBe(true);
    }
  });

  it("`false` fecha", () => {
    for (const v of ["false", "FALSE", " false "]) {
      expect(cadastroPublicoAberto(v), JSON.stringify(v)).toBe(false);
    }
  });

  it("o que NÃO se entende também fecha — erro de digitação não deixa aberto em silêncio", () => {
    // O defeito que este caso prende: `valor === "false" ? false : true` aceitaria
    // todos estes como "aberto", e quem escreveu `falso` achando que fechou
    // descobriria só quando aparecesse uma empresa que ninguém convidou.
    for (const v of ["falso", "0", "no", "nao", "não", "off", "fechado", "flase", "false;", "1", "yes", "sim"]) {
      expect(cadastroPublicoAberto(v), JSON.stringify(v)).toBe(false);
    }
  });
});
