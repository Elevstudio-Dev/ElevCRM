import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { MessageBubble } from "@/components/inbox/MessageBubble";
import type { Message } from "@/lib/types/messaging";

/**
 * A MENSAGEM QUE NÃO SAIU TEM DE DIZER QUE NÃO SAIU.
 *
 * O envio deixa a mensagem em `queued` (com `metadata.queued_reason`) quando nem tenta mandar — número
 * desconectado, canal sem configuração — e nada a reenvia sozinha (o resgate só olha as da IA). A bolha
 * não mostrava NADA nesse estado: o dono mandou o link de um convite num grupo e leu a tela como "não
 * enviou". Aqui se mede o que a bolha mostra; o que o envio grava está em `app/api/v1/messages/_handler.ts`.
 */

function msg(over: Partial<Message> = {}): Message {
  return {
    id: "m1",
    organization_id: "o1",
    conversation_id: "c1",
    channel_session_id: "s1",
    contact_id: "ct1",
    external_id: null,
    type: "text",
    direction: "outbound",
    status: "queued",
    ack: null,
    error_code: null,
    error_message: null,
    body: "https://exemplo.com.br/convite",
    media_url: null,
    media_mime: null,
    media_size_bytes: null,
    media_storage_path: null,
    sent_via: "user",
    sent_by_user_id: null,
    sent_at: "2026-08-21T12:00:00.000Z",
    delivered_at: null,
    read_at: null,
    metadata: {},
    edited_at: null,
    revoked_at: null,
    reply_to_message_id: null,
    created_at: "2026-08-21T12:00:00.000Z",
    ...over,
  } as Message;
}

describe("selo 'Não saiu' — a mensagem nossa que ficou na fila", () => {
  it("número desconectado: diz 'Não saiu' e a dica explica por quê", () => {
    render(<MessageBubble message={msg({ metadata: { queued_reason: "channel_session_not_working" } })} />);
    const selo = screen.getByTestId("selo-de-fila");
    expect(selo).toHaveTextContent("Não saiu");
    expect(selo.getAttribute("title")).toMatch(/desconectado/i);
  });

  it("canal sem configuração: a dica diz isso, e não 'desconectado'", () => {
    render(<MessageBubble message={msg({ metadata: { queued_reason: "waha_not_configured" } })} />);
    const dica = screen.getByTestId("selo-de-fila").getAttribute("title") ?? "";
    expect(dica).toMatch(/não está configurado/i);
    expect(dica).not.toMatch(/desconectado/i);
  });

  it("sem motivo gravado: o selo aparece com a dica genérica — nunca inventa uma causa", () => {
    render(<MessageBubble message={msg({ metadata: {} })} />);
    const dica = screen.getByTestId("selo-de-fila").getAttribute("title") ?? "";
    expect(dica).toMatch(/ficou na fila/i);
    expect(dica).not.toMatch(/desconectado|configurado/i);
  });

  it("a bolha OTIMISTA (ainda saindo) não é aviso: relógio, sem 'Não saiu'", () => {
    // Sem este caso, toda mensagem piscaria "Não saiu" nos milissegundos antes de o servidor responder.
    render(<MessageBubble message={msg({ metadata: { _optimistic: true } })} />);
    expect(screen.queryByTestId("selo-de-fila")).toBeNull();
    expect(screen.getByLabelText("Na fila para enviar")).toBeInTheDocument();
  });

  it("CONTROLE: enviada não leva o selo e mostra o tique de 'Enviada'", () => {
    render(<MessageBubble message={msg({ status: "sent" })} />);
    expect(screen.queryByTestId("selo-de-fila")).toBeNull();
    expect(screen.getByLabelText("Enviada")).toBeInTheDocument();
  });

  it("CONTROLE: falhou continua dizendo 'Falhou', e não 'Não saiu'", () => {
    render(<MessageBubble message={msg({ status: "failed", error_message: "waha_500" })} />);
    expect(screen.queryByTestId("selo-de-fila")).toBeNull();
    expect(screen.getByText("Falhou")).toBeInTheDocument();
  });

  it("mensagem do cliente em `queued` não é nossa: sem selo", () => {
    render(<MessageBubble message={msg({ direction: "inbound", sent_via: undefined })} />);
    expect(screen.queryByTestId("selo-de-fila")).toBeNull();
  });
});
