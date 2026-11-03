import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { wahaAdapter } from "@/lib/channels/adapters/waha";
import { WahaClient } from "@/lib/waha/client";

/**
 * MARCAR EM GRUPO, contra um WAHA FALSO.
 *
 * ⚠️ O que isto prova e o que NÃO prova. Prova que o CRM manda ao WAHA exatamente o formato que a
 * documentação do WAHA descreve (`mentions` no corpo do `sendText`, `["all"]` para o grupo inteiro,
 * `participants/v2` para a lista) e que lê as respostas nas formas medidas (`{id, role}`, e o objeto do
 * grupo do NOWEB com `phoneNumber`). NÃO prova que o WhatsApp de verdade toque no aparelho de quem foi
 * marcado: isso só se vê com um WAHA real e um aparelho de cliente — e, no `@lid`, depende da versão do
 * WAHA instalada. O fake responde o que a documentação diz; se a documentação estiver errada, este teste
 * também estará.
 */

interface Chamada {
  url: string;
  metodo: string;
  corpo: Record<string, unknown> | null;
}
let chamadas: Chamada[] = [];
let respostas: Array<(url: string) => { status: number; corpo: unknown } | null> = [];
const fetchOriginal = globalThis.fetch;

function instalarWahaFalso() {
  globalThis.fetch = vi.fn(async (url: unknown, init?: { method?: string; body?: string }) => {
    const u = String(url);
    chamadas.push({
      url: u,
      metodo: init?.method ?? "GET",
      corpo: init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : null,
    });
    for (const r of respostas) {
      const res = r(u);
      if (res) {
        return {
          ok: res.status >= 200 && res.status < 300,
          status: res.status,
          json: async () => res.corpo,
          text: async () => JSON.stringify(res.corpo),
        };
      }
    }
    return { ok: true, status: 200, json: async () => ({ id: "3EB0FAKE" }), text: async () => "{}" };
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  chamadas = [];
  respostas = [];
  process.env.WAHA_API_BASE_URL = "http://waha.falso";
  process.env.WAHA_API_KEY = "chave-de-teste";
  instalarWahaFalso();
});
afterEach(() => {
  globalThis.fetch = fetchOriginal;
});

const GRUPO = "120363401969475450@g.us";
const sendText = () => chamadas.find((c) => c.url.endsWith("/api/sendText"))!;

describe("sendMessage com marcação", () => {
  it("manda `mentions` no corpo do sendText, ao lado do texto com @<número>", async () => {
    await new WahaClient("http://w", "k").sendMessage("s1", GRUPO, "oi @5511999990001", null, ["5511999990001@c.us"]);
    expect(sendText().corpo).toEqual({
      session: "s1",
      chatId: GRUPO,
      text: "oi @5511999990001",
      mentions: ["5511999990001@c.us"],
    });
  });

  it("sem marcação, o corpo é EXATAMENTE o de antes (nem `mentions` nem `reply_to`)", async () => {
    await new WahaClient("http://w", "k").sendMessage("s1", GRUPO, "bom dia");
    expect(sendText().corpo).toEqual({ session: "s1", chatId: GRUPO, text: "bom dia" });
    chamadas = [];
    await new WahaClient("http://w", "k").sendMessage("s1", GRUPO, "bom dia", null, []);
    expect(sendText().corpo).not.toHaveProperty("mentions");
  });

  it("a citação e a marcação convivem", async () => {
    await new WahaClient("http://w", "k").sendMessage("s1", GRUPO, "@5511999990001 sim", "true_x_ABC", ["5511999990001@c.us"]);
    expect(sendText().corpo).toMatchObject({ reply_to: "true_x_ABC", mentions: ["5511999990001@c.us"] });
  });
});

describe("adapter.send — o envelope vira o corpo do WAHA", () => {
  const base = { organizationId: "org", sessionRef: "s1", to: GRUPO, kind: "text" as const };

  it("mentions do envelope → lista de endereços", async () => {
    await wahaAdapter.send({
      ...base,
      body: "@5511999990001 e @117137179947104",
      mentions: [{ jid: "5511999990001@c.us" }, { jid: "117137179947104@lid" }],
    });
    expect(sendText().corpo).toMatchObject({ mentions: ["5511999990001@c.us", "117137179947104@lid"] });
  });

  it("mentionAll → ['all'] e vence a lista (o WAHA não mistura)", async () => {
    await wahaAdapter.send({ ...base, body: "@todos", mentions: [{ jid: "5511999990001@c.us" }], mentionAll: true });
    expect(sendText().corpo).toMatchObject({ mentions: ["all"] });
  });

  it("sem nada marcado, o envio é idêntico ao de sempre", async () => {
    await wahaAdapter.send({ ...base, body: "oi" });
    expect(sendText().corpo).toEqual({ session: "s1", chatId: GRUPO, text: "oi" });
  });

  it("devolve o id da mensagem que o WAHA respondeu", async () => {
    const r = await wahaAdapter.send({ ...base, body: "oi", mentions: [{ jid: "5511999990001@c.us" }] });
    expect(r.externalId).toBe("3EB0FAKE");
  });
});

describe("listGroupParticipants", () => {
  const url = (sufixo: string) => `http://waha.falso/api/s1/groups/${encodeURIComponent(GRUPO)}${sufixo}`;

  it("lê participants/v2 ({ id, role }) e devolve telefone e admin", async () => {
    respostas.push((u) =>
      u === url("/participants/v2")
        ? {
            status: 200,
            corpo: [
              { id: "5511999990001@c.us", role: "participant" },
              { id: "5511999990002@c.us", role: "admin" },
              { id: "117137179947104@lid", role: "participant" },
              { id: "5511999990009@c.us", role: "left" },
            ],
          }
        : null,
    );
    const r = await wahaAdapter.listGroupParticipants!({ organizationId: "org", sessionRef: "s1", groupChatId: GRUPO });
    expect(r).toEqual([
      { jid: "5511999990001@c.us", phone: "5511999990001", admin: false },
      { jid: "5511999990002@c.us", phone: "5511999990002", admin: true },
      // @lid sem telefone: o número do @lid NÃO é telefone — null, e não um número inventado.
      { jid: "117137179947104@lid", phone: null, admin: false },
    ]);
  });

  it("versão do WAHA sem participants/v2: cai para o objeto do grupo (NOWEB, com phoneNumber)", async () => {
    respostas.push((u) => (u === url("/participants/v2") ? { status: 404, corpo: { message: "Not Found" } } : null));
    respostas.push((u) =>
      u === url("")
        ? {
            status: 200,
            corpo: {
              id: GRUPO,
              subject: "Elev Studio",
              participants: [{ id: "36438703866081@lid", phoneNumber: "550000000000@s.whatsapp.net", admin: "admin" }],
            },
          }
        : null,
    );
    const r = await wahaAdapter.listGroupParticipants!({ organizationId: "org", sessionRef: "s1", groupChatId: GRUPO });
    expect(r).toEqual([{ jid: "36438703866081@lid", phone: "550000000000", admin: true }]);
  });

  it("WAHA fora do ar nas DUAS tentativas: o erro propaga (a rota decide o que fazer)", async () => {
    respostas.push(() => ({ status: 500, corpo: { message: "boom" } }));
    await expect(
      wahaAdapter.listGroupParticipants!({ organizationId: "org", sessionRef: "s1", groupChatId: GRUPO }),
    ).rejects.toThrow(/waha_500/);
  });

  it("transporte não configurado: lista vazia, sem chamar ninguém", async () => {
    delete process.env.WAHA_API_BASE_URL;
    const r = await wahaAdapter.listGroupParticipants!({ organizationId: "org", sessionRef: "s1", groupChatId: GRUPO });
    expect(r).toEqual([]);
    expect(chamadas).toHaveLength(0);
  });
});
