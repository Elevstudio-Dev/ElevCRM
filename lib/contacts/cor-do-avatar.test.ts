import { describe, expect, it } from "vitest";

import { estiloDoAvatar, TRILHAS_DE_PESSOA, trilhaDoAvatar } from "./cor-do-avatar";

describe("trilhaDoAvatar", () => {
  it("é determinística: o mesmo contato tem sempre a mesma cor", () => {
    const id = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
    expect(trilhaDoAvatar(id)).toBe(trilhaDoAvatar(id));
    expect(trilhaDoAvatar(`  ${id}  `)).toBe(trilhaDoAvatar(id));
  });

  it("fica sempre entre 1 e o número de trilhas do CSS", () => {
    for (let i = 0; i < 500; i += 1) {
      const t = trilhaDoAvatar(`contato-${i}`);
      expect(t).not.toBeNull();
      expect(t).toBeGreaterThanOrEqual(1);
      expect(t).toBeLessThanOrEqual(TRILHAS_DE_PESSOA);
    }
  });

  it("usa as oito trilhas, sem nenhuma dominar (espalha uuids de verdade)", () => {
    // Guarda de vacuidade do hash: um que devolvesse sempre 1 passaria nos testes acima.
    const contagem = new Array<number>(TRILHAS_DE_PESSOA).fill(0);
    const N = 4000;
    for (let i = 0; i < N; i += 1) {
      const uuid = `${(i * 2654435761 >>> 0).toString(16).padStart(8, "0")}-0000-4000-8000-${i.toString(16).padStart(12, "0")}`;
      const idx = (trilhaDoAvatar(uuid) ?? 1) - 1;
      contagem[idx] = (contagem[idx] ?? 0) + 1;
    }
    const esperado = N / TRILHAS_DE_PESSOA;
    for (const c of contagem) {
      expect(c).toBeGreaterThan(esperado * 0.8);
      expect(c).toBeLessThan(esperado * 1.2);
    }
  });

  it("sem identificador não inventa cor: devolve null (cinza neutro)", () => {
    expect(trilhaDoAvatar(null)).toBeNull();
    expect(trilhaDoAvatar(undefined)).toBeNull();
    expect(trilhaDoAvatar("")).toBeNull();
    expect(trilhaDoAvatar("   ")).toBeNull();
  });

  it("contatos diferentes costumam ter cores diferentes (não é tudo uma cor só)", () => {
    const cores = new Set(["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"].map((s) => trilhaDoAvatar(s)));
    expect(cores.size).toBeGreaterThan(4);
  });
});

describe("estiloDoAvatar", () => {
  it("sem trilha, sem estilo — o Avatar fica no cinza do design system", () => {
    expect(estiloDoAvatar(null)).toBeUndefined();
  });

  it("mistura a trilha com os tokens do tema (nada de hex: segue claro/escuro sozinho)", () => {
    const e = estiloDoAvatar(3);
    expect(e?.backgroundColor).toContain("var(--agenda-pessoa-3)");
    expect(e?.backgroundColor).toContain("var(--color-surface)");
    expect(e?.color).toContain("var(--agenda-pessoa-3)");
    expect(e?.color).toContain("var(--color-text)");
    expect(JSON.stringify(e)).not.toMatch(/#[0-9a-f]{3,6}/i);
  });
});
