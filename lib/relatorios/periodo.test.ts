import { describe, expect, it } from "vitest";

import { diaNoFuso, meiaNoiteNoFuso, periodoPreDefinido } from "./periodo";

describe("meiaNoiteNoFuso", () => {
  it("meia-noite de São Paulo é 03:00Z", () => {
    expect(meiaNoiteNoFuso("2026-10-01", "America/Sao_Paulo").toISOString()).toBe("2026-10-01T03:00:00.000Z");
  });
  it("UTC é UTC", () => {
    expect(meiaNoiteNoFuso("2026-10-01", "UTC").toISOString()).toBe("2026-10-01T00:00:00.000Z");
  });
  it("fuso a leste (Tóquio, UTC+9) volta para o dia anterior em UTC", () => {
    expect(meiaNoiteNoFuso("2026-10-01", "Asia/Tokyo").toISOString()).toBe("2026-09-30T15:00:00.000Z");
  });
  it("com horário de verão (Nova York, outubro = UTC-4; dezembro = UTC-5)", () => {
    expect(meiaNoiteNoFuso("2026-10-01", "America/New_York").toISOString()).toBe("2026-10-01T04:00:00.000Z");
    expect(meiaNoiteNoFuso("2026-12-01", "America/New_York").toISOString()).toBe("2026-12-01T05:00:00.000Z");
  });
});

describe("diaNoFuso", () => {
  it("23:30 em São Paulo ainda é o dia de São Paulo, mesmo já sendo o dia seguinte em UTC", () => {
    expect(diaNoFuso(new Date("2026-10-02T02:30:00Z"), "America/Sao_Paulo")).toBe("2026-10-01");
  });
});

describe("periodoPreDefinido", () => {
  const AGORA = new Date("2026-10-28T15:00:00Z"); // 12:00 em São Paulo

  it("7 dias = hoje e os 6 anteriores", () => {
    expect(periodoPreDefinido(7, AGORA, "America/Sao_Paulo")).toEqual({ de: "2026-10-22", ate: "2026-10-28" });
  });
  it("30 dias", () => {
    expect(periodoPreDefinido(30, AGORA, "America/Sao_Paulo")).toEqual({ de: "2026-09-29", ate: "2026-10-28" });
  });
  it("90 dias atravessa o virar do mês e do ano sem erro de calendário", () => {
    expect(periodoPreDefinido(90, new Date("2027-01-10T15:00:00Z"), "America/Sao_Paulo")).toEqual({
      de: "2026-10-13",
      ate: "2027-01-10",
    });
  });
  it("'hoje' é o do fuso: 01:00Z do dia 29 ainda é dia 28 em São Paulo", () => {
    expect(periodoPreDefinido(7, new Date("2026-10-29T01:00:00Z"), "America/Sao_Paulo").ate).toBe("2026-10-28");
  });
});
