/**
 * A ARTE DA CAMPANHA: sai uma vez por pessoa, pela pasta da conversa dela, e
 * nunca para quem está com um humano ou pediu para sair.
 */
import { describe, expect, it } from "vitest";

import type { ChannelSendInput, ChannelSendResult } from "@/lib/agent-engine/channel-adapter";
import {
  SEQ_DA_IMAGEM,
  caminhoNaConversa,
  enviarImagemDaCampanha,
  type DepsDaImagem,
} from "@/lib/agent-engine/agent/imagem-da-campanha";

const ORG = "11111111-1111-4111-8111-111111111111";
const CONVERSA = "22222222-2222-4222-8222-222222222222";
const alvo = { tenantId: ORG, leadId: "lead-1", jobId: "job-1", conversationId: CONVERSA };
const imagem = { storage_path: `${ORG}/campanhas/arte.jpg`, mime: "image/jpeg" };

function deps(over: Partial<DepsDaImagem> & { resultado?: ChannelSendResult } = {}) {
  const copias: Array<[string, string]> = [];
  const envios: ChannelSendInput[] = [];
  const d: DepsDaImagem = {
    copiar: async (a, b) => void copias.push([a, b]),
    jaEnviada: async () => false,
    emHandoffOuBloqueado: async () => false,
    enviar: async (input) => {
      envios.push(input);
      return over.resultado ?? { kind: "sent", idempotencyKey: "k", messageId: "m" };
    },
    ...over,
  };
  return { d, copias, envios };
}

describe("enviarImagemDaCampanha", () => {
  it("copia para a pasta da conversa e envia a imagem sem legenda, na posição fixa do turno", async () => {
    const { d, copias, envios } = deps();
    expect(await enviarImagemDaCampanha(d, alvo, imagem)).toBe("enviada");
    const destino = caminhoNaConversa(ORG, CONVERSA, imagem);
    expect(destino.startsWith(`${ORG}/${CONVERSA}/`)).toBe(true);
    expect(copias).toEqual([[imagem.storage_path, destino]]);
    expect(envios).toEqual([
      expect.objectContaining({ seq: SEQ_DA_IMAGEM, body: "", imagem: { storagePath: destino, mime: "image/jpeg" } }),
    ]);
  });

  it("o caminho na conversa é o mesmo a cada tentativa (é ele que evita mandar duas vezes)", () => {
    expect(caminhoNaConversa(ORG, CONVERSA, imagem)).toBe(caminhoNaConversa(ORG, CONVERSA, imagem));
    expect(caminhoNaConversa(ORG, CONVERSA, imagem)).not.toBe(
      caminhoNaConversa(ORG, CONVERSA, { ...imagem, storage_path: `${ORG}/campanhas/outra.jpg` }),
    );
  });

  it("já enviada nesta conversa: não copia nem manda de novo", async () => {
    const { d, copias, envios } = deps({ jaEnviada: async () => true });
    expect(await enviarImagemDaCampanha(d, alvo, imagem)).toBe("ja_enviada");
    expect(copias).toHaveLength(0);
    expect(envios).toHaveLength(0);
  });

  it("com humano na conversa ou quem pediu para sair: não manda nada", async () => {
    const { d, envios } = deps({ emHandoffOuBloqueado: async () => true });
    expect(await enviarImagemDaCampanha(d, alvo, imagem)).toBe("pulada");
    expect(envios).toHaveLength(0);
  });

  it("recusa arquivo de fora da pasta de campanhas da organização", async () => {
    const { d, envios } = deps();
    await expect(
      enviarImagemDaCampanha(d, alvo, { ...imagem, storage_path: "outra-org/campanhas/arte.jpg" }),
    ).rejects.toThrow(/não pertence/);
    await expect(
      enviarImagemDaCampanha(d, alvo, { ...imagem, storage_path: `${ORG}/${CONVERSA}/arte.jpg` }),
    ).rejects.toThrow(/não pertence/);
    expect(envios).toHaveLength(0);
  });

  it("falha do canal sobe (a fila tenta de novo); bloqueio no envio vira pulada", async () => {
    await expect(
      enviarImagemDaCampanha(deps({ resultado: { kind: "failed", idempotencyKey: "k", messageId: null } }).d, alvo, imagem),
    ).rejects.toThrow(/falhou/);
    await expect(
      enviarImagemDaCampanha(deps({ resultado: { kind: "unavailable", reason: "x" } }).d, alvo, imagem),
    ).rejects.toThrow(/indisponível/);
    expect(
      await enviarImagemDaCampanha(deps({ resultado: { kind: "blocked", idempotencyKey: "k" } }).d, alvo, imagem),
    ).toBe("pulada");
  });
});
