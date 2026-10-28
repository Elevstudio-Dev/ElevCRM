// @vitest-environment node
//
// O caso do servidor HTTP precisa do `fetch`/`FormData`/`Blob` do Node: no
// jsdom (padrão deste repo) o `FormData` é outro e o corpo não sai multipart.
import { createServer } from "node:http";

import { describe, expect, it, vi } from "vitest";

import { apiTranscriptionProvider, transcritorDaRota } from "@/lib/messaging/media/transcription";

describe("apiTranscriptionProvider", () => {
  it("POSTa multipart pro endpoint de transcrição e devolve o texto", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ text: "olá, quero comprar" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const provider = apiTranscriptionProvider({ apiKey: "sk-test" }, fetchMock);
    const text = await provider.transcribe(Buffer.from([1, 2, 3]), "audio/ogg; codecs=opus");
    expect(text).toBe("olá, quero comprar");
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain("/v1/audio/transcriptions");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer sk-test");
    expect(init.body).toBeInstanceOf(FormData);
  });

  it("pela OpenRouter: endereço, modelo e chave da rota (o mesmo Whisper)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ text: "quero marcar uma limpeza" }), { status: 200 }),
    );
    const provider = transcritorDaRota(
      { via: "openrouter", apiKey: "sk-or-teste" },
      { fetchImpl: fetchMock, headers: { "X-Title": "Teste" } },
    );
    const text = await provider.transcribe(Buffer.from([1, 2, 3]), "audio/ogg; codecs=opus");
    expect(text).toBe("quero marcar uma limpeza");
    const [url, init] = fetchMock.mock.calls[0]!;
    // `/api/v1/…` e não `/v1/v1/…`: a base dela termina em `/api`.
    expect(String(url)).toBe("https://openrouter.ai/api/v1/audio/transcriptions");
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer sk-or-teste");
    expect(headers["X-Title"]).toBe("Teste");
    expect((init.body as FormData).get("model")).toBe("openai/whisper-1");
  });

  it("pela OpenAI: continua no endereço e no modelo de sempre", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ text: "oi" }), { status: 200 }));
    const provider = transcritorDaRota({ via: "openai", apiKey: "sk-test" }, { fetchImpl: fetchMock });
    await provider.transcribe(Buffer.from([1]), "audio/ogg");
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe("https://api.openai.com/v1/audio/transcriptions");
    expect((init.body as FormData).get("model")).toBe("whisper-1");
  });

  it("o cabeçalho de atribuição não pode sobrepor a Authorization", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ text: "x" }), { status: 200 }));
    const provider = apiTranscriptionProvider(
      { apiKey: "sk-certa", headers: { Authorization: "Bearer outra" } },
      fetchMock,
    );
    await provider.transcribe(Buffer.from([1]), "audio/ogg");
    const headers = fetchMock.mock.calls[0]![1].headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer sk-certa");
  });

  it("propaga erro HTTP do provider", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("nope", { status: 401 }));
    const provider = apiTranscriptionProvider({ apiKey: "bad" }, fetchMock);
    await expect(provider.transcribe(Buffer.from([1]), "audio/ogg")).rejects.toThrow(/transcription_401/);
  });
});

describe("a chamada que sai pela rede, de verdade (servidor HTTP local imitando a OpenRouter)", () => {
  /**
   * O `fetch` falso dos casos acima prova o que o código PEDE; este prova o que
   * chega no fio: o `FormData`/`Blob` serializados em multipart, o caminho, o
   * cabeçalho e o nome do arquivo que a OpenRouter vai receber. Não prova a
   * OpenRouter — essa só se prova com uma chave dela.
   */
  it("manda multipart para /api/v1/audio/transcriptions com chave, modelo e arquivo .ogg", async () => {
    const recebido: { url?: string; auth?: string; tipo?: string; corpo?: string } = {};
    const servidor = createServer((req, res) => {
      const partes: Buffer[] = [];
      req.on("data", (c: Buffer) => partes.push(c));
      req.on("end", () => {
        recebido.url = req.url;
        recebido.auth = req.headers.authorization;
        recebido.tipo = req.headers["content-type"];
        recebido.corpo = Buffer.concat(partes).toString("latin1");
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ text: "bom dia, quero remarcar", usage: { seconds: 3 } }));
      });
    });
    await new Promise<void>((ok) => servidor.listen(0, "127.0.0.1", ok));
    try {
      const porta = (servidor.address() as { port: number }).port;
      // Mesma forma da rota da OpenRouter, só trocando o host para o local.
      const provider = apiTranscriptionProvider({
        apiKey: "sk-or-no-fio",
        baseUrl: `http://127.0.0.1:${porta}/api`,
        model: "openai/whisper-1",
      });
      const texto = await provider.transcribe(Buffer.from("OggS-bytes-de-teste"), "audio/ogg; codecs=opus");

      expect(texto).toBe("bom dia, quero remarcar");
      expect(recebido.url).toBe("/api/v1/audio/transcriptions");
      expect(recebido.auth).toBe("Bearer sk-or-no-fio");
      expect(recebido.tipo).toMatch(/^multipart\/form-data; boundary=/);
      expect(recebido.corpo).toContain('name="model"');
      expect(recebido.corpo).toContain("openai/whisper-1");
      expect(recebido.corpo).toMatch(/name="file"; filename="audio\.ogg"/);
      expect(recebido.corpo).toContain("OggS-bytes-de-teste");
    } finally {
      await new Promise<void>((ok) => servidor.close(() => ok()));
    }
  });
});
