import { describe, expect, it } from "vitest";

import { assinaturaDaLista } from "@/hooks/inbox/useConversationsRealtime";

/**
 * A assinatura que o refetch de segurança compara. Ela precisa ser sensível ao que a LINHA mostra —
 * e, desde os tiques (migration 0219), isso inclui o status da última mensagem: um ack perdido pelo
 * canal tem de mudar a assinatura, senão a tela é curada pelo refetch mas a perda passa sem ser vista.
 */
function pagina(...conversas: Array<{ id: string; at: string | null; status?: string | null }>) {
  return {
    pages: [
      {
        data: conversas.map((c) => ({
          id: c.id,
          last_message_at: c.at,
          last_message_status: c.status ?? null,
        })),
      },
    ],
  } as unknown as Parameters<typeof assinaturaDaLista>[0];
}

describe("assinaturaDaLista", () => {
  it("lista ainda sem dado: assinatura estável, sem quebrar", () => {
    expect(assinaturaDaLista(undefined)).toBe(assinaturaDaLista(undefined));
    expect(assinaturaDaLista({ pages: [] })).toBe("0::");
  });

  it("o mesmo estado dá a mesma assinatura", () => {
    const a = pagina({ id: "1", at: "2026-10-28T10:00:00Z", status: "sent" });
    const b = pagina({ id: "1", at: "2026-10-28T10:00:00Z", status: "sent" });
    expect(assinaturaDaLista(a)).toBe(assinaturaDaLista(b));
  });

  it("o tique mudou (✓ → ✓✓): a assinatura muda — é o ack que o canal pode ter perdido", () => {
    const antes = pagina({ id: "1", at: "2026-10-28T10:00:00Z", status: "sent" });
    const depois = pagina({ id: "1", at: "2026-10-28T10:00:00Z", status: "delivered" });
    expect(assinaturaDaLista(depois)).not.toBe(assinaturaDaLista(antes));
  });

  it("mensagem nova (hora mais recente) e conversa nova também mudam a assinatura", () => {
    const base = pagina({ id: "1", at: "2026-10-28T10:00:00Z", status: "sent" });
    expect(
      assinaturaDaLista(pagina({ id: "1", at: "2026-10-28T10:05:00Z", status: "sent" })),
    ).not.toBe(assinaturaDaLista(base));
    expect(
      assinaturaDaLista(
        pagina(
          { id: "1", at: "2026-10-28T10:00:00Z", status: "sent" },
          { id: "2", at: "2026-10-28T09:00:00Z", status: null },
        ),
      ),
    ).not.toBe(assinaturaDaLista(base));
  });

  it("conversa sem status (antiga, sem espelho) não derruba a assinatura", () => {
    expect(() => assinaturaDaLista(pagina({ id: "1", at: null, status: null }))).not.toThrow();
  });
});
