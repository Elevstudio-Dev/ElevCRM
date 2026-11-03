/**
 * O ASSUNTO DE UM GRUPO, pedido ao canal — o que o batismo automático (`nome-do-grupo.ts`) usa.
 *
 * `null` e erro são desfechos DIFERENTES e a diferença é medida aqui: "perguntei e não há nome" espera
 * dez minutos; "não deu para perguntar" também, mas quem mede quer saber qual dos dois aconteceu.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { WahaClient } from "@/lib/waha/client";

const fetchOriginal = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = fetchOriginal;
});

function responde(corpo: unknown, status = 200) {
  const chamadas: string[] = [];
  globalThis.fetch = vi.fn(async (url: unknown) => {
    chamadas.push(String(url));
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => corpo,
      text: async () => JSON.stringify(corpo),
    };
  }) as unknown as typeof fetch;
  return chamadas;
}

const cliente = () => new WahaClient("http://w", "k");
const GRUPO = "120363000000000001@g.us";

describe("getGroupSubject", () => {
  it("lê o `subject` e pede o grupo pelo id, com o @ escapado", async () => {
    const chamadas = responde({ id: GRUPO, subject: "  Time comercial " });
    expect(await cliente().getGroupSubject("s1", GRUPO)).toBe("Time comercial");
    expect(chamadas).toEqual([`http://w/api/s1/groups/${encodeURIComponent(GRUPO)}`]);
  });

  it("cai para `name` quando o engine não manda `subject`", async () => {
    responde({ id: GRUPO, name: "Fotos tecno" });
    expect(await cliente().getGroupSubject("s1", GRUPO)).toBe("Fotos tecno");
  });

  it("grupo sem assunto: null — não é erro", async () => {
    responde({ id: GRUPO, subject: "   " });
    expect(await cliente().getGroupSubject("s1", GRUPO)).toBeNull();
    responde({ id: GRUPO });
    expect(await cliente().getGroupSubject("s1", GRUPO)).toBeNull();
  });

  it("corpo que não é objeto: null", async () => {
    responde("não sou json de grupo");
    expect(await cliente().getGroupSubject("s1", GRUPO)).toBeNull();
  });

  it("erro de transporte LANÇA — 'não deu para perguntar' não é 'não há nome'", async () => {
    responde({ message: "rate-overlimit" }, 429);
    await expect(cliente().getGroupSubject("s1", GRUPO)).rejects.toThrow(/waha_429/);
  });
});
