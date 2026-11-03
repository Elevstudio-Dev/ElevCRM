import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { sendMessageHandler } from "@/app/api/v1/messages/_handler";
import type { HandlerCtx } from "@/lib/api/handlers/types";
import { sendMessageSchema } from "@/lib/schemas";
import type { SendMessageInput } from "@/lib/schemas";

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ storage: { from: () => ({ createSignedUrl: vi.fn() }) } }),
}));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => {}) }));

/**
 * MARCAR UM PARTICIPANTE NUM GRUPO — do handler de envio até o corpo que chega ao WAHA (falso).
 *
 * O que sai para o grupo é diferente do que a atendente escreveu: `@Maria Souza` vira `@5511999990001`
 * (é isso que o WhatsApp desenha como o nome e que faz o aparelho dela tocar) e o WAHA recebe o endereço
 * em `mentions`. A linha que o CRM guarda fica com o texto da atendente e a lista de nomes — é o que a
 * bolha mostra.
 *
 * ⚠️ O WAHA aqui é um `fetch` falso: o corpo está conforme a documentação do WAHA, mas NÃO foi provado
 * com um grupo e um aparelho de verdade.
 */

const ORG = "11111111-1111-4111-8111-111111111111";
const CONV = "22222222-2222-4222-8222-222222222222";
const CONTACT = "33333333-3333-4333-8333-333333333333";
const SESSION = "44444444-4444-4444-8444-444444444444";
const USER = "55555555-5555-4555-8555-555555555555";
const GRUPO = "120363401969475450@g.us";

type Row = Record<string, unknown>;
let ehGrupo = true;
let mensagens: Row[] = [];

function conversationRow(): Row {
  return {
    id: CONV,
    organization_id: ORG,
    contact_id: CONTACT,
    channel_session_id: SESSION,
    is_group: ehGrupo,
    group_chat_id: ehGrupo ? GRUPO : null,
    contacts: { phone_number: ehGrupo ? null : "+5531999998888", wa_identity: null, is_blocked: false },
    channel_sessions: { provider: "waha", waha_session_name: "default", status: "WORKING" },
  };
}

function makeSupabase() {
  const from = (table: string) => {
    if (table === "conversations") {
      return {
        select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: conversationRow(), error: null }) }) }),
        update: () => ({ eq: async () => ({ error: null }) }),
      };
    }
    if (table === "contacts") {
      const cadeia: Record<string, unknown> = {
        eq: () => cadeia,
        then: (r: (v: { error: null }) => unknown) => Promise.resolve({ error: null }).then(r),
      };
      return { update: () => cadeia } as never;
    }
    if (table !== "messages") throw new Error(`fake: tabela inesperada '${table}'`);
    return {
      insert: (row: Row) => {
        const nova: Row = { id: `msg-${mensagens.length + 1}`, external_id: null, ack: null, error_code: null, error_message: null, ...row };
        mensagens.push(nova);
        return { select: () => ({ single: async () => ({ data: { ...nova }, error: null }) }) };
      },
      update: (patch: Row) => {
        const filtros: Array<(r: Row) => boolean> = [];
        const q = {
          eq(col: string, val: unknown) {
            filtros.push((r) => r[col] === val);
            return q;
          },
          select: () => ({
            maybeSingle: async () => {
              const alvos = mensagens.filter((r) => filtros.every((f) => f(r)));
              alvos.forEach((r) => Object.assign(r, patch));
              return { data: alvos[0] ? { ...alvos[0] } : null, error: null };
            },
          }),
        };
        return q;
      },
      delete: () => {
        const q = {
          eq: () => q,
          neq: () => q,
          in: () => q,
          then: (r: (v: { error: null }) => unknown) => Promise.resolve({ error: null }).then(r),
        };
        return q;
      },
    };
  };
  return { from, rpc: async () => ({ error: null }) } as unknown as SupabaseClient;
}

const ctx: HandlerCtx = { organization_id: ORG, actor: { type: "user", id: USER }, requestId: "req-1" };
const MARIA = { tipo: "participante", jid: "5511999990001@c.us", nome: "Maria Souza" } as const;

function entrada(over: Record<string, unknown>): SendMessageInput {
  return sendMessageSchema.parse({ conversation_id: CONV, type: "text", ...over });
}

let corpoEnviadoAoWaha: Record<string, unknown> | null = null;
let chamouOWaha = false;

beforeEach(() => {
  ehGrupo = true;
  mensagens = [];
  corpoEnviadoAoWaha = null;
  chamouOWaha = false;
  vi.stubEnv("WAHA_API_BASE_URL", "http://localhost:3030");
  vi.stubEnv("WAHA_API_KEY", "hash123");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: unknown, init?: { body?: string }) => {
      if (String(url).endsWith("/api/sendText")) {
        chamouOWaha = true;
        corpoEnviadoAoWaha = JSON.parse(init?.body ?? "{}") as Record<string, unknown>;
      }
      return new Response(JSON.stringify({ id: { id: "3EB0ABCDEF" } }), { status: 200 });
    }),
  );
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("marcar num grupo", () => {
  it("o texto que SAI leva @<número> e o WAHA recebe o endereço; o CRM guarda o texto da atendente", async () => {
    const msg = await sendMessageHandler(makeSupabase(), ctx, entrada({ body: "oi @Maria Souza, tudo bem?", mentions: [MARIA] }));

    expect(corpoEnviadoAoWaha).toMatchObject({
      chatId: GRUPO,
      text: "oi @5511999990001, tudo bem?",
      mentions: ["5511999990001@c.us"],
    });
    // O que o CRM guarda e mostra:
    expect(mensagens[0]!.body).toBe("oi @Maria Souza, tudo bem?");
    expect(msg.metadata).toMatchObject({ mentions: [MARIA] });
    expect(msg.status).toBe("sent");
  });

  it("@todos: o WAHA recebe ['all'] e o texto segue como a atendente escreveu", async () => {
    await sendMessageHandler(makeSupabase(), ctx, entrada({ body: "@todos reunião às 15h", mentions: [{ tipo: "todos" }] }));
    expect(corpoEnviadoAoWaha).toMatchObject({ text: "@todos reunião às 15h", mentions: ["all"] });
    expect(mensagens[0]!.metadata).toMatchObject({ mentions: [{ tipo: "todos" }] });
  });

  it("quem teve o nome apagado do texto NÃO é marcado, e nada é guardado", async () => {
    await sendMessageHandler(makeSupabase(), ctx, entrada({ body: "mudei de ideia", mentions: [MARIA] }));
    expect(corpoEnviadoAoWaha).not.toHaveProperty("mentions");
    expect(corpoEnviadoAoWaha).toMatchObject({ text: "mudei de ideia" });
    expect(mensagens[0]!.metadata).not.toHaveProperty("mentions");
  });

  it("mensagem SEM marcação sai exatamente como sempre saiu", async () => {
    await sendMessageHandler(makeSupabase(), ctx, entrada({ body: "bom dia" }));
    expect(corpoEnviadoAoWaha).toEqual({ session: "default", chatId: GRUPO, text: "bom dia" });
  });

  it("numa conversa 1:1 a marcação é RECUSADA (422), nada é gravado e ninguém é avisado", async () => {
    ehGrupo = false;
    await expect(
      sendMessageHandler(makeSupabase(), ctx, entrada({ body: "oi @Maria Souza", mentions: [MARIA] })),
    ).rejects.toMatchObject({ status: 422 });
    expect(mensagens).toHaveLength(0);
    expect(chamouOWaha).toBe(false);
  });

  it("marcar em mensagem que não é texto é RECUSADO (422)", async () => {
    await expect(
      sendMessageHandler(
        makeSupabase(),
        ctx,
        entrada({ type: "image", body: "legenda @Maria Souza", media_url: "https://x.test/a.png", mentions: [MARIA] }),
      ),
    ).rejects.toMatchObject({ status: 422 });
    expect(mensagens).toHaveLength(0);
  });

  it("`metadata.mentions` mandado pelo cliente NÃO vale: o servidor é quem grava", async () => {
    await sendMessageHandler(
      makeSupabase(),
      ctx,
      entrada({ body: "oi", metadata: { mentions: [{ tipo: "todos" }], outra: "coisa" } }),
    );
    expect(mensagens[0]!.metadata).not.toHaveProperty("mentions");
    expect(mensagens[0]!.metadata).toMatchObject({ outra: "coisa" });
    expect(corpoEnviadoAoWaha).not.toHaveProperty("mentions");
  });
});

describe("o que o schema aceita do navegador", () => {
  it("recusa endereço que não é de participante e nome com quebra de linha", () => {
    const base = { conversation_id: CONV, type: "text", body: "oi" };
    expect(sendMessageSchema.safeParse({ ...base, mentions: [{ tipo: "participante", jid: GRUPO, nome: "X" }] }).success).toBe(false);
    expect(sendMessageSchema.safeParse({ ...base, mentions: [{ tipo: "participante", jid: MARIA.jid, nome: "a\nb" }] }).success).toBe(false);
    expect(sendMessageSchema.safeParse({ ...base, mentions: [{ tipo: "pessoa", user_id: USER }] }).success).toBe(false);
    expect(sendMessageSchema.safeParse({ ...base, mentions: [MARIA] }).success).toBe(true);
  });
});
