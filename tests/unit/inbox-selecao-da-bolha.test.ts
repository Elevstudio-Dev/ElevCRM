/**
 * O QUE O FIO DIZ A CADA BOLHA DO MODO DE SELEÇÃO — marcada? dá para marcar? se não, por quê?
 *
 * Uma caixa cinza sem explicação parece defeito. E "dá para marcar" é a regra que impede o encaminhar
 * de pegar o que o cliente apagou, o que nunca saiu, ou mais mensagens do que o teto.
 */
import { describe, expect, it, vi } from "vitest";

import { selecaoDaBolha } from "@/components/inbox/ChatThread";
import type { Message } from "@/lib/types/messaging";

const t = (s: string) => s;
const m = (over: Partial<Message> = {}): Message =>
  ({
    id: "m1",
    type: "text",
    body: "oi",
    status: "delivered",
    revoked_at: null,
    media_storage_path: null,
    media_url: null,
    ...over,
  }) as Message;
const sel = (ids: string[] = [], maximo = 5) => ({ ids: new Set(ids), aoAlternar: vi.fn(), maximo });

describe("selecaoDaBolha", () => {
  it("mensagem comum, fora da seleção: dá para marcar", () => {
    expect(selecaoDaBolha(m(), sel(), t)).toMatchObject({ marcada: false, podeMarcar: true, motivo: undefined });
  });

  it("já marcada: vem marcada, e continua podendo ser desmarcada mesmo com o teto cheio", () => {
    const cheio = sel(["m1", "a", "b", "c", "d"], 5);
    expect(selecaoDaBolha(m(), cheio, t)).toMatchObject({ marcada: true, podeMarcar: true });
  });

  it("apagada: NÃO dá para marcar, e o motivo é o da regra", () => {
    const r = selecaoDaBolha(m({ revoked_at: "2026-10-27T13:00:00Z" }), sel(), t);
    expect(r.podeMarcar).toBe(false);
    expect(r.motivo).toBe("Mensagem apagada não pode ser encaminhada");
  });

  it("que falhou: NÃO dá para marcar", () => {
    expect(selecaoDaBolha(m({ status: "failed" }), sel(), t)).toMatchObject({ podeMarcar: false });
  });

  it("teto cheio: as outras NÃO dá para marcar, e a dica diz o limite", () => {
    const r = selecaoDaBolha(m({ id: "novo" }), sel(["a", "b", "c", "d", "e"], 5), t);
    expect(r.podeMarcar).toBe(false);
    expect(r.motivo).toBe("No máximo 5 mensagens por vez");
  });

  it("alternar chama o callback da tela com A MENSAGEM desta bolha", () => {
    const s = sel();
    const msg = m({ id: "x" });
    selecaoDaBolha(msg, s, t).aoAlternar();
    expect(s.aoAlternar).toHaveBeenCalledWith(msg);
  });
});
