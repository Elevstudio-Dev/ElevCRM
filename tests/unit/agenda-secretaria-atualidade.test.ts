import { describe, expect, it } from "vitest";

import { decidirAtualidade, situacaoDaAgendaDaSecretaria } from "@/lib/agenda/secretaria/atualidade";
import {
  CONFIG_PADRAO_DA_SECRETARIA,
  lerConfigDaSecretaria,
  type ConfigDaSecretaria,
} from "@/lib/agenda/secretaria/config";

/**
 * A AGENDA DA SECRETARIA ESTÁ FRESCA? — a IA só oferece o que foi conferido há pouco.
 *
 * Relógio injetado em tudo: nenhum destes testes depende da hora da máquina.
 */
const AGORA = new Date("2026-11-18T18:00:00Z");
const horasAtras = (h: number) => new Date(AGORA.getTime() - h * 3_600_000);
const cfg = (over: Partial<ConfigDaSecretaria> = {}): ConfigDaSecretaria => ({
  ...CONFIG_PADRAO_DA_SECRETARIA,
  ativa: true,
  ...over,
});

describe("lerConfigDaSecretaria — nunca lança e o padrão é DESLIGADO", () => {
  it("organização que nunca configurou: desligada, com os padrões da clínica-piloto", () => {
    for (const settings of [undefined, null, {}, { secretaria: null }, "lixo", 7]) {
      const c = lerConfigDaSecretaria(settings);
      expect(c.ativa).toBe(false);
      expect(c.duracao_min).toBe(30);
      expect(c.perguntas).toEqual(["08:30", "14:00", "18:15"]);
      expect(c.dias).toEqual([1, 2, 3, 4, 5]);
      expect(c.validade_hoje_horas).toBe(6);
      expect(c.validade_futuro_horas).toBe(24);
    }
  });

  it("lê o que foi configurado e completa o resto com o padrão", () => {
    const c = lerConfigDaSecretaria({ secretaria: { ativa: true, duracao_min: 45, perguntas: ["09:00"] } });
    expect(c.ativa).toBe(true);
    expect(c.duracao_min).toBe(45);
    expect(c.perguntas).toEqual(["09:00"]);
    expect(c.dias).toEqual([1, 2, 3, 4, 5]);
  });

  it("valor inválido NÃO derruba nem liga: volta ao padrão inteiro (desligado)", () => {
    expect(lerConfigDaSecretaria({ secretaria: { ativa: true, duracao_min: -5 } }).ativa).toBe(false);
    expect(lerConfigDaSecretaria({ secretaria: { ativa: true, perguntas: ["25:99"] } }).ativa).toBe(false);
    expect(lerConfigDaSecretaria({ secretaria: { ativa: "sim" } }).ativa).toBe(false);
  });
});

describe("decidirAtualidade", () => {
  it("secretaria desligada: a regra não existe", () => {
    expect(
      decidirAtualidade({ config: cfg({ ativa: false }), ultimaConferidaEm: null, agora: AGORA }),
    ).toBe("sem_secretaria");
  });

  it("ligada e NUNCA conferida: desatualizada (não oferece nada)", () => {
    expect(decidirAtualidade({ config: cfg(), ultimaConferidaEm: null, agora: AGORA })).toBe("desatualizada");
  });

  it("conferida há pouco: atual", () => {
    expect(decidirAtualidade({ config: cfg(), ultimaConferidaEm: horasAtras(1), agora: AGORA })).toBe("atual");
    expect(decidirAtualidade({ config: cfg(), ultimaConferidaEm: horasAtras(6), agora: AGORA })).toBe("atual");
  });

  it("passou da validade de hoje: só dos dias seguintes em diante", () => {
    expect(decidirAtualidade({ config: cfg(), ultimaConferidaEm: horasAtras(6.01), agora: AGORA })).toBe("sem_hoje");
    expect(decidirAtualidade({ config: cfg(), ultimaConferidaEm: horasAtras(24), agora: AGORA })).toBe("sem_hoje");
  });

  it("passou da validade dos dias seguintes: desatualizada", () => {
    expect(decidirAtualidade({ config: cfg(), ultimaConferidaEm: horasAtras(24.01), agora: AGORA })).toBe(
      "desatualizada",
    );
    expect(decidirAtualidade({ config: cfg(), ultimaConferidaEm: horasAtras(24 * 30), agora: AGORA })).toBe(
      "desatualizada",
    );
  });

  it("respeita a validade configurada", () => {
    const c = cfg({ validade_hoje_horas: 2, validade_futuro_horas: 4 });
    expect(decidirAtualidade({ config: c, ultimaConferidaEm: horasAtras(1.9), agora: AGORA })).toBe("atual");
    expect(decidirAtualidade({ config: c, ultimaConferidaEm: horasAtras(3), agora: AGORA })).toBe("sem_hoje");
    expect(decidirAtualidade({ config: c, ultimaConferidaEm: horasAtras(5), agora: AGORA })).toBe("desatualizada");
  });

  it("carimbo no FUTURO (relógios fora de sintonia) não vira 'super fresca': conta como agora", () => {
    const futuro = new Date(AGORA.getTime() + 3 * 3_600_000);
    expect(decidirAtualidade({ config: cfg(), ultimaConferidaEm: futuro, agora: AGORA })).toBe("atual");
  });
});

/** Um supabase de mentira que responde a `organizations` e a `agenda_relatos`. */
function supabaseDe(opts: { settings?: unknown; conferidoEm?: string | null; erroNosRelatos?: boolean }) {
  const consultas: string[] = [];
  const cliente = {
    from: (tabela: string) => {
      consultas.push(tabela);
      const q: Record<string, unknown> = {};
      for (const m of ["select", "eq", "order"]) q[m] = () => q;
      if (tabela === "organizations") {
        q.maybeSingle = async () => ({ data: { settings: opts.settings }, error: null });
      } else {
        q.limit = async () =>
          opts.erroNosRelatos
            ? { data: null, error: { message: "boom" } }
            : { data: opts.conferidoEm ? [{ conferido_em: opts.conferidoEm }] : [], error: null };
      }
      return q;
    },
  };
  return { cliente: cliente as never, consultas };
}

describe("situacaoDaAgendaDaSecretaria", () => {
  it("secretaria desligada: nem consulta os relatos (zero custo para quem não usa)", async () => {
    const { cliente, consultas } = supabaseDe({ settings: {} });
    const r = await situacaoDaAgendaDaSecretaria(cliente, "org-1", AGORA);
    expect(r.estado).toBe("sem_secretaria");
    expect(consultas).toEqual(["organizations"]);
  });

  it("ligada e conferida há 1h: atual", async () => {
    const { cliente } = supabaseDe({
      settings: { secretaria: { ativa: true } },
      conferidoEm: horasAtras(1).toISOString(),
    });
    expect((await situacaoDaAgendaDaSecretaria(cliente, "org-1", AGORA)).estado).toBe("atual");
  });

  it("ligada e sem nenhum relato conferido: desatualizada", async () => {
    const { cliente } = supabaseDe({ settings: { secretaria: { ativa: true } }, conferidoEm: null });
    expect((await situacaoDaAgendaDaSecretaria(cliente, "org-1", AGORA)).estado).toBe("desatualizada");
  });

  it("erro ao ler os relatos PROPAGA (quem chama decide; não vira 'atual' em silêncio)", async () => {
    const { cliente } = supabaseDe({ settings: { secretaria: { ativa: true } }, erroNosRelatos: true });
    await expect(situacaoDaAgendaDaSecretaria(cliente, "org-1", AGORA)).rejects.toThrow("boom");
  });
});
