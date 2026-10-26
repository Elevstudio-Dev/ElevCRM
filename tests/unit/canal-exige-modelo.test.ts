import { describe, expect, it } from "vitest";

import { algumCanalExigeModelo } from "@/lib/channels/exige-modelo";

/**
 * A tela de tipos de agendamento avisa "lembrete sem modelo aprovado" só quando algum
 * canal da organização NÃO aceita texto livre fora das 24 h. A pergunta é de capacidade;
 * o teste mora em `tests/unit/` porque precisa dizer QUE provedor está em jogo.
 */

function dbCom(linhas: Array<{ provider: string }> | null, opcoes: { erro?: boolean } = {}) {
  const filtros: Array<[string, unknown]> = [];
  const cadeia: Record<string, unknown> = {
    select: () => cadeia,
    eq: (c: string, v: unknown) => {
      filtros.push([c, v]);
      return cadeia;
    },
    is: (c: string, v: unknown) => {
      filtros.push([`is:${c}`, v]);
      return cadeia;
    },
    then: (ok: (v: unknown) => unknown) =>
      ok(opcoes.erro ? { data: null, error: { message: "boom" } } : { data: linhas, error: null }),
  };
  return { db: { from: () => cadeia } as never, filtros };
}

describe("algumCanalExigeModelo", () => {
  it("só canal que aceita texto livre fora da janela: não exige", async () => {
    const { db } = dbCom([{ provider: "waha" }]);
    expect(await algumCanalExigeModelo(db, "org-1")).toBe(false);
  });

  it("canal oficial presente: exige — mesmo ao lado de um que aceita texto livre", async () => {
    const { db } = dbCom([{ provider: "waha" }, { provider: "meta_cloud" }]);
    expect(await algumCanalExigeModelo(db, "org-1")).toBe(true);
  });

  it("o canal intermediado e o de rede social também exigem (a regra é a da matriz, não um nome)", async () => {
    expect(await algumCanalExigeModelo(dbCom([{ provider: "zernio" }]).db, "org-1")).toBe(true);
    expect(await algumCanalExigeModelo(dbCom([{ provider: "instagram" }]).db, "org-1")).toBe(true);
  });

  it("organização sem canal nenhum: não exige", async () => {
    expect(await algumCanalExigeModelo(dbCom([]).db, "org-1")).toBe(false);
    expect(await algumCanalExigeModelo(dbCom(null).db, "org-1")).toBe(false);
  });

  it("consulta SÓ a organização e ignora canal arquivado", async () => {
    const { db, filtros } = dbCom([]);
    await algumCanalExigeModelo(db, "org-1");
    expect(filtros).toContainEqual(["organization_id", "org-1"]);
    expect(filtros).toContainEqual(["is:archived_at", null]);
  });

  it("erro de leitura SOBE — devolver false esconderia o aviso quando ele mais importa", async () => {
    const { db } = dbCom(null, { erro: true });
    await expect(algumCanalExigeModelo(db, "org-1")).rejects.toThrow("channel_sessions_list_failed");
  });
});
