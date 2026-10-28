import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const downloadMock = vi.fn();
const updateEqMock = vi.fn();
const messageRow = {
  id: "msg1",
  organization_id: "org1",
  type: "audio" as string,
  media_mime: "audio/ogg",
  media_storage_path: "org1/conv1/msg1.ogg",
  media_derived_status: null as string | null,
};

/**
 * O dublê PRECISA saber em que tabela está.
 *
 * A versão anterior devolvia `messageRow` para qualquer `from(...)` e encadeava
 * exatamente dois `.eq`. Isso a tornava frágil nos dois eixos: o worker passou a
 * consultar `ai_purpose_bindings` (com três filtros) e o stub quebrava no
 * terceiro `.eq` — falha que aparece como "status error" e aponta para o lugar
 * errado. O Proxy devolve o chain para qualquer filtro, e a linha vem por
 * tabela: mensagem para `messages`, NENHUM binding para `ai_purpose_bindings`
 * (o caso "ninguém configurou nada", que é o comportamento anterior que estes
 * casos existem para preservar).
 */
const bindingDeVisao: { provider: string; model_id: string; credential_id: string | null } | null = null;

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (tabela: string) => {
      const linha = tabela === "ai_purpose_bindings" ? bindingDeVisao : messageRow;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const terminais: any = {
        maybeSingle: async () => ({ data: linha, error: null }),
        single: async () => ({ data: linha, error: null }),
        update: (patch: Record<string, unknown>) => {
          updateEqMock(patch);
          return { eq: () => ({ eq: async () => ({ error: null }) }) };
        },
        then: (resolve: (v: unknown) => unknown) =>
          Promise.resolve({ data: linha ? [linha] : [], error: null }).then(resolve),
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const chain: any = new Proxy(terminais, {
        get: (alvo, prop) =>
          prop in alvo ? alvo[prop as keyof typeof alvo] : () => chain,
      });
      return chain;
    },
    storage: { from: () => ({ download: downloadMock }) },
  }),
}));

vi.mock("@/lib/messaging/media/derive", () => ({
  deriveMediaText: vi.fn(async () => "transcrição do áudio real"),
}));

// resolveOrgLlmConfig e generateText mockados: o worker precisa de credencial p/
// montar as deps, mas o teste não exercita rede.
vi.mock("@/lib/agent-engine/edge/llm/credentials", () => ({
  resolveOrgLlmConfig: vi.fn(async () => ({
    provider: "openai",
    apiKey: "sk-test",
    defaultModel: "gpt-5",
    params: {},
    enabledModels: [],
    orcamento: { modo: "off", tetoCents: 0, efetivoEm: null, limiarPct: 80 },
    orcamentoIndisponivelPorque: null,
  })),
}));

import { resolveOrgLlmConfig } from "@/lib/agent-engine/edge/llm/credentials";
import { deriveMessageMedia, MARCADOR_NAO_LIDA } from "@/workers/media-derive-worker";
import { deriveMediaText, type DeriveDeps } from "@/lib/messaging/media/derive";

/** A config que o resolvedor devolve para uma organização, no formato real. */
function cfgDe(provider: string, apiKey: string) {
  return {
    provider,
    apiKey,
    defaultModel: "modelo-qualquer",
    params: {},
    enabledModels: [],
    orcamento: { modo: "off" as const, tetoCents: 0, efetivoEm: null, limiarPct: 80 },
    orcamentoIndisponivelPorque: null,
  };
}

const configPadraoDaOrg = async () => cfgDe("openai", "sk-test");

function eventRow(attempts = 0) {
  return {
    id: "ev1",
    organization_id: "org1",
    event_type: "media.derive_requested",
    entity_kind: "message",
    entity_id: "msg1",
    payload: { message_id: "msg1" },
    metadata: {},
    consumed_by: [],
    attempts,
  };
}

function reiniciarCenario() {
  downloadMock.mockReset().mockResolvedValue({ data: new Blob([new Uint8Array([1, 2, 3])]), error: null });
  updateEqMock.mockReset();
  messageRow.media_derived_status = null;
  messageRow.type = "audio";
  vi.mocked(deriveMediaText).mockReset().mockResolvedValue("transcrição do áudio real");
  vi.mocked(resolveOrgLlmConfig).mockReset().mockImplementation(configPadraoDaOrg);
}

describe("deriveMessageMedia", () => {
  beforeEach(reiniciarCenario);

  it("baixa a mídia, deriva e grava ready", async () => {
    const r = await deriveMessageMedia(eventRow());
    expect(r.status).toBe("ok");
    expect(updateEqMock).toHaveBeenCalledWith(
      expect.objectContaining({ media_derived_text: "transcrição do áudio real", media_derived_status: "ready" }),
    );
  });

  it("pula se já derivado (idempotência)", async () => {
    messageRow.media_derived_status = "ready";
    const r = await deriveMessageMedia(eventRow());
    expect(r.status).toBe("skipped");
    expect(deriveMediaText).not.toHaveBeenCalled();
  });

  it("tipo sem derivado (sticker) → skipped sem baixar", async () => {
    messageRow.type = "sticker";
    const r = await deriveMessageMedia(eventRow());
    expect(r.status).toBe("skipped");
    expect(downloadMock).not.toHaveBeenCalled();
  });

  it("erro na derivação marca failed no último attempt", async () => {
    vi.mocked(deriveMediaText).mockRejectedValue(new Error("transcription_503"));
    const r = await deriveMessageMedia(eventRow(4));
    expect(r.status).toBe("error");
    expect(updateEqMock).toHaveBeenCalledWith(
      expect.objectContaining({ media_derived_status: "failed" }),
    );
  });
});

describe("por onde o áudio é transcrito (rota escolhida pelo worker)", () => {
  /**
   * Pega o transcritor que o worker montou e o usa de verdade, com o `fetch`
   * global trocado por um espião — assim o teste enxerga ONDE o áudio iria
   * parar e COM QUAL chave, que é o que importa aqui.
   */
  async function transcreverComOWorker(
    chaves: Record<string, string | null>,
    provedorDaOrg: string,
  ) {
    const fetchEspiao = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ text: "texto do áudio" }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchEspiao);
    vi.mocked(resolveOrgLlmConfig).mockImplementation(async (_pool, _cfg, _org, override) => {
      const alvo = override?.provider ?? provedorDaOrg;
      const chave = alvo === provedorDaOrg ? "chave-do-provedor-da-org" : chaves[alvo];
      if (!chave) throw new Error("llm_not_configured");
      return cfgDe(alvo, chave);
    });

    const r = await deriveMessageMedia(eventRow());
    expect(r.status).toBe("ok");
    const deps = vi.mocked(deriveMediaText).mock.calls[0]![3] as DeriveDeps;
    const texto = await deps.transcriber.transcribe(Buffer.from([1, 2, 3]), "audio/ogg");
    return { texto, fetchEspiao };
  }

  beforeEach(reiniciarCenario);
  afterEach(() => vi.unstubAllGlobals());

  it("org na OpenRouter sem chave OpenAI: o áudio vai à OpenRouter, com a chave da OpenRouter", async () => {
    const { texto, fetchEspiao } = await transcreverComOWorker({ openai: null }, "openrouter");
    expect(texto).toBe("texto do áudio");
    const [url, init] = fetchEspiao.mock.calls[0]!;
    expect(String(url)).toBe("https://openrouter.ai/api/v1/audio/transcriptions");
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer chave-do-provedor-da-org",
    );
  });

  it("org na Anthropic com chave OpenAI achável: o áudio continua indo à OpenAI", async () => {
    const { fetchEspiao } = await transcreverComOWorker({ openai: "sk-openai" }, "anthropic");
    const [url, init] = fetchEspiao.mock.calls[0]!;
    expect(String(url)).toBe("https://api.openai.com/v1/audio/transcriptions");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer sk-openai");
  });

  it("org na Anthropic sem OpenAI e com OpenRouter achável: usa a OpenRouter, e NÃO a chave da Anthropic", async () => {
    const { fetchEspiao } = await transcreverComOWorker(
      { openai: null, openrouter: "sk-or-achada" },
      "anthropic",
    );
    const [url, init] = fetchEspiao.mock.calls[0]!;
    expect(String(url)).toContain("openrouter.ai");
    const auth = (init.headers as Record<string, string>).Authorization;
    expect(auth).toBe("Bearer sk-or-achada");
    expect(auth).not.toContain("chave-do-provedor-da-org");
  });

  it("sem chave de quem transcreve: devolve o marcador e NÃO chama a rede", async () => {
    const { texto, fetchEspiao } = await transcreverComOWorker(
      { openai: null, openrouter: null },
      "anthropic",
    );
    expect(texto).toBe(MARCADOR_NAO_LIDA);
    expect(fetchEspiao).not.toHaveBeenCalled();
  });
});
