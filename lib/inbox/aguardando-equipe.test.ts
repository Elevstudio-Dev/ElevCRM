import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";

import { aguardandoEquipePorConversa, anexarAguardandoEquipe, fecharCasosAoResponder } from "./aguardando-equipe";

const ORG = "org-1";

interface Caso {
  id: string;
  organization_id: string;
  conversation_id: string;
  status: string;
  opened_at: string;
}

/** Supabase falso, só com o que o módulo usa: filtros eq/in, update e insert. */
function bancoFalso(casos: Caso[]) {
  const eventos: Record<string, unknown>[] = [];
  function from(tabela: string) {
    const filtros: Array<(r: Record<string, unknown>) => boolean> = [];
    let patch: Record<string, unknown> | null = null;
    const api = {
      select: () => api,
      update: (p: Record<string, unknown>) => ((patch = p), api),
      insert: async (linhas: Record<string, unknown>[]) => {
        eventos.push(...linhas);
        return { error: null };
      },
      eq: (k: string, v: unknown) => (filtros.push((r) => r[k] === v), api),
      in: (k: string, vs: unknown[]) => (filtros.push((r) => vs.includes(r[k])), api),
      then: (resolve: (v: unknown) => void) => {
        if (tabela !== "agent_cases") return resolve({ data: [], error: null });
        const alvo = casos.filter((c) => filtros.every((f) => f(c as unknown as Record<string, unknown>)));
        if (patch) for (const c of alvo) Object.assign(c, patch);
        resolve({ data: alvo.map((c) => ({ ...c })), error: null });
      },
    };
    return api;
  }
  return { db: { from } as unknown as SupabaseClient, eventos };
}

const casos = (): Caso[] => [
  { id: "c1", organization_id: ORG, conversation_id: "conv-a", status: "awaiting_human", opened_at: "2026-11-27T10:00:00Z" },
  { id: "c2", organization_id: ORG, conversation_id: "conv-a", status: "awaiting_human", opened_at: "2026-11-27T09:00:00Z" },
  { id: "c3", organization_id: ORG, conversation_id: "conv-b", status: "resolved", opened_at: "2026-11-27T08:00:00Z" },
  { id: "c4", organization_id: "outra-org", conversation_id: "conv-c", status: "awaiting_human", opened_at: "2026-11-27T08:00:00Z" },
];

describe("aguardando equipe", () => {
  it("marca só a conversa com caso esperando a equipe, desde o caso mais antigo, e só da própria org", async () => {
    const { db } = bancoFalso(casos());
    const mapa = await aguardandoEquipePorConversa(db, ORG, ["conv-a", "conv-b", "conv-c"]);
    expect([...mapa.entries()]).toEqual([["conv-a", "2026-11-27T09:00:00Z"]]);

    const lista = await anexarAguardandoEquipe(db, ORG, [{ id: "conv-a" }, { id: "conv-b" }]);
    expect(lista).toEqual([
      { id: "conv-a", aguardando_equipe_desde: "2026-11-27T09:00:00Z" },
      { id: "conv-b", aguardando_equipe_desde: null },
    ]);
  });

  it("a resposta da equipe resolve os casos da conversa e registra quem respondeu", async () => {
    const base = casos();
    const { db, eventos } = bancoFalso(base);
    expect(await fecharCasosAoResponder(db, ORG, "conv-a", "user-9")).toBe(2);
    expect(base.filter((c) => c.conversation_id === "conv-a").every((c) => c.status === "resolved")).toBe(true);
    expect(eventos).toHaveLength(4);
    expect(eventos.filter((e) => e.kind === "human_replied").every((e) => e.actor_user_id === "user-9" && e.human_action === "resolved")).toBe(true);
    // e o selo some
    expect((await aguardandoEquipePorConversa(db, ORG, ["conv-a"])).size).toBe(0);
  });

  it("conversa sem caso aberto: nada muda", async () => {
    const { db, eventos } = bancoFalso(casos());
    expect(await fecharCasosAoResponder(db, ORG, "conv-b", "user-9")).toBe(0);
    expect(eventos).toHaveLength(0);
  });
});
