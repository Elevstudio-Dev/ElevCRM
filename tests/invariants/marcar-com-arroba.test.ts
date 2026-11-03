import { beforeAll, describe, expect, it } from "vitest";

import { lastLine, sql } from "./gov-helpers";

/**
 * MARCAR ALGUÉM COM @ — "quem pode ser marcado" é a MESMA regra de "quem enxerga", medida no banco.
 *
 * Migration 0222. As funções `fn_membros_que_veem_conversa` e `fn_membros_do_canal` respondem "QUEM vê?",
 * e as policies de RLS (`fn_can_view_conversation`, `fn_can_view_team_channel`) respondem "EU vejo?" lendo
 * `auth.uid()`. São DUAS implementações da mesma regra — e uma regra escrita duas vezes é uma regra que
 * um dia diverge. Divergir aqui tem um custo concreto: marcar alguém que não enxerga a conversa é
 * entregar a essa pessoa um aviso com o começo de uma conversa que ela não pode abrir.
 *
 * Por isso a prova não é "a função devolve o que eu esperava": é "a função devolve EXATAMENTE quem a RLS
 * deixa ler", usuário a usuário, conversa a conversa, nos três modos de visibilidade e com setor.
 * Se alguém mudar uma das duas implementações sem a outra, este arquivo reprova.
 */

const ns = "a77a0000";
const id = (grupo: number, n: number) => `${ns}-${String(grupo).padStart(4, "0")}-4000-8000-${String(n).padStart(12, "0")}`;

// ── pessoas ────────────────────────────────────────────────────────────────
const ADA = id(1, 1); // admin
const CAIO = id(1, 2); // manager
const ANA = id(1, 3); // agent, setor Financeiro
const BIA = id(1, 4); // agent, sem setor
const DAVI = id(1, 5); // agent, setor Suporte
const VERA = id(1, 6); // viewer
const RUI = id(1, 7); // agent com acesso REVOGADO
const ELI = id(1, 8); // agent de OUTRA organização
const SEM_NOME = id(1, 9); // agent sem full_name (o nome cai para o começo do e-mail)

const PESSOAS: Array<{ id: string; role: string; setor?: "fin" | "sup"; revogado?: boolean }> = [
  { id: ADA, role: "admin" },
  { id: CAIO, role: "manager" },
  { id: ANA, role: "agent", setor: "fin" },
  { id: BIA, role: "agent" },
  { id: DAVI, role: "agent", setor: "sup" },
  { id: VERA, role: "viewer" },
  { id: RUI, role: "agent", revogado: true },
  { id: SEM_NOME, role: "agent" },
];
const QUEM_PODE_ESTAR = [ADA, CAIO, ANA, BIA, DAVI, VERA, RUI, SEM_NOME];

// ── organizações, uma por modo de visibilidade ─────────────────────────────
const ORGS = [
  { n: 1, modo: "all" as const },
  { n: 2, modo: "own_and_unassigned" as const },
  { n: 3, modo: "own" as const },
];
const ORG_OUTRA = id(2, 99);
const org = (n: number) => id(2, n);
const setor = (n: number, qual: "fin" | "sup") => id(3, n * 10 + (qual === "fin" ? 1 : 2));

// 9 conversas por organização: responsável {ninguém, Ana, Bia} × setor {nenhum, Financeiro, Suporte}.
const RESPONSAVEIS = [null, ANA, BIA] as const;
const SETORES = [null, "fin", "sup"] as const;
const conversa = (n: number, r: number, s: number) => id(4, n * 100 + r * 10 + s);

function comoUsuario(userId: string, consulta: string): string {
  return lastLine(
    sql(`
      set role authenticated;
      select set_config('request.jwt.claims', '{"sub":"${userId}"}', false);
      ${consulta}
    `),
  );
}

/**
 * Os ids que o usuário LÊ, pela RLS. A consulta devolve sempre `ids=<lista>` — uma linha que nunca é
 * vazia: com a lista vazia (quem não lê nada), `lastLine` devolveria a linha do `set_config` acima e
 * o teste leria o JWT como se fosse um id.
 */
function idsQueOUsuarioLe(userId: string, tabela: "conversations" | "team_channels", orgId: string): string[] {
  const saida = comoUsuario(
    userId,
    `select 'ids=' || coalesce(string_agg(id::text, ',' order by id), '') from public.${tabela} where organization_id = '${orgId}';`,
  );
  if (!saida.startsWith("ids=")) throw new Error(`saída inesperada: ${saida}`);
  return saida.slice(4).split(",").filter(Boolean);
}

const sessao = (n: number) => id(5, n);
const contato = (n: number, i: number) => id(6, n * 100 + i);

beforeAll(() => {
  const partes: string[] = [];
  partes.push(`
    insert into auth.users (id, email, raw_user_meta_data) values
      ${QUEM_PODE_ESTAR.concat(ELI)
        .map((u) => {
          const nome = u === SEM_NOME ? "" : `Pessoa ${u.slice(-2)}`;
          const meta = nome ? `'{"full_name":"${nome}"}'::jsonb` : `'{}'::jsonb`;
          return `('${u}', 'p${u.slice(-2)}@invariant.test', ${meta})`;
        })
        .join(",\n      ")}
    on conflict (id) do nothing;
    insert into public.organizations (id, slug, legal_name, display_name, settings) values
      ${ORGS.map((o) => `('${org(o.n)}', 'arroba-${o.n}', 'Arroba ${o.n}', 'Arroba ${o.n}', jsonb_build_object('visibility_mode', '${o.modo}'))`).join(",\n      ")},
      ('${ORG_OUTRA}', 'arroba-outra', 'Arroba Outra', 'Arroba Outra', '{}'::jsonb)
    on conflict (id) do nothing;
    insert into public.user_organizations (user_id, organization_id, role, accepted_at, revoked_at)
      values ('${ELI}', '${ORG_OUTRA}', 'agent', now(), null) on conflict do nothing;
  `);

  for (const o of ORGS) {
    for (const p of PESSOAS) {
      partes.push(
        `insert into public.user_organizations (user_id, organization_id, role, accepted_at, revoked_at)
           values ('${p.id}', '${org(o.n)}', '${p.role}', now(), ${p.revogado ? "now()" : "null"}) on conflict do nothing;`,
      );
    }
    partes.push(`
      insert into public.sectors (id, organization_id, name) values
        ('${setor(o.n, "fin")}', '${org(o.n)}', 'Financeiro'), ('${setor(o.n, "sup")}', '${org(o.n)}', 'Suporte')
      on conflict (id) do nothing;
      insert into public.sector_members (sector_id, user_id, organization_id) values
        ('${setor(o.n, "fin")}', '${ANA}', '${org(o.n)}'), ('${setor(o.n, "sup")}', '${DAVI}', '${org(o.n)}')
      on conflict do nothing;
      insert into public.channel_sessions (id, organization_id, waha_session_name, webhook_secret_encrypted)
        values ('${sessao(o.n)}', '${org(o.n)}', 'arroba-${o.n}', '\\x00'::bytea) on conflict (id) do nothing;
    `);
    let i = 0;
    for (let r = 0; r < RESPONSAVEIS.length; r += 1) {
      for (let s = 0; s < SETORES.length; s += 1) {
        i += 1;
        const dono = RESPONSAVEIS[r];
        const sec = SETORES[s];
        partes.push(`
          insert into public.contacts (id, organization_id, display_name)
            values ('${contato(o.n, i)}', '${org(o.n)}', 'Contato ${o.n}-${i}') on conflict (id) do nothing;
          insert into public.conversations
            (id, organization_id, contact_id, channel_session_id, status, assigned_to_user_id, assigned_at, assignee_kind, sector_id)
            values ('${conversa(o.n, r, s)}', '${org(o.n)}', '${contato(o.n, i)}', '${sessao(o.n)}',
                    '${dono ? "claimed" : "open"}', ${dono ? `'${dono}'` : "null"}, ${dono ? "now()" : "null"},
                    ${dono ? "'user'" : "null"}, ${sec ? `'${setor(o.n, sec)}'` : "null"})
            on conflict (id) do nothing;
        `);
      }
    }
  }
  sql(partes.join("\n"));
});

// ── A prova central: a função devolve EXATAMENTE quem a RLS deixa ler ──────
describe("fn_membros_que_veem_conversa == quem a RLS deixa ler a conversa", () => {
  for (const o of ORGS) {
    it(`organização com visibility_mode='${o.modo}': usuário a usuário, nas 9 combinações de responsável × setor`, () => {
      // O que a função diz: pares (conversa, usuário).
      const daFuncao = new Set(
        sql(`
          select c.id || '|' || f.user_id
            from public.conversations c
            cross join lateral public.fn_membros_que_veem_conversa(c.organization_id, c.id) f
           where c.organization_id = '${org(o.n)}';
        `)
          .split("\n")
          .filter(Boolean),
      );

      // O que a RLS diz: para cada usuário, as conversas que ele lê.
      const daRls = new Set<string>();
      const divergencias: string[] = [];
      for (const p of PESSOAS) {
        // O `viewer` lê (a RLS o deixa), mas não conversa com a equipe — a função o exclui de propósito.
        if (p.role === "viewer") continue;
        for (const c of idsQueOUsuarioLe(p.id, "conversations", org(o.n))) daRls.add(`${c}|${p.id}`);
      }

      for (const par of daFuncao) if (!daRls.has(par)) divergencias.push(`função inclui, RLS NÃO deixa ler: ${par}`);
      for (const par of daRls) if (!daFuncao.has(par)) divergencias.push(`RLS deixa ler, função NÃO inclui: ${par}`);
      expect(divergencias).toEqual([]);
      // E o teste não é vazio: há gente vendo conversa em toda organização.
      expect(daRls.size).toBeGreaterThan(9);
    });
  }

  it("a regra de cada papel, escrita à mão: manager+ vê tudo; agent no modo 'own' só as suas", () => {
    const quem = (n: number, r: number, s: number) =>
      sql(`select string_agg(user_id::text, ',' order by user_id) from public.fn_membros_que_veem_conversa('${org(n)}', '${conversa(n, r, s)}');`).split(",");

    // Sem responsável e sem setor, no modo padrão: a fila é de todo agente + a gestão.
    expect(quem(2, 0, 0)).toEqual(expect.arrayContaining([ADA, CAIO, ANA, BIA, DAVI, SEM_NOME]));
    // No modo 'own' a fila NÃO é de ninguém entre os agentes: só a gestão a vê.
    expect(quem(3, 0, 0).sort()).toEqual([ADA, CAIO].sort());
    // A Bia não está em setor nenhum: o filtro de setor não a alcança, e a conversa dela (mesmo num
    // setor que não é o dela) segue sendo dela, no modo 'own'.
    expect(quem(3, 2, 1).sort()).toEqual([ADA, CAIO, BIA].sort());
    // A Ana ESTÁ em um setor (Financeiro). A conversa dela, mas do setor Suporte: o setor vale mais que a
    // atribuição — ela não vê. É a regra de `fn_can_view_conversation` (0213) e a razão de este teste existir.
    expect(quem(3, 1, 2).sort()).toEqual([ADA, CAIO].sort());
  });
});

describe("quem NUNCA entra na lista de quem pode ser marcado", () => {
  const todos = (n: number) =>
    sql(`select string_agg(distinct f.user_id::text, ',') from public.conversations c
           cross join lateral public.fn_membros_que_veem_conversa(c.organization_id, c.id) f
          where c.organization_id = '${org(n)}';`).split(",");

  it("viewer (lê, mas não conversa com a equipe), acesso revogado e gente de OUTRA organização", () => {
    for (const o of ORGS) {
      const lista = todos(o.n);
      expect(lista).not.toContain(VERA);
      expect(lista).not.toContain(RUI);
      expect(lista).not.toContain(ELI);
    }
  });

  it("pedir uma conversa por uma organização que NÃO é a dela devolve lista vazia", () => {
    expect(sql(`select count(*) from public.fn_membros_que_veem_conversa('${org(2)}', '${conversa(1, 0, 0)}');`)).toBe("0");
    expect(sql(`select count(*) from public.fn_membros_que_veem_conversa('${ORG_OUTRA}', '${conversa(1, 0, 0)}');`)).toBe("0");
  });

  it("conversa que não existe devolve lista vazia (não erro)", () => {
    expect(sql(`select count(*) from public.fn_membros_que_veem_conversa('${org(1)}', '${id(9, 9)}');`)).toBe("0");
  });
});

describe("o nome que a lista devolve", () => {
  it("é o full_name; sem ele, o começo do e-mail — nunca vazio", () => {
    const linhas = sql(
      `select user_id || '|' || full_name || '|' || email from public.fn_membros_que_veem_conversa('${org(1)}', '${conversa(1, 0, 0)}');`,
    ).split("\n");
    const porId = new Map(linhas.map((l) => [l.split("|")[0]!, l.split("|")]));
    expect(porId.get(ANA)![1]).toBe(`Pessoa ${ANA.slice(-2)}`);
    expect(porId.get(SEM_NOME)![1]).toBe(`p${SEM_NOME.slice(-2)}`);
    expect(porId.get(SEM_NOME)![2]).toBe(`p${SEM_NOME.slice(-2)}@invariant.test`);
  });
});

// ── canais do chat da equipe ───────────────────────────────────────────────
const CANAL_GERAL = id(7, 1);
const CANAL_FIN = id(7, 2);
const CANAL_SUP = id(7, 3);
const CANAL_DIRETO = id(7, 4);

describe("fn_membros_do_canal == quem a RLS deixa ler o canal", () => {
  beforeAll(() => {
    sql(`
      insert into public.team_channels (id, organization_id, kind, sector_id, direct_key) values
        ('${CANAL_GERAL}', '${org(2)}', 'geral', null, null),
        ('${CANAL_FIN}', '${org(2)}', 'setor', '${setor(2, "fin")}', null),
        ('${CANAL_SUP}', '${org(2)}', 'setor', '${setor(2, "sup")}', null),
        ('${CANAL_DIRETO}', '${org(2)}', 'direto', null, '${[ANA, BIA].sort().join(":")}')
      on conflict (id) do nothing;
      insert into public.team_channel_members (channel_id, user_id, organization_id) values
        ('${CANAL_DIRETO}', '${ANA}', '${org(2)}'), ('${CANAL_DIRETO}', '${BIA}', '${org(2)}')
      on conflict do nothing;
    `);
  });

  it("Geral, Financeiro, Suporte e o direto Ana↔Bia: usuário a usuário", () => {
    const daFuncao = new Set(
      sql(`
        select c.id || '|' || f.user_id
          from public.team_channels c
          cross join lateral public.fn_membros_do_canal(c.organization_id, c.id) f
         where c.organization_id = '${org(2)}';
      `)
        .split("\n")
        .filter(Boolean),
    );
    const daRls = new Set<string>();
    for (const p of PESSOAS) {
      if (p.role === "viewer") continue;
      for (const c of idsQueOUsuarioLe(p.id, "team_channels", org(2))) daRls.add(`${c}|${p.id}`);
    }
    const divergencias: string[] = [];
    for (const par of daFuncao) if (!daRls.has(par)) divergencias.push(`função inclui, RLS NÃO deixa ler: ${par}`);
    for (const par of daRls) if (!daFuncao.has(par)) divergencias.push(`RLS deixa ler, função NÃO inclui: ${par}`);
    expect(divergencias).toEqual([]);
    expect(daRls.size).toBeGreaterThan(8);
  });

  it("regras à mão: Financeiro = Ana + gestão; direto = só os dois; Geral nunca tem viewer nem revogado", () => {
    const quem = (canal: string) =>
      sql(`select string_agg(user_id::text, ',' order by user_id) from public.fn_membros_do_canal('${org(2)}', '${canal}');`).split(",");
    expect(quem(CANAL_FIN).sort()).toEqual([ADA, CAIO, ANA].sort());
    expect(quem(CANAL_DIRETO).sort()).toEqual([ANA, BIA].sort());
    const geral = quem(CANAL_GERAL);
    expect(geral).toEqual(expect.arrayContaining([ADA, CAIO, ANA, BIA, DAVI, SEM_NOME]));
    expect(geral).not.toContain(VERA);
    expect(geral).not.toContain(RUI);
    expect(geral).not.toContain(ELI);
  });

  it("canal pedido pela organização errada devolve lista vazia", () => {
    expect(sql(`select count(*) from public.fn_membros_do_canal('${org(1)}', '${CANAL_GERAL}');`)).toBe("0");
    expect(sql(`select count(*) from public.fn_membros_do_canal('${ORG_OUTRA}', '${CANAL_GERAL}');`)).toBe("0");
  });
});

// ── quem pode EXECUTAR as funções ──────────────────────────────────────────
describe("as funções só executam para o service_role", () => {
  const funcoes = ["fn_membros_que_veem_conversa(uuid, uuid)", "fn_membros_do_canal(uuid, uuid)"];
  for (const f of funcoes) {
    it(`${f}: anon e authenticated NÃO executam (devolvem nome, papel e e-mail de colegas); service_role executa`, () => {
      const pode = (papel: string) =>
        sql(`select has_function_privilege('${papel}', 'public.${f}', 'execute');`);
      expect(pode("anon")).toBe("f");
      expect(pode("authenticated")).toBe("f");
      expect(pode("service_role")).toBe("t");
    });

    it(`${f}: chamar como authenticated é recusado de fato, e não só no catálogo`, () => {
      expect(() =>
        comoUsuario(ANA, `select count(*) from public.${f.replace("(uuid, uuid)", `('${org(2)}', '${conversa(2, 0, 0)}')`)};`),
      ).toThrow(/permission denied/);
    });
  }
});

// ── onde a marcação é guardada ─────────────────────────────────────────────
describe("a coluna mentions", () => {
  it("existe nas duas tabelas, `not null`, com default `[]`", () => {
    for (const tabela of ["team_messages", "conversation_notes"]) {
      const linha = sql(
        `select is_nullable || '|' || column_default || '|' || data_type from information_schema.columns
          where table_schema = 'public' and table_name = '${tabela}' and column_name = 'mentions';`,
      );
      expect(linha).toBe("NO|'[]'::jsonb|jsonb");
    }
  });

  it("só aceita LISTA e no máximo 20 itens", () => {
    for (const tabela of ["team_messages", "conversation_notes"]) {
      const coluna = tabela === "team_messages" ? "channel_id" : "conversation_id";
      const alvo = tabela === "team_messages" ? CANAL_GERAL : conversa(2, 0, 0);
      const base =
        tabela === "team_messages"
          ? `insert into public.team_messages (organization_id, ${coluna}, sender_user_id, sender_name, body, mentions)`
          : `insert into public.conversation_notes (organization_id, ${coluna}, body, mentions)`;
      const valores = (m: string) =>
        tabela === "team_messages"
          ? `values ('${org(2)}', '${alvo}', '${ANA}', 'Ana', 'oi', '${m}'::jsonb)`
          : `values ('${org(2)}', '${alvo}', 'oi', '${m}'::jsonb)`;

      // lista vazia e lista com um item: aceitas
      sql(`${base} ${valores("[]")};`);
      sql(`${base} ${valores('[{"tipo":"todos"}]')};`);
      // objeto no lugar de lista: recusado
      expect(() => sql(`${base} ${valores('{"tipo":"todos"}')};`)).toThrow(/check constraint/);
      // 21 itens: recusado
      const vinteEUm = JSON.stringify(Array.from({ length: 21 }, () => ({ tipo: "todos" })));
      expect(() => sql(`${base} ${valores(vinteEUm)};`)).toThrow(/check constraint/);
      // 20 itens: aceito
      sql(`${base} ${valores(JSON.stringify(Array.from({ length: 20 }, () => ({ tipo: "todos" }))))};`);
    }
  });
});
