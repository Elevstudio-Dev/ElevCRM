/**
 * PATCH de rascunho de versão do agente: o que NÃO veio no corpo NÃO se mexe.
 *
 * O schema de criação tem  em vários campos (tool_ids = [],
 * max_steps = 10, handoff_keywords, followup, ...). No Zod 4,  NÃO
 * desliga esses defaults: um corpo só com  voltava do parse com
 * todos os defaults preenchidos, e a rota gravava tudo por cima — o agente
 * perdia as ferramentas, o follow-up e o resto sem nenhum aviso. Foi o que
 * apagou as ferramentas de agenda da Marcela durante a configuração da clínica.
 */
import { describe, expect, it } from "vitest";

import {
  interpretarPatchDeVersao,
  versionPatchSchema,
} from "@/lib/ai/agents/validation";

const PROMPT = "Você é a Marcela, atendente da clínica. Seja gentil.";

describe("interpretarPatchDeVersao", () => {
  it("corpo só com o prompt devolve SÓ o prompt (nenhum default entra)", () => {
    const r = interpretarPatchDeVersao({ system_prompt: PROMPT });
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data).toEqual({ system_prompt: PROMPT });
  });

  it("documenta o perigo: o schema parcial sozinho enche os defaults", () => {
    const cru = versionPatchSchema.parse({ system_prompt: PROMPT });
    expect(cru.tool_ids).toEqual([]);
    expect(cru.max_steps).toBe(10);
    expect(cru.followup).toEqual({ enabled: false, flow_pointer_ids: [] });
  });

  it("campo enviado de propósito vazio continua valendo (esvaziar é escolha)", () => {
    const r = interpretarPatchDeVersao({ tool_ids: [] });
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data).toEqual({ tool_ids: [] });
  });

  it("campo enviado vem com o valor enviado, o resto fica de fora", () => {
    const r = interpretarPatchDeVersao({
      max_steps: 5,
      followup: { enabled: true, flow_pointer_ids: [] },
    });
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(Object.keys(r.data).sort()).toEqual(["followup", "max_steps"]);
    expect(r.data.max_steps).toBe(5);
    expect(r.data.followup).toEqual({ enabled: true, flow_pointer_ids: [] });
  });

  it("dentro de followup enviado, o default interno continua valendo", () => {
    const r = interpretarPatchDeVersao({ followup: { enabled: true } });
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.followup).toEqual({ enabled: true, flow_pointer_ids: [] });
  });

  it("continua validando o que veio", () => {
    expect(interpretarPatchDeVersao({ max_steps: 999 }).success).toBe(false);
    expect(interpretarPatchDeVersao({ campo_inventado: 1 }).success).toBe(false);
    expect(interpretarPatchDeVersao({ tool_ids: ["nao_existe"] }).success).toBe(false);
  });

  it("corpo que não é objeto é recusado", () => {
    expect(interpretarPatchDeVersao(null).success).toBe(false);
    expect(interpretarPatchDeVersao([1]).success).toBe(false);
  });
});
