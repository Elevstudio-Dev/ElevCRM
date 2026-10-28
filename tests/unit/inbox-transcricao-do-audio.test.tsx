import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { MediaRenderer } from "@/components/inbox/media/MediaRenderer";
import { MARCADOR_NAO_LIDA } from "@/lib/messaging/media/derivable";
import type { Message } from "@/lib/types/messaging";

function audio(over: Partial<Message> = {}): Message {
  return {
    id: "m1",
    conversation_id: "c1",
    contact_id: "ct1",
    channel_session_id: "s1",
    external_id: "x1",
    type: "audio",
    direction: "inbound",
    status: "delivered",
    ack: null,
    body: null,
    media_url: "http://waha/file",
    media_mime: "audio/ogg",
    media_size_bytes: null,
    media_storage_path: "org/conv/m1.ogg",
    sent_via: "external_device",
    sent_at: new Date().toISOString(),
    delivered_at: null,
    read_at: null,
    error_code: null,
    error_message: null,
    metadata: {},
    created_at: new Date().toISOString(),
    ...over,
  } as Message;
}

describe("o texto do áudio embaixo do player", () => {
  it("pronta: começa FECHADA (o áudio continua sendo o que se vê) e abre/fecha no botão", () => {
    render(
      <MediaRenderer
        message={audio({ media_derived_status: "ready", media_derived_text: "Quero remarcar para terça." })}
      />,
    );
    // O player segue ali.
    expect(screen.getByRole("button", { name: /reproduzir/i })).toBeInTheDocument();
    // O texto, não.
    expect(screen.queryByText("Quero remarcar para terça.")).not.toBeInTheDocument();

    const botao = screen.getByRole("button", { name: /ver texto/i });
    expect(botao).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(botao);

    expect(screen.getByText("Quero remarcar para terça.")).toBeInTheDocument();
    const fechar = screen.getByRole("button", { name: /ocultar texto/i });
    expect(fechar).toHaveAttribute("aria-expanded", "true");

    fireEvent.click(fechar);
    expect(screen.queryByText("Quero remarcar para terça.")).not.toBeInTheDocument();
  });

  it("o botão aponta para o texto que controla", () => {
    render(
      <MediaRenderer message={audio({ media_derived_status: "ready", media_derived_text: "Oi" })} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /ver texto/i }));
    const botao = screen.getByRole("button", { name: /ocultar texto/i });
    const alvo = document.getElementById(botao.getAttribute("aria-controls")!);
    expect(alvo).not.toBeNull();
    expect(alvo!.textContent).toBe("Oi");
  });

  it("quebras de linha do texto são preservadas (select-text, copiável)", () => {
    render(
      <MediaRenderer
        message={audio({ media_derived_status: "ready", media_derived_text: "linha um\nlinha dois" })}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /ver texto/i }));
    const p = screen.getByText(/linha um/);
    expect(p.className).toContain("whitespace-pre-wrap");
    expect(p.className).toContain("select-text");
  });

  it("recém-chegado: avisa que está transcrevendo, sem botão", () => {
    render(<MediaRenderer message={audio()} />);
    expect(screen.getByRole("status")).toHaveTextContent("Transcrevendo…");
    expect(screen.queryByRole("button", { name: /ver texto/i })).not.toBeInTheDocument();
  });

  it("falhou ou veio o marcador interno: diz que não foi possível — e NÃO mostra o marcador", () => {
    const { unmount } = render(<MediaRenderer message={audio({ media_derived_status: "failed" })} />);
    expect(screen.getByText("Não foi possível transcrever este áudio.")).toBeInTheDocument();
    unmount();

    render(
      <MediaRenderer
        message={audio({ media_derived_status: "ready", media_derived_text: MARCADOR_NAO_LIDA })}
      />,
    );
    expect(screen.getByText("Não foi possível transcrever este áudio.")).toBeInTheDocument();
    expect(screen.queryByText(MARCADOR_NAO_LIDA)).not.toBeInTheDocument();
  });

  it("sem fala reconhecida", () => {
    render(<MediaRenderer message={audio({ media_derived_status: "ready", media_derived_text: "" })} />);
    expect(screen.getByText("Não identifiquei fala neste áudio.")).toBeInTheDocument();
  });

  it("áudio antigo sem estado nenhum: não afirma nada", () => {
    render(
      <MediaRenderer message={audio({ created_at: "2026-07-21T20:00:00.000Z" })} />,
    );
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.queryByText(/transcrever|transcrevendo|ver texto/i)).not.toBeInTheDocument();
  });

  it("áudio que a atendente mandou: sem transcrição, mesmo que haja texto no banco", () => {
    render(
      <MediaRenderer
        message={audio({
          direction: "outbound",
          media_derived_status: "ready",
          media_derived_text: "isto não deve aparecer",
        })}
      />,
    );
    expect(screen.queryByRole("button", { name: /ver texto/i })).not.toBeInTheDocument();
    expect(screen.queryByText("isto não deve aparecer")).not.toBeInTheDocument();
  });

  it("a descrição de uma IMAGEM não vira 'texto do áudio'", () => {
    render(
      <MediaRenderer
        message={audio({
          type: "image",
          media_derived_status: "ready",
          media_derived_text: "uma foto de um dente",
        })}
      />,
    );
    expect(screen.queryByRole("button", { name: /ver texto/i })).not.toBeInTheDocument();
  });
});
