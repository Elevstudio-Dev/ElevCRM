import { describe, expect, it, vi } from "vitest";

import { portasDoTickNoSupabase } from "@/lib/bastidor/secretaria/perguntas-supabase";
import type { SecretariaAtiva } from "@/lib/bastidor/secretaria/perguntas-tick";
import { CONFIG_PADRAO_DA_SECRETARIA } from "@/lib/agenda/secretaria/config";

/**
 * As portas do tick ligadas ao Supabase, com um cliente falso que ENCADEIA como o de verdade e anota o que foi pedido.
 * Não prova o PostgREST (isso é o CI com banco); prova que cada porta pede a TABELA e a COLUNA certas e que "quem
 * chegou primeiro" é decidido pelo que o banco devolve, não por suposição.
 */
interface Chamada {
  tabela: string;
  passos: Array<[string, ...unknown[]]>;
}

function clienteFalso(respostas: (c: Chamada) => { data?: unknown; error?: { message: string } | null }) {
  const chamadas: Chamada[] = [];
  const from = (tabela: string) => {
    const chamada: Chamada = { tabela, passos: [] };
    chamadas.push(chamada);
    const cadeia: Record<string, unknown> = {};
    for (const metodo of ["select", "insert", "update", "upsert", "eq", "in", "is", "gte", "match", "order", "limit"]) {
      cadeia[metodo] = (...args: unknown[]) => {
        chamada.passos.push([metodo, ...args]);
        return cadeia;
      };
    }
    cadeia.then = (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) =>
      Promise.resolve({ data: null, error: null, ...respostas(chamada) }).then(ok, ko);
    return cadeia;
  };
  return { admin: { from } as never, chamadas };
}

const SEC: SecretariaAtiva = {
  organizationId: "org-1",
  contactId: "contato-1",
  nome: "Ana",
  config: { ...CONFIG_PADRAO_DA_SECRETARIA, ativa: true },
  fuso: "America/Sao_Paulo",
};

const semErro = vi.fn();
const passo = (c: Chamada, metodo: string) => c.passos.find(([m]) => m === metodo);

describe("listarSecretarias", () => {
  const orgs = [
    { id: "org-1", timezone: "America/Manaus", settings: { secretaria: { ativa: true, dono_da_agenda_user_id: "11111111-1111-4111-8111-111111111111" } } },
    { id: "org-2", timezone: null, settings: { secretaria: { ativa: true } } },
    { id: "org-3", timezone: "America/Recife", settings: { secretaria: { ativa: false } } },
  ];
  const contatos = [
    { id: "c1", organization_id: "org-1", display_name: "Ana" },
    { id: "c2", organization_id: "org-2", display_name: "Bia" },
    { id: "c3", organization_id: "org-3", display_name: "Cris" },
  ];

  function lista() {
    return clienteFalso((c) => {
      if (c.tabela === "organizations") return { data: orgs };
      if (c.tabela === "contacts") return { data: contatos };
      if (c.tabela === "attendant_availability") {
        return { data: [{ organization_id: "org-1", user_id: "11111111-1111-4111-8111-111111111111", schedule: { timezone: "America/Cuiaba" } }] };
      }
      return {};
    });
  }

  it("filtra no banco as organizações com a agenda da secretaria ligada, e só os contatos com o papel, ativos", async () => {
    const { admin, chamadas } = lista();
    await portasDoTickNoSupabase(admin, semErro).listarSecretarias();
    expect(passo(chamadas[0]!, "eq")).toEqual(["eq", "settings->secretaria->>ativa", "true"]);
    const contatosCham = chamadas.find((c) => c.tabela === "contacts")!;
    expect(contatosCham.passos).toEqual(
      expect.arrayContaining([
        ["eq", "papel_interno", "secretaria"],
        ["eq", "is_blocked", false],
        ["eq", "is_anonymized", false],
      ]),
    );
  });

  it("o fuso é o da jornada do dono; sem ela, o da organização; sem nenhum, São Paulo", async () => {
    const { admin } = lista();
    const r = await portasDoTickNoSupabase(admin, semErro).listarSecretarias();
    expect(r.find((s) => s.contactId === "c1")?.fuso).toBe("America/Cuiaba");
    expect(r.find((s) => s.contactId === "c2")?.fuso).toBe("America/Sao_Paulo");
  });

  it("organização com a secretaria desligada na config não entra, mesmo que o banco a devolva", async () => {
    const { admin } = lista();
    const r = await portasDoTickNoSupabase(admin, semErro).listarSecretarias();
    expect(r.map((s) => s.contactId)).toEqual(["c1", "c2"]);
  });

  it("nenhuma organização ligada: não consulta contatos nem jornadas", async () => {
    const { admin, chamadas } = clienteFalso(() => ({ data: [] }));
    expect(await portasDoTickNoSupabase(admin, semErro).listarSecretarias()).toEqual([]);
    expect(chamadas.map((c) => c.tabela)).toEqual(["organizations"]);
  });

  it("erro do banco propaga (o tick vira 500), não vira lista vazia calada", async () => {
    const { admin } = clienteFalso(() => ({ error: { message: "boom" } }));
    await expect(portasDoTickNoSupabase(admin, semErro).listarSecretarias()).rejects.toThrow(/organizations: boom/);
  });
});

describe("registrar — quem grava primeiro ganha", () => {
  it("devolve verdadeiro se o upsert gravou uma linha, e usa a chave única com ignoreDuplicates", async () => {
    const { admin, chamadas } = clienteFalso(() => ({ data: [{ id: "x" }] }));
    const ok = await portasDoTickNoSupabase(admin, semErro).portasDe(SEC).registrar("2026-11-17", "08:30", "pedida");
    expect(ok).toBe(true);
    expect(chamadas[0]!.tabela).toBe("agenda_perguntas");
    expect(passo(chamadas[0]!, "upsert")).toEqual([
      "upsert",
      { organization_id: "org-1", contact_id: "contato-1", dia: "2026-11-17", horario: "08:30", estado: "pedida" },
      { onConflict: "organization_id,contact_id,dia,horario", ignoreDuplicates: true },
    ]);
  });

  it("devolve falso quando o banco ignorou o duplicado (nenhuma linha devolvida)", async () => {
    const { admin } = clienteFalso(() => ({ data: [] }));
    expect(await portasDoTickNoSupabase(admin, semErro).portasDe(SEC).registrar("2026-11-17", "08:30", "pedida")).toBe(false);
  });
});

describe("carimbos condicionais", () => {
  it("lembrete: só carimba se ainda não estava carimbado, e diz se foi quem carimbou", async () => {
    const { admin, chamadas } = clienteFalso(() => ({ data: [{ id: "x" }] }));
    const portas = portasDoTickNoSupabase(admin, semErro, () => new Date("2026-11-17T12:00:00Z")).portasDe(SEC);
    expect(await portas.marcarLembrete("2026-11-17", "08:30")).toBe(true);
    expect(passo(chamadas[0]!, "update")).toEqual(["update", { lembrete_pedido_em: "2026-11-17T12:00:00.000Z" }]);
    expect(passo(chamadas[0]!, "is")).toEqual(["is", "lembrete_pedido_em", null]);
  });

  it("aviso: idem, na coluna certa; outra instância à frente = falso", async () => {
    const { admin, chamadas } = clienteFalso(() => ({ data: [] }));
    const portas = portasDoTickNoSupabase(admin, semErro).portasDe(SEC);
    expect(await portas.marcarAdminAvisado("2026-11-17", "08:30")).toBe(false);
    expect(passo(chamadas[0]!, "is")).toEqual(["is", "admin_avisado_em", null]);
  });
});

describe("conversa e resposta", () => {
  it("a conversa é a individual (não grupo) mais recente dela", async () => {
    const { admin, chamadas } = clienteFalso(() => ({ data: [{ id: "conv-9", channel_session_id: "sess-9" }] }));
    const c = await portasDoTickNoSupabase(admin, semErro).portasDe(SEC).conversa();
    expect(c).toEqual({ conversationId: "conv-9", channelSessionId: "sess-9" });
    expect(chamadas[0]!.passos).toEqual(
      expect.arrayContaining([
        ["eq", "is_group", false],
        ["order", "last_message_at", { ascending: false, nullsFirst: false }],
      ]),
    );
  });

  it("sem nenhuma conversa: nulo", async () => {
    const { admin } = clienteFalso(() => ({ data: [] }));
    expect(await portasDoTickNoSupabase(admin, semErro).portasDe(SEC).conversa()).toBeNull();
  });

  it("resposta = mensagem RECEBIDA dela depois do instante da pergunta; sem conversa, nem consulta mensagens", async () => {
    const { admin, chamadas } = clienteFalso(() => ({ data: [] }));
    expect(await portasDoTickNoSupabase(admin, semErro).portasDe(SEC).primeiraRespostaDesde(new Date("2026-11-17T11:30:00Z"))).toBeNull();
    expect(chamadas.map((c) => c.tabela)).toEqual(["conversations"]);

    const { admin: admin2, chamadas: chamadas2 } = clienteFalso((c) =>
      c.tabela === "conversations" ? { data: [{ id: "conv-1" }] } : { data: [{ created_at: "2026-11-17T11:50:00Z" }] },
    );
    const quando = await portasDoTickNoSupabase(admin2, semErro).portasDe(SEC).primeiraRespostaDesde(new Date("2026-11-17T11:30:00Z"));
    expect(quando).toEqual(new Date("2026-11-17T11:50:00Z"));
    expect(chamadas2[1]!.passos).toEqual(
      expect.arrayContaining([
        ["eq", "direction", "inbound"],
        ["gte", "created_at", "2026-11-17T11:30:00.000Z"],
      ]),
    );
  });
});

describe("enfileirar", () => {
  it("insere um job bastidor_turn com a conversa, a ação, o dia e o horário", async () => {
    const { admin, chamadas } = clienteFalso(() => ({}));
    await portasDoTickNoSupabase(admin, semErro)
      .portasDe(SEC)
      .enfileirar({ acao: "perguntar", dia: "2026-11-17", horario: "08:30", conversa: { conversationId: "conv-1", channelSessionId: "sess-1" } });
    expect(chamadas[0]!.tabela).toBe("job_queue");
    expect(passo(chamadas[0]!, "insert")).toEqual([
      "insert",
      {
        organization_id: "org-1",
        contact_id: "contato-1",
        kind: "bastidor_turn",
        payload: {
          conversation_id: "conv-1",
          contact_id: "contato-1",
          channel_session_id: "sess-1",
          acao: "perguntar",
          dia: "2026-11-17",
          horario: "08:30",
        },
      },
    ]);
  });

  it("erro da fila propaga (o tick conta o erro)", async () => {
    const { admin } = clienteFalso(() => ({ error: { message: "fila fora" } }));
    await expect(
      portasDoTickNoSupabase(admin, semErro)
        .portasDe(SEC)
        .enfileirar({ acao: "lembrar", dia: "2026-11-17", horario: "08:30", conversa: { conversationId: "c", channelSessionId: "s" } }),
    ).rejects.toThrow(/job_queue: fila fora/);
  });
});

describe("o resumo esperando o 'sim' e o lembrete de confirmar", () => {
  it("resumoPendente: o relato `lido` mais recente DELA, na organização dela", async () => {
    const { admin, chamadas } = clienteFalso(() => ({ data: [{ id: "rel-1", created_at: "2026-11-17T20:50:00Z" }] }));
    const r = await portasDoTickNoSupabase(admin, semErro).portasDe(SEC).resumoPendente();
    expect(r).toEqual({ relatoId: "rel-1", criadoEm: new Date("2026-11-17T20:50:00Z") });
    expect(chamadas[0]!.tabela).toBe("agenda_relatos");
    expect(chamadas[0]!.passos).toEqual(
      expect.arrayContaining([
        ["match", { organization_id: "org-1", contact_id: "contato-1" }],
        ["in", "estado", ["lido"]],
        ["order", "created_at", { ascending: false }],
        ["limit", 1],
      ]),
    );
  });

  it("resumoPendente sem nenhum: nulo; erro do banco propaga", async () => {
    expect(await portasDoTickNoSupabase(clienteFalso(() => ({ data: [] })).admin, semErro).portasDe(SEC).resumoPendente()).toBeNull();
    await expect(
      portasDoTickNoSupabase(clienteFalso(() => ({ error: { message: "boom" } })).admin, semErro).portasDe(SEC).resumoPendente(),
    ).rejects.toThrow(/agenda_relatos: boom/);
  });

  it("o lembrete é UM job por resumo: `source_event_id` = id do relato (o índice único da fila recusa o segundo)", async () => {
    const { admin, chamadas } = clienteFalso(() => ({}));
    const ok = await portasDoTickNoSupabase(admin, semErro)
      .portasDe(SEC)
      .enfileirarLembreteDaConferencia("rel-1", { conversationId: "conv-1", channelSessionId: "sess-1" });
    expect(ok).toBe(true);
    expect(passo(chamadas[0]!, "insert")).toEqual([
      "insert",
      {
        organization_id: "org-1",
        contact_id: "contato-1",
        kind: "bastidor_turn",
        source_event_id: "rel-1",
        payload: {
          conversation_id: "conv-1",
          contact_id: "contato-1",
          channel_session_id: "sess-1",
          acao: "lembrar_conferencia",
          relato_id: "rel-1",
        },
      },
    ]);
  });

  it("o segundo lembrete do mesmo resumo (23505): falso, sem erro; outro erro propaga", async () => {
    const dup = clienteFalso(() => ({ error: { message: "duplicate key", code: "23505" } as { message: string } }));
    expect(
      await portasDoTickNoSupabase(dup.admin, semErro)
        .portasDe(SEC)
        .enfileirarLembreteDaConferencia("rel-1", { conversationId: "c", channelSessionId: "s" }),
    ).toBe(false);
    const fora = clienteFalso(() => ({ error: { message: "fila fora" } }));
    await expect(
      portasDoTickNoSupabase(fora.admin, semErro)
        .portasDe(SEC)
        .enfileirarLembreteDaConferencia("rel-1", { conversationId: "c", channelSessionId: "s" }),
    ).rejects.toThrow(/job_queue: fila fora/);
  });
});

describe("o resumo sem confirmação depois do lembrete (M2)", () => {
  it("lembreteDaConferenciaEnviadoEm: o job concluído DESTE resumo, na organização", async () => {
    const { admin, chamadas } = clienteFalso(() => ({ data: [{ created_at: "2026-11-17T17:00:00Z" }] }));
    expect(await portasDoTickNoSupabase(admin, semErro).portasDe(SEC).lembreteDaConferenciaEnviadoEm("rel-1")).toEqual(
      new Date("2026-11-17T17:00:00Z"),
    );
    expect(chamadas[0]!.passos).toEqual(
      expect.arrayContaining([
        ["eq", "organization_id", "org-1"],
        ["eq", "source_event_id", "rel-1"],
        ["eq", "status", "done"],
      ]),
    );
  });

  it("avisarResumoSemConfirmacao: um item agenda_sem_resposta POR RESUMO, em português, sem nome de paciente", async () => {
    const { admin, chamadas } = clienteFalso((c) => (passo(c, "select") ? { data: [] } : {}));
    expect(await portasDoTickNoSupabase(admin, semErro).portasDe(SEC).avisarResumoSemConfirmacao("rel-1")).toBe(true);
    const linha = passo(chamadas.find((c) => passo(c, "insert"))!, "insert")![1] as Record<string, string>;
    expect(linha).toMatchObject({ kind: "agenda_sem_resposta", severity: "warn", ref_kind: "agenda_relatos", ref_id: "rel-1" });
    expect(linha.title).toMatch(/não confirmou o resumo da agenda/);
    expect(linha.body).toMatch(/a IA não oferece horários/);
    expect(linha.body).toMatch(/O que fazer/);
  });

  it("já existe aviso para este resumo: não abre outro", async () => {
    const { admin, chamadas } = clienteFalso((c) => (passo(c, "select") ? { data: [{ id: "x" }] } : {}));
    expect(await portasDoTickNoSupabase(admin, semErro).portasDe(SEC).avisarResumoSemConfirmacao("rel-1")).toBe(false);
    expect(chamadas.some((c) => passo(c, "insert"))).toBe(false);
  });
});

describe("avisar o administrador", () => {
  it("abre UM cartão agenda_sem_resposta na Central de avisos, ligado ao contato", async () => {
    const { admin, chamadas } = clienteFalso((c) => (passo(c, "select") ? { data: [] } : {}));
    await portasDoTickNoSupabase(admin, semErro).portasDe(SEC).avisarAdmin("sem_resposta", "2026-11-17", "08:30");
    const insercao = chamadas.find((c) => passo(c, "insert"))!;
    expect(insercao.tabela).toBe("agent_inbox_items");
    const linha = passo(insercao, "insert")![1] as Record<string, unknown>;
    expect(linha).toMatchObject({ organization_id: "org-1", kind: "agenda_sem_resposta", severity: "warn", ref_kind: "contacts", ref_id: "contato-1" });
    expect(String(linha.title)).toContain("08:30");
  });

  it("já existe cartão ABERTO para ela: não empilha outro", async () => {
    const { admin, chamadas } = clienteFalso((c) => (passo(c, "select") ? { data: [{ id: "aberto" }] } : {}));
    await portasDoTickNoSupabase(admin, semErro).portasDe(SEC).avisarAdmin("sem_resposta", "2026-11-17", "14:00");
    expect(chamadas.some((c) => passo(c, "insert"))).toBe(false);
  });

  it("o texto de 'sem conversa' diz o que fazer; o de 'sem resposta' diz o efeito, e nenhum traz telefone", async () => {
    const { admin, chamadas } = clienteFalso((c) => (passo(c, "select") ? { data: [] } : {}));
    const portas = portasDoTickNoSupabase(admin, semErro).portasDe(SEC);
    await portas.avisarAdmin("sem_conversa", "2026-11-17", "08:30");
    const corpo = String((passo(chamadas.find((c) => passo(c, "insert"))!, "insert")![1] as { body: string }).body);
    expect(corpo).toMatch(/mande uma mensagem|mensagem ao número/i);
    expect(corpo).not.toMatch(/\d{8,}/);
  });
});
