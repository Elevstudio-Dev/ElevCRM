/**
 * A CAMPANHA SAI PELO NÚMERO QUE A EQUIPE ESCOLHEU — e só por um número da
 * própria organização.
 *
 * Sem o canal escolhido, o turno de follow-up manda pela conversa mais recente
 * do contato (ou pelo primeiro número WORKING). Numa campanha isso quebraria a
 * promessa da tela: a equipe escolhe o número secundário para proteger o
 * principal, e a mensagem sairia pelo principal.
 */
import { describe, expect, it } from "vitest";

import { buildCampaignOpeningMessage, resolveSendTarget } from "@/lib/agent-engine/agent/followup-turn";

const ORG = "11111111-1111-4111-8111-111111111111";
const CONTATO = "22222222-2222-4222-8222-222222222222";
const CANAL_B = "33333333-3333-4333-8333-333333333333";

interface Consulta {
  sql: string;
  params: unknown[];
}

function poolFalso(respostas: Array<{ rows: Array<Record<string, unknown>> }>) {
  const consultas: Consulta[] = [];
  return {
    consultas,
    pool: {
      async query(sql: string, params: unknown[] = []) {
        consultas.push({ sql, params });
        const r = respostas.shift();
        if (!r) throw new Error(`consulta inesperada: ${sql}`);
        return r;
      },
    } as unknown as Parameters<typeof resolveSendTarget>[0],
  };
}

describe("resolveSendTarget com o número da campanha", () => {
  it("usa a conversa do contato NAQUELE número, mesmo havendo outra mais recente em outro", async () => {
    const { pool, consultas } = poolFalso([{ rows: [{ id: CANAL_B }] }, { rows: [{ id: "conversa-no-b" }] }]);
    const alvo = await resolveSendTarget(pool, ORG, CONTATO, CANAL_B);
    expect(alvo).toEqual({ tenantId: ORG, leadId: CONTATO, channelSessionId: CANAL_B, conversationId: "conversa-no-b" });
    // a conferência do número é escopada na organização
    expect(consultas[0]!.params).toEqual([ORG, CANAL_B]);
    expect(consultas[0]!.sql).toContain("organization_id = $1");
    expect(consultas[1]!.params).toEqual([ORG, CONTATO, CANAL_B]);
  });

  it("abre a conversa no número escolhido quando o contato nunca falou por ele", async () => {
    const { pool, consultas } = poolFalso([{ rows: [{ id: CANAL_B }] }, { rows: [] }, { rows: [{ id: "nova" }] }]);
    const alvo = await resolveSendTarget(pool, ORG, CONTATO, CANAL_B);
    expect(alvo.conversationId).toBe("nova");
    expect(alvo.channelSessionId).toBe(CANAL_B);
    expect(consultas[2]!.sql).toContain("insert into conversations");
    expect(consultas[2]!.params).toEqual([ORG, CONTATO, CANAL_B]);
  });

  it("recusa número de outra organização ou arquivado — nunca cai para outro número", async () => {
    const { pool, consultas } = poolFalso([{ rows: [] }]);
    await expect(resolveSendTarget(pool, ORG, CONTATO, CANAL_B)).rejects.toThrow(/número escolhido/);
    expect(consultas).toHaveLength(1);
  });
});

describe("buildCampaignOpeningMessage", () => {
  it("leva o objetivo da equipe, o PARAR e não fala em retorno combinado", () => {
    const texto = buildCampaignOpeningMessage("Convidar para a revisão de limpeza", ["## Contexto", "x"]);
    expect(texto).toContain("Convidar para a revisão de limpeza");
    expect(texto).toContain("PARAR");
    expect(texto).toContain("## Contexto");
    expect(texto).not.toContain("havia combinado retornar");
  });
});
