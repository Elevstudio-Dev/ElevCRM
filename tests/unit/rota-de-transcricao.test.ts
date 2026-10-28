/**
 * QUEM TRANSCREVE O ÁUDIO: OPENAI SE HOUVER, SENÃO OPENROUTER, SENÃO NINGUÉM.
 *
 * O defeito que isto fecha: numa instalação que escolheu OpenRouter no
 * instalador, o áudio do cliente não era transcrito — o worker só sabia a
 * OpenAI e exigia uma chave dela à parte. Sem a chave, o agente respondia como
 * se o áudio não tivesse chegado.
 *
 * O que NÃO pode mudar é o caminho de quem já funciona: quem tem chave OpenAI
 * continua indo à OpenAI. Por isso a ordem tem teste próprio.
 */
import { describe, expect, it, vi } from "vitest";

import { escolherRotaDeTranscricao } from "@/lib/messaging/media/rota-de-transcricao";

type Chaves = { openai?: string | null; openrouter?: string | null };

function entrada(provedorDaOrg: string, chaveDaOrg: string, achaveis: Chaves = {}) {
  const buscarChave = vi.fn(async (p: "openai" | "openrouter") => achaveis[p] ?? null);
  return { e: { provedorDaOrg, chaveDoProvedorDaOrg: chaveDaOrg, buscarChave }, buscarChave };
}

describe("escolherRotaDeTranscricao", () => {
  it("org na OpenAI: usa a chave dela, sem procurar mais nada", async () => {
    const { e, buscarChave } = entrada("openai", "sk-da-org");
    expect(await escolherRotaDeTranscricao(e)).toEqual({ via: "openai", apiKey: "sk-da-org" });
    expect(buscarChave).not.toHaveBeenCalled();
  });

  it("org na Anthropic COM chave OpenAI achável: vai à OpenAI (nada mudou para quem já funcionava)", async () => {
    const { e } = entrada("anthropic", "sk-ant", { openai: "sk-openai", openrouter: "sk-or" });
    expect(await escolherRotaDeTranscricao(e)).toEqual({ via: "openai", apiKey: "sk-openai" });
  });

  it("org na OpenRouter SEM chave OpenAI: transcreve pela OpenRouter com a chave da conversa", async () => {
    const { e, buscarChave } = entrada("openrouter", "sk-or-da-org", { openai: null });
    expect(await escolherRotaDeTranscricao(e)).toEqual({
      via: "openrouter",
      apiKey: "sk-or-da-org",
    });
    // A chave da OpenRouter já está na mão: não se procura de novo.
    expect(buscarChave).toHaveBeenCalledTimes(1);
    expect(buscarChave).toHaveBeenCalledWith("openai");
  });

  it("org na OpenRouter que TAMBÉM tem chave OpenAI: a OpenAI ganha (direta, sem intermediário)", async () => {
    const { e } = entrada("openrouter", "sk-or", { openai: "sk-openai" });
    expect(await escolherRotaDeTranscricao(e)).toEqual({ via: "openai", apiKey: "sk-openai" });
  });

  it("org na Anthropic sem OpenAI mas com OpenRouter achável: usa a OpenRouter", async () => {
    const { e } = entrada("anthropic", "sk-ant", { openai: null, openrouter: "sk-or-achada" });
    expect(await escolherRotaDeTranscricao(e)).toEqual({
      via: "openrouter",
      apiKey: "sk-or-achada",
    });
  });

  it("sem chave de ninguém: null (o worker abre o aviso na Central)", async () => {
    const { e } = entrada("anthropic", "sk-ant", {});
    expect(await escolherRotaDeTranscricao(e)).toBeNull();
  });

  it("chave só de espaços não conta como chave", async () => {
    // Uma variável de ambiente mal preenchida (`OPENAI_API_KEY=" "`) mandaria
    // `Bearer ` para a OpenAI e voltaria 401 em toda tentativa.
    const { e } = entrada("anthropic", "sk-ant", { openai: "   ", openrouter: "" });
    expect(await escolherRotaDeTranscricao(e)).toBeNull();
  });

  it("a chave da Anthropic/Google NUNCA é enviada a quem transcreve", async () => {
    // O defeito original da VPS: chave da Anthropic enviada ao Whisper.
    for (const provedor of ["anthropic", "google"]) {
      const { e } = entrada(provedor, "sk-do-provedor-de-conversa", {});
      expect(await escolherRotaDeTranscricao(e)).toBeNull();
    }
  });
});
