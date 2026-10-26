import { execFileSync } from "node:child_process";

import { beforeAll, describe, expect, it } from "vitest";

/**
 * O BANCO DO LEMBRETE: REMARCAR REARMA, "ENVIADO" TEM CARIMBO, E SÓ O DEVIDO É DEVIDO.
 *
 * Migration 0217. Três promessas que o aplicativo não consegue cumprir sozinho:
 *
 * 1. **O trigger rearma.** Mudou `starts_at` ⇒ o lembrete volta a `pending` com tudo
 *    zerado e `reminder_armed_at` novo. Se cada caminho (tela, IA, Google sync) tivesse
 *    de lembrar de zerar, o primeiro a esquecer faria o paciente remarcado nunca ser
 *    avisado do horário novo — ou ser avisado duas vezes.
 *    E o inverso, que é o que impede o trigger de virar ruído: regravar o MESMO horário
 *    (o sync do Google faz isso o tempo todo) ou mudar outro campo NÃO rearma.
 * 2. **"Enviado" e "tem carimbo" são o mesmo fato.** A constraint
 *    `calendar_appointments_lembrete_coerente` recusa um sem o outro.
 * 3. **`fn_lembretes_devidos` devolve só o devido.** Cada exclusão tem o seu caso, e o
 *    controle positivo está no começo: sem ele, uma função que devolvesse sempre vazio
 *    passaria em todos os "não devolve".
 *
 * Conectado como `postgres`, de propósito: o assunto aqui é o objeto do banco, não a
 * RLS (que `agenda-rls.test.ts` cobre). A função é só de `service_role`, e os grants
 * são medidos à parte.
 */

const container = process.env.TEST_DB_CONTAINER;
if (!container) {
  throw new Error(
    "TEST_DB_CONTAINER not set — rode esta suíte via `pnpm test:db` (scripts/test-db.sh)",
  );
}
const containerName: string = container;

function sql(script: string): string {
  return execFileSync(
    "docker",
    ["exec", "-i", containerName, "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-tA", "-f", "-"],
    { input: script, encoding: "utf8" },
  ).trim();
}

/** Tenta rodar o SQL; devolve se o banco aceitou. */
function aceita(script: string): boolean {
  try {
    sql(script);
    return true;
  } catch {
    return false;
  }
}

const ORG_A = "1e3b0000-0000-4000-8000-00000000000a";
const ORG_B = "1e3b0000-0000-4000-8000-00000000000b";
const CONTATO_A = "1e3b0000-3333-4000-8000-00000000000a";
const CONTATO_B = "1e3b0000-3333-4000-8000-00000000000b";
const TIPO_LIGADO = "1e3b0000-4444-4000-8000-000000000001";
const TIPO_DESLIGADO = "1e3b0000-4444-4000-8000-000000000002";
const TIPO_DA_ORG_B = "1e3b0000-4444-4000-8000-000000000003";
const SESSAO_A = "1e3b0000-6666-4000-8000-000000000001";
const CONVERSA_A = "1e3b0000-7777-4000-8000-000000000001";

/** Um instante relativo a agora, para os casos não dependerem do dia em que rodam. */
const daquiA = (horas: number) => `now() + interval '${horas} hours'`;

let contador = 0;
/** Cria um compromisso e devolve o id. `campos` sobrescreve os padrões. */
function compromisso(campos: {
  org?: string;
  tipo?: string | null;
  contato?: string | null;
  inicioEmHoras: number;
  status?: string;
  estado?: string;
}): string {
  contador += 1;
  const id = `1e3b0000-5555-4000-8000-${String(contador).padStart(12, "0")}`;
  const org = campos.org ?? ORG_A;
  const tipo = campos.tipo === undefined ? TIPO_LIGADO : campos.tipo;
  const contato = campos.contato === undefined ? CONTATO_A : campos.contato;
  sql(`
    insert into public.calendar_appointments
      (id, organization_id, event_type_id, contact_id, title, starts_at, ends_at, status, reminder_armed_at)
    values
      ('${id}', '${org}', ${tipo ? `'${tipo}'` : "null"}, ${contato ? `'${contato}'` : "null"},
       'compromisso do invariante', ${daquiA(campos.inicioEmHoras)},
       ${daquiA(campos.inicioEmHoras)} + interval '30 minutes', '${campos.status ?? "confirmed"}',
       now() - interval '30 days');
  `);
  if (campos.estado && campos.estado !== "pending") {
    // `sent` exige carimbo (constraint de coerência), então passa pelos dois campos.
    sql(
      campos.estado === "sent"
        ? `update public.calendar_appointments set reminder_state = 'sent', reminder_sent_at = now() where id = '${id}';`
        : `update public.calendar_appointments set reminder_state = '${campos.estado}' where id = '${id}';`,
    );
  }
  return id;
}

let mensagens = 0;
/** Semeia um canal, uma conversa e UMA mensagem da organização A; devolve o id da mensagem. */
function semearMensagem(): string {
  mensagens += 1;
  const mensagem = `1e3b0000-8888-4000-8000-${String(mensagens).padStart(12, "0")}`;
  sql(`
    insert into public.channel_sessions (id, organization_id, waha_session_name, webhook_secret_encrypted, status)
    values ('${SESSAO_A}', '${ORG_A}', 'lembrete-inv', '\\x00', 'WORKING')
    on conflict (id) do nothing;

    insert into public.conversations (id, organization_id, contact_id, channel_session_id)
    values ('${CONVERSA_A}', '${ORG_A}', '${CONTATO_A}', '${SESSAO_A}')
    on conflict (id) do nothing;

    insert into public.messages (id, organization_id, conversation_id, contact_id, channel_session_id, direction, type, body)
    values ('${mensagem}', '${ORG_A}', '${CONVERSA_A}', '${CONTATO_A}', '${SESSAO_A}', 'outbound', 'text', 'lembrete do invariante');
  `);
  return mensagem;
}

const linha = (id: string) =>
  sql(`
    select reminder_state || '|' || coalesce(reminder_detail, '-') || '|' || reminder_attempts || '|' ||
           (reminder_sent_at is not null) || '|' || (reminder_message_id is not null)
      from public.calendar_appointments where id = '${id}';
  `);

const armadoEm = (id: string) =>
  sql(`select reminder_armed_at from public.calendar_appointments where id = '${id}';`);

/** Os ids que a função devolve, agora. */
const devidos = (limite = 50) =>
  sql(`select appointment_id from public.fn_lembretes_devidos(now(), ${limite});`)
    .split("\n")
    .filter(Boolean);

beforeAll(() => {
  sql(`
    insert into public.organizations (id, slug, legal_name, display_name) values
      ('${ORG_A}', 'lembrete-inv-a', 'Lembrete Invariant A', 'Lembrete A'),
      ('${ORG_B}', 'lembrete-inv-b', 'Lembrete Invariant B', 'Lembrete B')
      on conflict (id) do nothing;

    insert into public.contacts (id, organization_id) values
      ('${CONTATO_A}', '${ORG_A}'),
      ('${CONTATO_B}', '${ORG_B}')
      on conflict (id) do nothing;

    -- Lembrete de 24 h ligado, lembrete desligado (o padrão da 0194), e um tipo da outra org.
    insert into public.calendar_event_types
      (id, organization_id, name, slug, reminder_enabled, reminder_minutes_before) values
      ('${TIPO_LIGADO}',    '${ORG_A}', 'Com lembrete',  'com-lembrete-inv',  true,  1440),
      ('${TIPO_DESLIGADO}', '${ORG_A}', 'Sem lembrete',  'sem-lembrete-inv',  false, 1440),
      ('${TIPO_DA_ORG_B}',  '${ORG_B}', 'Org B',         'org-b-lembrete-inv', true,  1440)
      on conflict (id) do nothing;
  `);
});

describe("o estado nasce pending, armado, sem carimbo", () => {
  it("um compromisso novo começa em pending/sem detalhe/0 tentativas/sem carimbo", () => {
    const id = compromisso({ inicioEmHoras: 30 });
    expect(linha(id)).toBe("pending|-|0|false|false");
  });

  it("o vocabulário do estado é fechado: valor fora dele é recusado", () => {
    const id = compromisso({ inicioEmHoras: 30 });
    expect(aceita(`update public.calendar_appointments set reminder_state = 'quase' where id = '${id}';`)).toBe(false);
  });
});

describe("a coerência entre 'enviado' e o carimbo", () => {
  it("enviado COM carimbo entra (controle positivo)", () => {
    const id = compromisso({ inicioEmHoras: 30 });
    expect(
      aceita(
        `update public.calendar_appointments set reminder_state = 'sent', reminder_sent_at = now() where id = '${id}';`,
      ),
    ).toBe(true);
  });

  it("enviado SEM carimbo é recusado", () => {
    const id = compromisso({ inicioEmHoras: 30 });
    expect(aceita(`update public.calendar_appointments set reminder_state = 'sent' where id = '${id}';`)).toBe(false);
  });

  it("carimbo SEM enviado é recusado — não existe 'enviou mas está pendente'", () => {
    const id = compromisso({ inicioEmHoras: 30 });
    expect(aceita(`update public.calendar_appointments set reminder_sent_at = now() where id = '${id}';`)).toBe(false);
  });
});

describe("remarcar rearma o lembrete", () => {
  const enviado = () => compromisso({ inicioEmHoras: 30, estado: "sent" });

  it("mudar starts_at volta tudo ao começo e renova o momento em que foi armado", () => {
    const id = enviado();
    sql(`
      update public.calendar_appointments
         set reminder_detail = 'send_failed:131047', reminder_attempts = 2,
             reminder_message_id = null
       where id = '${id}';
    `);
    const antes = armadoEm(id);
    expect(linha(id)).toBe("sent|send_failed:131047|2|true|false");

    sql(`update public.calendar_appointments set starts_at = starts_at + interval '2 days', ends_at = ends_at + interval '2 days' where id = '${id}';`);

    expect(linha(id)).toBe("pending|-|0|false|false");
    expect(armadoEm(id)).not.toBe(antes);
    // O novo armado é de AGORA, não do passado distante em que a linha nasceu.
    expect(
      sql(`select reminder_armed_at > now() - interval '1 minute' from public.calendar_appointments where id = '${id}';`),
    ).toBe("t");
  });

  it("desfaz a ligação com a mensagem que levou o lembrete anterior", () => {
    const id = compromisso({ inicioEmHoras: 30 });
    const mensagem = semearMensagem();
    sql(`
      update public.calendar_appointments
         set reminder_state = 'sent', reminder_sent_at = now(), reminder_message_id = '${mensagem}'
       where id = '${id}';
    `);
    expect(linha(id)).toBe("sent|-|0|true|true");

    sql(`update public.calendar_appointments set starts_at = starts_at + interval '1 day', ends_at = ends_at + interval '1 day' where id = '${id}';`);
    expect(linha(id)).toBe("pending|-|0|false|false");
  });

  it("apagar a mensagem não apaga o compromisso (on delete set null)", () => {
    const id = compromisso({ inicioEmHoras: 30 });
    const mensagem = semearMensagem();
    sql(`
      update public.calendar_appointments
         set reminder_state = 'sent', reminder_sent_at = now(), reminder_message_id = '${mensagem}'
       where id = '${id}';
      delete from public.messages where id = '${mensagem}';
    `);
    expect(linha(id)).toBe("sent|-|0|true|false");
  });

  it("regravar o MESMO horário não rearma (o sync do Google faz isso o tempo todo)", () => {
    const id = enviado();
    const antes = armadoEm(id);
    sql(`update public.calendar_appointments set starts_at = starts_at where id = '${id}';`);
    expect(linha(id)).toBe("sent|-|0|true|false");
    expect(armadoEm(id)).toBe(antes);
  });

  it("mudar outro campo (nota, status) não rearma", () => {
    const id = enviado();
    const antes = armadoEm(id);
    sql(`update public.calendar_appointments set notes = 'trazer exames', status = 'confirmed' where id = '${id}';`);
    expect(linha(id)).toBe("sent|-|0|true|false");
    expect(armadoEm(id)).toBe(antes);
  });

  it("o estado 'skipped' também volta a pending ao remarcar (descartado para o horário antigo, não para o novo)", () => {
    const id = compromisso({ inicioEmHoras: 30, estado: "skipped" });
    sql(`update public.calendar_appointments set reminder_detail = 'late' where id = '${id}';`);
    expect(linha(id)).toBe("skipped|late|0|false|false");
    sql(`update public.calendar_appointments set starts_at = starts_at + interval '1 day', ends_at = ends_at + interval '1 day' where id = '${id}';`);
    expect(linha(id)).toBe("pending|-|0|false|false");
  });
});

describe("fn_lembretes_devidos devolve só o que é devido", () => {
  it("controle positivo: compromisso confirmado, tipo ligado, dentro das 24 h e ainda no futuro", () => {
    const id = compromisso({ inicioEmHoras: 20 });
    expect(devidos()).toContain(id);
  });

  it("também devolve o 'pending' (aguardando confirmação) — o paciente precisa ser lembrado", () => {
    const id = compromisso({ inicioEmHoras: 20, status: "pending" });
    expect(devidos()).toContain(id);
  });

  it("ainda não chegou o momento (mais de 24 h para a consulta): não devolve", () => {
    const id = compromisso({ inicioEmHoras: 30 });
    expect(devidos()).not.toContain(id);
  });

  it("a borda: exatamente no momento devido devolve", () => {
    // starts_at = agora + 24 h ⇒ devido agora. Usa um instante fixo para a conta ser exata.
    const id = compromisso({ inicioEmHoras: 24 });
    const r = sql(`
      select appointment_id from public.fn_lembretes_devidos(
        (select starts_at - interval '24 hours' from public.calendar_appointments where id = '${id}'), 200);
    `);
    expect(r.split("\n")).toContain(id);
  });

  it("consulta que já começou: não devolve", () => {
    const id = compromisso({ inicioEmHoras: -1 });
    expect(devidos()).not.toContain(id);
  });

  it("tipo com lembrete DESLIGADO: não devolve (a 0194 manda desligado por padrão)", () => {
    const id = compromisso({ inicioEmHoras: 20, tipo: TIPO_DESLIGADO });
    expect(devidos()).not.toContain(id);
  });

  it("compromisso sem tipo (o tipo foi apagado): não devolve — não há configuração de lembrete", () => {
    const id = compromisso({ inicioEmHoras: 20, tipo: null });
    expect(devidos()).not.toContain(id);
  });

  it("compromisso sem contato: não devolve — não há para quem mandar", () => {
    const id = compromisso({ inicioEmHoras: 20, contato: null });
    expect(devidos()).not.toContain(id);
  });

  it.each(["cancelled", "completed", "no_show"])("situação %s: não devolve", (status) => {
    // `cancelled` exige cancelled_at (constraint própria da 0177), então o ajuste vem depois.
    const id = compromisso({ inicioEmHoras: 20 });
    sql(
      status === "cancelled"
        ? `update public.calendar_appointments set status = 'cancelled', cancelled_at = now() where id = '${id}';`
        : `update public.calendar_appointments set status = '${status}' where id = '${id}';`,
    );
    expect(devidos()).not.toContain(id);
  });

  it.each(["sent", "skipped", "failed"])("lembrete já com desfecho %s: não devolve", (estado) => {
    const id = compromisso({ inicioEmHoras: 20, estado });
    expect(devidos()).not.toContain(id);
  });

  it("o tipo é DA organização do compromisso: um tipo de outra org não liga o lembrete", () => {
    const id = compromisso({ inicioEmHoras: 20, tipo: TIPO_DA_ORG_B });
    expect(devidos()).not.toContain(id);
  });

  it("devolve também a organização, para o cron escopar cada leitura", () => {
    const id = compromisso({ inicioEmHoras: 20, org: ORG_B, tipo: TIPO_DA_ORG_B, contato: CONTATO_B });
    const r = sql(
      `select organization_id from public.fn_lembretes_devidos(now(), 200) where appointment_id = '${id}';`,
    );
    expect(r).toBe(ORG_B);
  });

  it("ordena pela consulta mais próxima e respeita o limite", () => {
    const perto = compromisso({ inicioEmHoras: 2 });
    const longe = compromisso({ inicioEmHoras: 23 });
    const lista = devidos(200);
    expect(lista.indexOf(perto)).toBeGreaterThanOrEqual(0);
    expect(lista.indexOf(perto)).toBeLessThan(lista.indexOf(longe));
    expect(devidos(1)).toHaveLength(1);
  });

  it("limite absurdo é aparado em vez de despejar a tabela inteira", () => {
    expect(devidos(0)).toHaveLength(1); // mínimo 1
    expect(sql(`select count(*) <= 200 from public.fn_lembretes_devidos(now(), 1000000);`)).toBe("t");
  });
});

describe("quem pode chamar a função", () => {
  const pode = (papel: string) =>
    sql(`select has_function_privilege('${papel}', 'public.fn_lembretes_devidos(timestamptz,integer)', 'execute');`) === "t";

  it("service_role pode (é o cron)", () => {
    expect(pode("service_role")).toBe(true);
  });

  it("anon e authenticated NÃO podem — a função devolve ids de compromissos de todas as organizações", () => {
    expect(pode("anon")).toBe(false);
    expect(pode("authenticated")).toBe(false);
  });
});

describe("o alerta aceito pela Central de avisos", () => {
  it("agent_inbox_items aceita o kind appointment_reminder_failed", () => {
    expect(
      aceita(`
        insert into public.agent_inbox_items (organization_id, kind, severity, title)
        values ('${ORG_A}', 'appointment_reminder_failed', 'warn', 'invariante do lembrete');
      `),
    ).toBe(true);
  });
});
