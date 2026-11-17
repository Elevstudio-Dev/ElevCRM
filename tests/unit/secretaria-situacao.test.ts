import { describe, expect, it } from "vitest";

import { lerSituacaoDaSecretaria } from "@/lib/agenda/secretaria/situacao";

/**
 * A situação que a tela mostra: a configuração (com os padrões quando nada foi salvo) e QUEM é a secretaria, com a
 * pergunta "a IA consegue falar com ela?" (ela já tem uma conversa individual com o número?).
 */
function clienteFalso(resp: { settings?: unknown; contatos?: unknown[]; conversas?: unknown[]; erro?: string }) {
  const filtros: Record<string, Array<[string, unknown]>> = {};
  const from = (tabela: string) => {
    const f: Array<[string, unknown]> = (filtros[tabela] = []);
    const dados =
      tabela === "organizations" ? { settings: resp.settings } : tabela === "contacts" ? resp.contatos : resp.conversas;
    const cadeia: Record<string, unknown> = {};
    for (const m of ["select", "eq", "in", "limit"]) {
      cadeia[m] = (...a: unknown[]) => (m === "eq" || m === "in" ? (f.push([a[0] as string, a[1]]), cadeia) : cadeia);
    }
    cadeia.maybeSingle = async () => ({ data: dados ?? null, error: resp.erro ? { message: resp.erro } : null });
    cadeia.then = (ok: (v: unknown) => unknown) =>
      Promise.resolve({ data: dados ?? [], error: resp.erro ? { message: resp.erro } : null }).then(ok);
    return cadeia;
  };
  return { cliente: { from } as never, filtros };
}

describe("lerSituacaoDaSecretaria", () => {
  it("sem nada salvo: o padrão (desligada, 08:30/14:00/18:15, seg–sex, 30 min) e nenhuma secretaria", async () => {
    const { cliente } = clienteFalso({ settings: {}, contatos: [] });
    const s = await lerSituacaoDaSecretaria(cliente, "org-1");
    expect(s.config).toEqual({
      ativa: false,
      dono_da_agenda_user_id: null,
      duracao_min: 30,
      perguntas: ["08:30", "14:00", "18:15"],
      dias: [1, 2, 3, 4, 5],
    });
    expect(s.secretarias).toEqual([]);
  });

  it("lê o que está salvo", async () => {
    const { cliente } = clienteFalso({ settings: { secretaria: { ativa: true, perguntas: ["09:00"], dias: [1, 2] } }, contatos: [] });
    const s = await lerSituacaoDaSecretaria(cliente, "org-1");
    expect(s.config).toMatchObject({ ativa: true, perguntas: ["09:00"], dias: [1, 2] });
  });

  it("diz quais secretarias já têm conversa com o número e quais não", async () => {
    const { cliente } = clienteFalso({
      settings: {},
      contatos: [
        { id: "c1", display_name: "Ana" },
        { id: "c2", display_name: "Bia" },
      ],
      conversas: [{ contact_id: "c1" }],
    });
    const s = await lerSituacaoDaSecretaria(cliente, "org-1");
    expect(s.secretarias).toEqual([
      { id: "c1", nome: "Ana", tem_conversa: true },
      { id: "c2", nome: "Bia", tem_conversa: false },
    ]);
  });

  it("só olha o papel secretaria, na organização pedida, e só conversas individuais", async () => {
    const { cliente, filtros } = clienteFalso({ settings: {}, contatos: [{ id: "c1", display_name: "Ana" }], conversas: [] });
    await lerSituacaoDaSecretaria(cliente, "org-9");
    expect(filtros.contacts).toEqual(expect.arrayContaining([["organization_id", "org-9"], ["papel_interno", "secretaria"]]));
    expect(filtros.conversations).toEqual(
      expect.arrayContaining([["organization_id", "org-9"], ["is_group", false], ["contact_id", ["c1"]]]),
    );
  });

  it("erro do banco propaga (a tela não finge que não há secretaria)", async () => {
    const { cliente } = clienteFalso({ erro: "boom" });
    await expect(lerSituacaoDaSecretaria(cliente, "org-1")).rejects.toThrow("boom");
  });
});
