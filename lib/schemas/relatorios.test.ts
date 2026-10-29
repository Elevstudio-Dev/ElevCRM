import { describe, expect, it } from "vitest";

import { periodoSchema } from "./relatorios";

describe("periodoSchema", () => {
  it("converte as datas para instantes na meia-noite do fuso, e `ate` é EXCLUSIVO (o dia final inteiro entra)", () => {
    const r = periodoSchema.parse({ de: "2026-10-01", ate: "2026-10-03", fuso: "America/Sao_Paulo" });
    expect(r.de.toISOString()).toBe("2026-10-01T03:00:00.000Z");
    expect(r.ate.toISOString()).toBe("2026-10-04T03:00:00.000Z");
    expect(r.fuso).toBe("America/Sao_Paulo");
  });

  it("um dia só é um período válido", () => {
    const r = periodoSchema.parse({ de: "2026-10-01", ate: "2026-10-01" });
    expect(r.ate.getTime() - r.de.getTime()).toBe(24 * 3600 * 1000);
  });

  it("fuso omitido vira São Paulo", () => {
    expect(periodoSchema.parse({ de: "2026-10-01", ate: "2026-10-02" }).fuso).toBe("America/Sao_Paulo");
  });

  it("período invertido é erro", () => {
    expect(periodoSchema.safeParse({ de: "2026-10-05", ate: "2026-10-01" }).success).toBe(false);
  });

  it("366 dias passa; 367 não", () => {
    expect(periodoSchema.safeParse({ de: "2026-01-01", ate: "2027-01-01" }).success).toBe(true);
    expect(periodoSchema.safeParse({ de: "2026-01-01", ate: "2027-01-02" }).success).toBe(false);
  });

  it("fuso inválido é erro", () => {
    expect(periodoSchema.safeParse({ de: "2026-10-01", ate: "2026-10-02", fuso: "Marte/Olimpo" }).success).toBe(false);
    expect(periodoSchema.safeParse({ de: "2026-10-01", ate: "2026-10-02", fuso: "'; drop table" }).success).toBe(false);
  });

  it("data que não existe é erro", () => {
    expect(periodoSchema.safeParse({ de: "2026-02-31", ate: "2026-03-02" }).success).toBe(false);
    expect(periodoSchema.safeParse({ de: "ontem", ate: "hoje" }).success).toBe(false);
  });
});
