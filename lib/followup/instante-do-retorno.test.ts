import { describe, expect, it } from "vitest";

import { diaDaquiA, diaLocal, instanteDoRetorno } from "./instante-do-retorno";

describe("instanteDoRetorno — o dia e a hora do formulário viram um instante", () => {
  it("combina dia e hora no fuso LOCAL de quem escolheu", () => {
    const d = instanteDoRetorno("2026-11-20", "09:30");
    expect(d).not.toBeNull();
    expect([d!.getFullYear(), d!.getMonth() + 1, d!.getDate(), d!.getHours(), d!.getMinutes()]).toEqual([
      2026, 11, 20, 9, 30,
    ]);
  });

  it("recusa dia que não existe em vez de empurrá-lo para o mês seguinte", () => {
    expect(instanteDoRetorno("2026-02-31", "09:00")).toBeNull();
    expect(instanteDoRetorno("2026-13-01", "09:00")).toBeNull();
  });

  it("recusa campo vazio ou fora do formato", () => {
    expect(instanteDoRetorno("", "09:00")).toBeNull();
    expect(instanteDoRetorno("2026-11-20", "")).toBeNull();
    expect(instanteDoRetorno("20/11/2026", "09:00")).toBeNull();
    expect(instanteDoRetorno("2026-11-20", "25:00")).toBeNull();
    expect(instanteDoRetorno("2026-11-20", "9:30")).toBeNull();
  });
});

describe("diaDaquiA", () => {
  it("conta dias no calendário local, atravessando fim de mês e de ano", () => {
    const agora = new Date(2026, 11, 30, 18, 0); // 30/12/2026 18h
    expect(diaDaquiA(agora, 1)).toBe("2026-12-31");
    expect(diaDaquiA(agora, 3)).toBe("2027-01-02");
    expect(diaDaquiA(agora, 0)).toBe(diaLocal(agora));
  });
});
