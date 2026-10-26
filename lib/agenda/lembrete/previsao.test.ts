import { describe, expect, it } from "vitest";

import { preverLembrete, preverLembreteDoCompromisso, type EntradaDaPrevisao } from "./previsao";

/**
 * O QUE A IA PODE PROMETER — cada recusa tem o seu caso, e a frase manda não prometer.
 */

const AGORA = new Date("2026-10-23T12:00:00Z");
const COMECA = new Date("2026-10-26T17:00:00Z"); // 3 dias adiante

const base: EntradaDaPrevisao = {
  ligado: true,
  minutosAntes: 1440,
  temContato: true,
  contatoSemMensagens: false,
  comecaEm: COMECA,
  agora: AGORA,
};

describe("preverLembrete", () => {
  it("controle positivo: ligado, contato aceita, dentro do prazo ⇒ será enviado, com a antecedência", () => {
    const p = preverLembrete(base);
    expect(p).toMatchObject({ sera_enviado: true, antecedencia_horas: 24 });
    expect(p.motivo).toBeUndefined();
    expect(p.instrucao).toContain("24 h antes");
  });

  it("arredonda a antecedência em horas (e nunca diz 0 h)", () => {
    expect(preverLembrete({ ...base, minutosAntes: 90 }).antecedencia_horas).toBe(2);
    expect(preverLembrete({ ...base, minutosAntes: 20 }).antecedencia_horas).toBe(1);
    expect(preverLembrete({ ...base, minutosAntes: 2880 }).antecedencia_horas).toBe(48);
  });

  it("tipo com o lembrete desligado: não será enviado, e a instrução manda NÃO prometer", () => {
    const p = preverLembrete({ ...base, ligado: false });
    expect(p).toMatchObject({ sera_enviado: false, motivo: "desligado" });
    expect(p.antecedencia_horas).toBeUndefined();
    expect(p.instrucao).toContain("Não prometa");
  });

  it("contato que pediu para não receber mensagens", () => {
    const p = preverLembrete({ ...base, contatoSemMensagens: true });
    expect(p).toMatchObject({ sera_enviado: false, motivo: "contato_pediu_para_nao_receber" });
    expect(p.instrucao).toContain("Não prometa");
  });

  it("sem contato vinculado", () => {
    const p = preverLembrete({ ...base, temContato: false });
    expect(p).toMatchObject({ sera_enviado: false, motivo: "sem_contato" });
  });

  it("marcado em cima da hora: o momento do lembrete já passou", () => {
    const p = preverLembrete({ ...base, comecaEm: new Date("2026-10-23T20:00:00Z") });
    expect(p).toMatchObject({
      sera_enviado: false,
      motivo: "marcado_depois_do_momento_do_lembrete",
    });
    expect(p.instrucao).toContain("Confirme data e hora aqui mesmo");
  });

  it("a borda: exatamente no momento do lembrete já é tarde (igual ao cron: armado >= devido)", () => {
    const p = preverLembrete({ ...base, comecaEm: new Date(AGORA.getTime() + 24 * 3_600_000) });
    expect(p.sera_enviado).toBe(false);
    const umInstanteAntes = preverLembrete({
      ...base,
      comecaEm: new Date(AGORA.getTime() + 24 * 3_600_000 + 1),
    });
    expect(umInstanteAntes.sera_enviado).toBe(true);
  });

  it("a ordem das recusas: contato bloqueado vence 'desligado' (a vontade da pessoa é o motivo a dizer)", () => {
    const p = preverLembrete({ ...base, ligado: false, contatoSemMensagens: true });
    expect(p.motivo).toBe("contato_pediu_para_nao_receber");
  });
});

// ─── a versão que lê o banco ─────────────────────────────────────────────────

function clienteFalso(opcoes: {
  tipo?: { reminder_enabled: boolean; reminder_minutes_before: number } | null;
  contato?: { is_blocked: boolean; is_anonymized: boolean } | null;
  erro?: "tipo" | "contato";
}) {
  const consultas: Array<{ tabela: string; filtros: Array<[string, unknown]> }> = [];
  const cliente = {
    from: (tabela: string) => {
      const filtros: Array<[string, unknown]> = [];
      consultas.push({ tabela, filtros });
      const cadeia = {
        select: () => cadeia,
        eq: (coluna: string, valor: unknown) => {
          filtros.push([coluna, valor]);
          return cadeia;
        },
        maybeSingle: async () => {
          // No caso de erro a linha VEM JUNTO com o erro, de propósito: o que se prova é que o
          // `error` é consultado, e não que a ausência de dado por acaso o cobre.
          if (tabela === "calendar_event_types") {
            return {
              data: opcoes.tipo ?? null,
              error: opcoes.erro === "tipo" ? { message: "boom" } : null,
            };
          }
          return {
            data: opcoes.contato ?? null,
            error: opcoes.erro === "contato" ? { message: "boom" } : null,
          };
        },
      };
      return cadeia;
    },
  };
  return { cliente: cliente as never, consultas };
}

describe("preverLembreteDoCompromisso", () => {
  const alvo = { eventTypeId: "tp-1", contactId: "ct-1", comecaEm: COMECA };

  it("lê o tipo e o contato COM a organização no filtro (o client é service-role)", async () => {
    const { cliente, consultas } = clienteFalso({
      tipo: { reminder_enabled: true, reminder_minutes_before: 1440 },
      contato: { is_blocked: false, is_anonymized: false },
    });
    const p = await preverLembreteDoCompromisso(cliente, "org-1", alvo, AGORA);

    expect(p.sera_enviado).toBe(true);
    for (const c of consultas) {
      expect(c.filtros).toContainEqual(["organization_id", "org-1"]);
    }
    expect(consultas.map((c) => c.tabela).sort()).toEqual(["calendar_event_types", "contacts"]);
  });

  it("contato anonimizado conta como 'não aceita mensagens'", async () => {
    const { cliente } = clienteFalso({
      tipo: { reminder_enabled: true, reminder_minutes_before: 1440 },
      contato: { is_blocked: false, is_anonymized: true },
    });
    const p = await preverLembreteDoCompromisso(cliente, "org-1", alvo, AGORA);
    expect(p.motivo).toBe("contato_pediu_para_nao_receber");
  });

  it("erro de leitura NUNCA vira promessa: indeterminado, e manda não prometer", async () => {
    for (const erro of ["tipo", "contato"] as const) {
      const { cliente } = clienteFalso({
        tipo: { reminder_enabled: true, reminder_minutes_before: 1440 },
        contato: { is_blocked: false, is_anonymized: false },
        erro,
      });
      const p = await preverLembreteDoCompromisso(cliente, "org-1", alvo, AGORA);
      expect(p).toMatchObject({ sera_enviado: false, motivo: "indeterminado" });
      expect(p.instrucao).toContain("Não prometa");
    }
  });

  it("tipo ou contato que não existem na organização: indeterminado", async () => {
    const { cliente } = clienteFalso({ tipo: null, contato: null });
    expect((await preverLembreteDoCompromisso(cliente, "org-1", alvo, AGORA)).motivo).toBe(
      "indeterminado",
    );
  });

  it("sem contato nem consulta ao banco: devolve sem_contato direto", async () => {
    const { cliente, consultas } = clienteFalso({});
    const p = await preverLembreteDoCompromisso(
      cliente,
      "org-1",
      { ...alvo, contactId: null },
      AGORA,
    );
    expect(p.motivo).toBe("sem_contato");
    expect(consultas).toHaveLength(0);
  });
});
