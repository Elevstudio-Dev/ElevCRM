import { readFileSync } from "node:fs";
import { join } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { GOV_ORG, GOV_SESSION, lastLine, seedGov, sql } from "./gov-helpers";

/**
 * Migration 0219 — A LISTA DE CONVERSAS SABE O QUE A ÚLTIMA MENSAGEM É.
 *
 * ## O que este arquivo protege
 *
 * A linha do inbox no jeito do WhatsApp diz "Você:", troca o literal `[audio]` por ícone e desenha
 * os tiques (✓ ✓✓ ✓✓ azul). Os três vêm da ÚLTIMA mensagem, e vêm de colunas desnormalizadas em
 * `conversations` — porque o Realtime da lista escuta `conversations` e não `messages`: sem a
 * conversa mudar quando o ack chega, o ✓✓ azul nunca apareceria até alguém recarregar a tela.
 *
 * O defeito silencioso é duplo, e nenhum teste de TypeScript o enxerga (mora em PL/pgSQL):
 *   · `fn_mark_conversation_message` (chamada pelos três canais de entrada) deixar de espelhar —
 *     a lista volta a mostrar `[audio]` e nunca tem tique, sem erro algum;
 *   · o trigger de status mexer na conversa ERRADA (ack de mensagem do meio da conversa) ou deixar
 *     de mexer na certa — o primeiro acorda o Realtime de todo mundo à toa, o segundo congela o tique.
 *
 * ## Por que o backfill é EXTRAÍDO do arquivo da migration
 *
 * Uma cópia digitada aqui continuaria verde com o backfill apagado da migration — o teste estaria
 * provando a si mesmo.
 */
const CONTATO_A = "dddddddd-3333-4000-8000-000000000219";
const CONVERSA_A = "dddddddd-4444-4000-8000-000000000219";
const CONTATO_B = "dddddddd-3333-4000-8000-00000000021a";
const CONVERSA_B = "dddddddd-4444-4000-8000-00000000021a";

const MIGRATION = join(
  process.cwd(),
  "supabase",
  "migrations",
  "20261028120000_0219_a_lista_sabe_o_que_a_ultima_mensagem_e.sql",
);

const BASELINE = join(process.cwd(), "supabase", "baseline.sql");

const MSG = (n: number) => `dddddddd-5555-4000-8000-0000000002${String(n).padStart(2, "0")}`;

function mensagem(args: {
  n: number;
  conversa: string;
  contato: string;
  direcao: "inbound" | "outbound";
  tipo: string;
  status: string;
  /** Segundos atrás — a ordem entre mensagens vem de `sent_at`. */
  haSegundos: number;
}): void {
  sql(`
    insert into public.messages
      (id, organization_id, conversation_id, channel_session_id, contact_id,
       type, direction, status, body, sent_at)
    values
      ('${MSG(args.n)}', '${GOV_ORG}', '${args.conversa}', '${GOV_SESSION}', '${args.contato}',
       '${args.tipo}', '${args.direcao}', '${args.status}', 'corpo ${args.n}',
       now() - interval '${args.haSegundos} seconds')
    on conflict (id) do nothing;
  `);
}

function marcar(conversa: string, direcao: "inbound" | "outbound", preview: string): void {
  sql(`select public.fn_mark_conversation_message(
         '${conversa}'::uuid, '${direcao}', '${preview}', now());`);
}

/** `id|direcao|tipo|status` da conversa, em uma linha — `(null)` onde a coluna é nula. */
function espelho(conversa: string): string {
  return lastLine(
    sql(`select concat_ws('|',
           coalesce(last_message_id::text, '(null)'),
           coalesce(last_message_direction, '(null)'),
           coalesce(last_message_type, '(null)'),
           coalesce(last_message_status, '(null)'))
         from public.conversations where id = '${conversa}';`),
  );
}

function atualizadaEm(conversa: string): string {
  return lastLine(sql(`select updated_at::text from public.conversations where id = '${conversa}';`));
}

function mudarStatus(n: number, status: string): void {
  sql(`update public.messages set status = '${status}' where id = '${MSG(n)}';`);
}

beforeAll(() => {
  seedGov();
  sql(`
    insert into public.contacts (id, organization_id, display_name) values
      ('${CONTATO_A}', '${GOV_ORG}', 'Contato do espelho'),
      ('${CONTATO_B}', '${GOV_ORG}', 'Contato do backfill')
      on conflict do nothing;
    insert into public.conversations (id, organization_id, contact_id, channel_session_id, status) values
      ('${CONVERSA_A}', '${GOV_ORG}', '${CONTATO_A}', '${GOV_SESSION}', 'open'),
      ('${CONVERSA_B}', '${GOV_ORG}', '${CONTATO_B}', '${GOV_SESSION}', 'open')
      on conflict do nothing;
  `);
});

describe("0219 — o espelho da última mensagem na conversa", () => {
  it("as quatro colunas existem, anuláveis (conversa sem mensagem não tem o que espelhar)", () => {
    const linhas = sql(`
      select column_name || ':' || is_nullable from information_schema.columns
       where table_schema = 'public' and table_name = 'conversations'
         and column_name in ('last_message_id', 'last_message_direction',
                             'last_message_type', 'last_message_status')
       order by column_name;`).split("\n");
    expect(linhas).toEqual([
      "last_message_direction:YES",
      "last_message_id:YES",
      "last_message_status:YES",
      "last_message_type:YES",
    ]);
  });

  it("conversa sem mensagem começa sem espelho (controle)", () => {
    expect(espelho(CONVERSA_A)).toBe("(null)|(null)|(null)|(null)");
  });

  it("o carimbo do canal espelha a mensagem que acabou de entrar", () => {
    mensagem({ n: 1, conversa: CONVERSA_A, contato: CONTATO_A, direcao: "outbound", tipo: "audio", status: "sent", haSegundos: 30 });
    marcar(CONVERSA_A, "outbound", "[audio]");
    expect(espelho(CONVERSA_A)).toBe(`${MSG(1)}|outbound|audio|sent`);
  });

  it("o carimbo pega a mais recente DAQUELA direção — a do cliente não toma a vez da nossa", () => {
    // Já existe a nossa (n=1, há 30s). Entra uma do cliente (n=2, há 20s): o carimbo inbound espelha
    // a n=2. Depois entra outra nossa (n=3, há 10s): o carimbo outbound espelha a n=3, e não a n=1.
    mensagem({ n: 2, conversa: CONVERSA_A, contato: CONTATO_A, direcao: "inbound", tipo: "text", status: "delivered", haSegundos: 20 });
    marcar(CONVERSA_A, "inbound", "oi");
    expect(espelho(CONVERSA_A)).toBe(`${MSG(2)}|inbound|text|delivered`);

    mensagem({ n: 3, conversa: CONVERSA_A, contato: CONTATO_A, direcao: "outbound", tipo: "image", status: "queued", haSegundos: 10 });
    marcar(CONVERSA_A, "outbound", "[image]");
    expect(espelho(CONVERSA_A)).toBe(`${MSG(3)}|outbound|image|queued`);
  });

  it("carimbo da nossa mensagem com uma do cliente MAIS NOVA na conversa: espelha a nossa, não a do cliente", () => {
    // O caso em que "a mais recente da conversa" e "a mais recente DAQUELA direção" divergem — o eco de
    // uma resposta dada pelo celular que chega depois de o cliente já ter escrito de novo. Sem o
    // filtro de direção, a conversa ficaria com direção `outbound` apontando para a mensagem do
    // cliente: "Você:" e tique desenhados sobre o texto de outra pessoa.
    mensagem({ n: 4, conversa: CONVERSA_A, contato: CONTATO_A, direcao: "inbound", tipo: "text", status: "delivered", haSegundos: 1 });
    marcar(CONVERSA_A, "outbound", "[image]");
    expect(espelho(CONVERSA_A)).toBe(`${MSG(3)}|outbound|image|queued`);
  });
});

describe("0219 — o ack do WhatsApp chega na linha da lista", () => {
  it("o status da ÚLTIMA mensagem muda → a conversa acompanha (enviada → entregue → lida)", () => {
    mudarStatus(3, "sent");
    expect(espelho(CONVERSA_A)).toBe(`${MSG(3)}|outbound|image|sent`);
    mudarStatus(3, "delivered");
    expect(espelho(CONVERSA_A)).toBe(`${MSG(3)}|outbound|image|delivered`);
    mudarStatus(3, "read");
    expect(espelho(CONVERSA_A)).toBe(`${MSG(3)}|outbound|image|read`);
  });

  it("…e a conversa É tocada (updated_at) — é isso que acorda o Realtime da lista", () => {
    const antes = atualizadaEm(CONVERSA_A);
    sql(`select pg_sleep(0.05);`);
    mudarStatus(3, "failed");
    expect(atualizadaEm(CONVERSA_A)).not.toBe(antes);
    expect(espelho(CONVERSA_A)).toBe(`${MSG(3)}|outbound|image|failed`);
  });

  it("ack de mensagem do MEIO da conversa não mexe na conversa", () => {
    // n=1 (nossa, antiga) não é a última. Se este caso ficasse vermelho, cada tique de uma
    // mensagem velha acordaria o Realtime de todos os atendentes à toa.
    const antes = atualizadaEm(CONVERSA_A);
    const espelhoAntes = espelho(CONVERSA_A);
    sql(`select pg_sleep(0.05);`);
    mudarStatus(1, "read");
    expect(atualizadaEm(CONVERSA_A)).toBe(antes);
    expect(espelho(CONVERSA_A)).toBe(espelhoAntes);
  });

  it("gravar o MESMO status de novo não toca a conversa", () => {
    const antes = atualizadaEm(CONVERSA_A);
    sql(`select pg_sleep(0.05);`);
    mudarStatus(3, "failed");
    expect(atualizadaEm(CONVERSA_A)).toBe(antes);
  });

  it("o ack de uma conversa não vaza para a outra", () => {
    expect(espelho(CONVERSA_B)).toBe("(null)|(null)|(null)|(null)");
  });
});

// O backfill existe em DOIS arquivos: na migration (que o Supabase CLI aplica) e no apêndice do
// baseline (que o `update.sh` reaplica). O baseline roda contra tabelas vazias no teste de
// instalação, então só EXECUTÁ-LO aqui prova que ele faz o que a migration faz — a igualdade textual
// dos dois está em `tests/unit/inbox-lista-espelho-costura.test.ts`, e esta é a metade que a mede
// rodando.
describe.each([
  ["a migration", MIGRATION],
  ["o apêndice do baseline", BASELINE],
] as const)("0219 — o backfill de %s", (_nome, arquivo) => {
  function backfillDaMigration(): string {
    const texto = readFileSync(arquivo, "utf8");
    // O UPDATE do backfill — extraído, não copiado. Ancorado no `set (` com a lista das quatro
    // colunas: o corpo do trigger também tem um `update public.conversations c`, e casar só pelo
    // começo pegaria o errado (foi o que a primeira versão deste teste fez).
    const m =
      /update public\.conversations c\s+set \(last_message_id[\s\S]*?last_message_at is not null;/.exec(
        texto,
      );
    if (m === null) throw new Error(`backfill não encontrado em ${arquivo}`);
    return m[0];
  }

  it("preenche a conversa com histórico que ainda não tem espelho, pela mensagem mais nova", () => {
    mensagem({ n: 10, conversa: CONVERSA_B, contato: CONTATO_B, direcao: "inbound", tipo: "text", status: "delivered", haSegundos: 50 });
    mensagem({ n: 11, conversa: CONVERSA_B, contato: CONTATO_B, direcao: "outbound", tipo: "audio", status: "read", haSegundos: 5 });
    // Conversa de instalação antiga: tem `last_message_at`, não tem espelho. (Zera o espelho porque
    // este bloco roda uma vez por arquivo — migration e baseline — sobre a mesma conversa.)
    sql(`update public.conversations
            set last_message_at = now(), last_message_id = null, last_message_direction = null,
                last_message_type = null, last_message_status = null
          where id = '${CONVERSA_B}';`);
    expect(espelho(CONVERSA_B)).toBe("(null)|(null)|(null)|(null)");

    sql(backfillDaMigration());
    expect(espelho(CONVERSA_B)).toBe(`${MSG(11)}|outbound|audio|read`);
  });

  it("é idempotente: reaplicar não desfaz nem refaz o que já está preenchido", () => {
    // O `update.sh` reaplica o baseline a cada atualização.
    sql(`update public.conversations set last_message_status = 'delivered' where id = '${CONVERSA_B}';`);
    sql(backfillDaMigration());
    expect(espelho(CONVERSA_B)).toBe(`${MSG(11)}|outbound|audio|delivered`);
  });

  it("conversa sem nenhuma mensagem fica sem espelho (e sem erro)", () => {
    const vazia = "dddddddd-4444-4000-8000-00000000021b";
    sql(`
      insert into public.contacts (id, organization_id, display_name)
        values ('dddddddd-3333-4000-8000-00000000021b', '${GOV_ORG}', 'Contato vazio')
        on conflict do nothing;
      insert into public.conversations (id, organization_id, contact_id, channel_session_id, status, last_message_at)
        values ('${vazia}', '${GOV_ORG}', 'dddddddd-3333-4000-8000-00000000021b', '${GOV_SESSION}', 'open', now())
        on conflict do nothing;
    `);
    sql(backfillDaMigration());
    expect(espelho(vazia)).toBe("(null)|(null)|(null)|(null)");
  });
});

describe("0219 — quem pode chamar", () => {
  const privilegio = (papel: string, assinatura: string) =>
    sql(`select has_function_privilege('${papel}', '${assinatura}', 'EXECUTE');`) === "t";

  it("fn_mark_conversation_message: só a ingestão (service_role) executa", () => {
    const f = "public.fn_mark_conversation_message(uuid, text, text, timestamptz)";
    expect(privilegio("service_role", f)).toBe(true);
    expect(privilegio("anon", f)).toBe(false);
    expect(privilegio("authenticated", f)).toBe(false);
  });

  it("a função do trigger de status não é chamável por anon nem authenticated", () => {
    const f = "public.fn_conversa_espelha_status_da_ultima_mensagem()";
    expect(privilegio("anon", f)).toBe(false);
    expect(privilegio("authenticated", f)).toBe(false);
  });

  it("o trigger existe na tabela de mensagens, e só dispara quando o status MUDA", () => {
    const def = sql(`
      select pg_get_triggerdef(oid) from pg_trigger
       where tgname = 'trg_messages_espelham_status_na_conversa' and not tgisinternal;`);
    expect(def).toMatch(/AFTER UPDATE OF status ON public\.messages/);
    expect(def).toMatch(/WHEN \(\(old\.status IS DISTINCT FROM new\.status\)\)/i);
  });
});
