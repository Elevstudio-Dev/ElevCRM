import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * "PUXAR HISTÓRICO DO WHATSAPP", NA TELA: o diálogo e o selo "Veio de anúncio" na bolha.
 *
 * Protege: o diálogo diz o que NÃO vai acontecer (ninguém recebe mensagem, a IA não responde) antes de confirmar;
 * o resultado conta o que entrou e o que veio de anúncio; o erro do canal fica no diálogo (não some num toast); e
 * a bolha identifica a mensagem que carregou o clique do anúncio — e só a de ENTRADA.
 */
const h = vi.hoisted(() => ({
  mutate: vi.fn(),
  reset: vi.fn(),
  estado: { data: undefined as unknown, error: null as unknown, isPending: false },
}));

vi.mock("@/hooks/inbox/usePuxarHistorico", () => ({
  usePuxarHistorico: () => ({ ...h.estado, mutate: h.mutate, reset: h.reset }),
}));

import { MessageBubble } from "@/components/inbox/MessageBubble";
import { PuxarHistoricoDialog } from "@/components/inbox/PuxarHistorico";
import { ApiError } from "@/lib/api/types";
import type { Message } from "@/lib/types/messaging";

const RESULTADO = {
  encontradas: 40,
  importadas: 31,
  ja_existiam: 9,
  falharam: 0,
  de_anuncio: 2,
  contato_marcado_como_anuncio: true,
  primeira_em: "2025-03-01T10:00:00.000Z",
  ultima_em: "2025-03-20T10:00:00.000Z",
  limite_atingido: false,
};

function abrir() {
  return render(
    <PuxarHistoricoDialog contactId="c-1" conversationId="cv-1" nomeDoContato="Maria" open onOpenChange={() => {}} />,
  );
}

beforeEach(() => {
  h.mutate.mockReset();
  h.reset.mockReset();
  h.estado = { data: undefined, error: null, isPending: false };
});

describe("PuxarHistoricoDialog", () => {
  it("antes de confirmar, diz o que NÃO vai acontecer", () => {
    abrir();
    expect(screen.getByTestId("puxar-historico-dialog").textContent).toMatch(/Nada é enviado ao cliente/);
    expect(screen.getByTestId("puxar-historico-dialog").textContent).toMatch(/Maria/);
  });

  it("confirmar dispara a importação", () => {
    abrir();
    fireEvent.click(screen.getByTestId("puxar-historico-confirmar"));
    expect(h.mutate).toHaveBeenCalledTimes(1);
  });

  it("durante a busca o botão fica desligado (não dispara duas vezes)", () => {
    h.estado.isPending = true;
    abrir();
    expect((screen.getByTestId("puxar-historico-confirmar") as HTMLButtonElement).disabled).toBe(true);
  });

  it("o resultado conta o que entrou, o que já existia e o que veio de anúncio", () => {
    h.estado.data = RESULTADO;
    abrir();
    const r = screen.getByTestId("puxar-historico-resultado").textContent ?? "";
    expect(r).toMatch(/31/);
    expect(r).toMatch(/9\s+já estavam no CRM/);
    expect(screen.getByTestId("puxar-historico-anuncio").textContent).toMatch(/2\s+mensagem\(ns\) vieram de anúncio/);
    expect(r).toMatch(/marcado como vindo de anúncio/);
    // Depois do resultado não há mais botão de confirmar.
    expect(screen.queryByTestId("puxar-historico-confirmar")).toBeNull();
  });

  it("sem anúncio, diz isso — em vez de calar", () => {
    h.estado.data = { ...RESULTADO, de_anuncio: 0, contato_marcado_como_anuncio: false };
    abrir();
    expect(screen.getByTestId("puxar-historico-anuncio").textContent).toMatch(/Nenhuma mensagem veio de anúncio/);
  });

  it("conversa sem passado no WhatsApp diz que não há mensagens (não '0 novas')", () => {
    h.estado.data = { ...RESULTADO, encontradas: 0, importadas: 0, ja_existiam: 0, de_anuncio: 0 };
    abrir();
    expect(screen.getByTestId("puxar-historico-resultado").textContent).toMatch(/não tem mensagens antigas/);
  });

  it("avisa quando só as mais recentes vieram e quando alguma não pôde ser gravada", () => {
    h.estado.data = { ...RESULTADO, limite_atingido: true, falharam: 3 };
    abrir();
    const r = screen.getByTestId("puxar-historico-resultado").textContent ?? "";
    expect(r).toMatch(/só as mensagens mais recentes/);
    expect(r).toMatch(/3\s+mensagens não puderam ser gravadas/);
  });

  it("o erro do canal fica NO diálogo, com a explicação da rota, e oferece tentar de novo", () => {
    h.estado.error = new ApiError(409, "history_unavailable", undefined, "r", "O WhatsApp desta empresa ainda não guarda o histórico.");
    abrir();
    const erro = screen.getByTestId("puxar-historico-erro");
    expect(erro.getAttribute("role")).toBe("alert");
    expect(erro.textContent).toMatch(/ainda não guarda o histórico/);
    expect(screen.getByTestId("puxar-historico-confirmar").textContent).toMatch(/Tentar de novo/);
  });
});

function msg(over: Partial<Message> = {}): Message {
  return {
    id: "m1",
    organization_id: "o1",
    conversation_id: "c1",
    contact_id: "ct1",
    channel_session_id: "s1",
    external_id: "x1",
    type: "text",
    direction: "inbound",
    status: "delivered",
    ack: null,
    body: "Oi, vi o anúncio",
    media_url: null,
    media_mime: null,
    media_size_bytes: null,
    media_storage_path: null,
    sent_via: "external_device",
    sent_at: "2026-10-27T12:00:00.000Z",
    delivered_at: null,
    read_at: null,
    error_code: null,
    error_message: null,
    metadata: {},
    edited_at: null,
    revoked_at: null,
    reply_to_message_id: null,
    created_at: "2026-10-27T12:00:00.000Z",
    ...over,
  } as Message;
}

const ANUNCIO = { plataforma: "meta_ads", titulo: "Clareamento v1", codigo: "CLID", url: "https://fb.me/x" };

describe("a bolha identifica a mensagem de anúncio", () => {
  it("entrada com a marca: mostra 'Veio de anúncio' e o título como TEXTO", () => {
    render(<MessageBubble message={msg({ metadata: { anuncio: ANUNCIO } })} />);
    const selo = screen.getByTestId("mensagem-de-anuncio");
    expect(selo.textContent).toBe("Veio de anúncio · Clareamento v1");
  });

  it("título com HTML não vira HTML", () => {
    render(<MessageBubble message={msg({ metadata: { anuncio: { ...ANUNCIO, titulo: "<img src=x onerror=alert(1)>" } } })} />);
    const selo = screen.getByTestId("mensagem-de-anuncio");
    expect(selo.querySelector("img")).toBeNull();
    expect(selo.textContent).toContain("<img src=x onerror=alert(1)>");
  });

  it("anúncio sem título (clique sem o cartão) ainda é identificado", () => {
    render(<MessageBubble message={msg({ metadata: { anuncio: { ...ANUNCIO, titulo: null, codigo: null } } })} />);
    expect(screen.getByTestId("mensagem-de-anuncio").textContent).toBe("Veio de anúncio");
  });

  it("mensagem comum não ganha selo", () => {
    render(<MessageBubble message={msg()} />);
    expect(screen.queryByTestId("mensagem-de-anuncio")).toBeNull();
  });

  it("a nossa mensagem nunca ganha o selo, nem com a marca no metadata", () => {
    render(<MessageBubble message={msg({ direction: "outbound", metadata: { anuncio: ANUNCIO } })} />);
    expect(screen.queryByTestId("mensagem-de-anuncio")).toBeNull();
  });

  it("anexo antigo sem arquivo explica o vazio em vez de mostrar bolha em branco", () => {
    render(<MessageBubble message={msg({ type: "image", body: null, metadata: { midia_nao_importada: true } })} />);
    expect(screen.getByTestId("midia-nao-importada").textContent).toMatch(/Anexo antigo \(imagem\)/);
  });
});
