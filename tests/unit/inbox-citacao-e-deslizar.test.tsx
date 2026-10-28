import { readFileSync } from "node:fs";

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { CitacaoResumo } from "@/components/inbox/CitacaoResumo";
import { MessageBubble } from "@/components/inbox/MessageBubble";
import { LIMIAR_PARA_RESPONDER } from "@/lib/inbox/deslizar-para-responder";
import type { Message } from "@/lib/types/messaging";

/**
 * Responder "como no WhatsApp": a citação diz o que a mensagem É, tocar nela leva até a original, e
 * deslizar a mensagem para o lado responde.
 *
 * Os eventos de ponteiro NÃO existem no jsdom do jeito que o navegador os tem (`pointerType`,
 * `isPrimary`): o `PointerEvent` abaixo os acrescenta, senão `fireEvent` os descartaria em silêncio e
 * o hook nunca veria um toque.
 */
if (typeof window.PointerEvent === "undefined") {
  class PointerEventDeTeste extends MouseEvent {
    pointerId: number;
    pointerType: string;
    isPrimary: boolean;
    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init);
      this.pointerId = init.pointerId ?? 1;
      this.pointerType = init.pointerType ?? "mouse";
      this.isPrimary = init.isPrimary ?? true;
    }
  }
  // @ts-expect-error — polyfill mínimo, só para os testes
  window.PointerEvent = PointerEventDeTeste;
}

function msg(over: Partial<Message> = {}): Message {
  return {
    id: "m1",
    conversation_id: "c1",
    contact_id: "ct1",
    channel_session_id: "s1",
    external_id: "x1",
    type: "text",
    direction: "inbound",
    status: "delivered",
    ack: null,
    body: "oi",
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
    created_at: "2026-10-27T12:00:00.000Z",
    ...over,
  } as Message;
}

describe("CitacaoResumo — o que a citação mostra", () => {
  it("áudio sem texto: o nome do tipo, e NÃO '(sem texto)'", () => {
    render(<CitacaoResumo mensagem={msg({ type: "audio", body: null, media_storage_path: "p" })} />);
    expect(screen.getByText("Áudio")).toBeInTheDocument();
    expect(screen.queryByText("(sem texto)")).not.toBeInTheDocument();
  });

  it("foto com legenda: a legenda; foto sem: 'Foto'", () => {
    const { unmount } = render(
      <CitacaoResumo mensagem={msg({ type: "image", body: "o comprovante", media_storage_path: "p" })} />,
    );
    expect(screen.getByText("o comprovante")).toBeInTheDocument();
    unmount();
    render(<CitacaoResumo mensagem={msg({ type: "image", body: null, media_storage_path: "p" })} />);
    expect(screen.getByText("Foto")).toBeInTheDocument();
  });

  it("apagada: o texto original não volta", () => {
    render(<CitacaoResumo mensagem={msg({ body: "segredo", revoked_at: "2026-10-27T13:00:00Z" })} />);
    expect(screen.getByText("Esta mensagem foi apagada")).toBeInTheDocument();
    expect(screen.queryByText("segredo")).not.toBeInTheDocument();
  });
});

describe("a citação dentro da bolha", () => {
  const citada = msg({ id: "orig", type: "audio", body: null, media_storage_path: "p" });
  const resposta = msg({ id: "resp", direction: "outbound", body: "pode ser quinta", reply_to_message_id: "orig" });

  it("com para onde ir, vira um botão que leva ao id da ORIGINAL", () => {
    const aoIr = vi.fn();
    render(<MessageBubble message={resposta} citada={citada} onIrParaMensagem={aoIr} />);
    const botao = screen.getByRole("button", { name: /ir para a mensagem citada/i });
    // O nome acessível leva também o que está sendo citado (um aria-label o apagaria).
    expect(botao).toHaveTextContent("Áudio");
    fireEvent.click(botao);
    expect(aoIr).toHaveBeenCalledWith("orig");
  });

  it("SEM para onde ir, é só texto — não finge ser um botão", () => {
    render(<MessageBubble message={resposta} citada={citada} />);
    expect(screen.queryByRole("button", { name: /ir para a mensagem citada/i })).not.toBeInTheDocument();
    expect(screen.getByText("Áudio")).toBeInTheDocument();
  });

  it("a bolha se deixa achar pelo id e pisca quando é o destino", () => {
    const { container, rerender } = render(<MessageBubble message={msg({ id: "alvo" })} />);
    const linha = container.querySelector('[data-mensagem-id="alvo"]')!;
    expect(linha).not.toBeNull();
    expect(linha.className).not.toContain("bg-primary/15");
    rerender(<MessageBubble message={msg({ id: "alvo" })} destacada />);
    expect(container.querySelector('[data-mensagem-id="alvo"]')!.className).toContain("bg-primary/15");
  });
});

describe("deslizar a mensagem para responder", () => {
  function toque(el: Element, tipo: "pointerDown" | "pointerMove" | "pointerUp", x: number, y: number, pointerType = "touch") {
    fireEvent[tipo](el, { pointerType, pointerId: 1, isPrimary: true, clientX: x, clientY: y });
  }
  const linhaDe = (container: HTMLElement) => container.querySelector<HTMLElement>("[data-mensagem-id]")!;

  it("deslizar para a direita além do limiar e soltar RESPONDE, e a bolha andou", () => {
    const aoResponder = vi.fn();
    const m = msg({ id: "a" });
    const { container } = render(<MessageBubble message={m} onResponder={aoResponder} />);
    const linha = linhaDe(container);

    toque(linha, "pointerDown", 10, 100);
    toque(linha, "pointerMove", 10 + LIMIAR_PARA_RESPONDER + 4, 102);
    expect(linha.style.transform).toMatch(/translateX\(\d+px\)/);
    toque(linha, "pointerUp", 10 + LIMIAR_PARA_RESPONDER + 4, 102);

    expect(aoResponder).toHaveBeenCalledTimes(1);
    expect(aoResponder).toHaveBeenCalledWith(m);
    // Soltou: a bolha volta ao lugar.
    expect(linha.style.transform).toBe("");
  });

  it("deslize curto e soltar NÃO responde (e a bolha volta)", () => {
    const aoResponder = vi.fn();
    const { container } = render(<MessageBubble message={msg()} onResponder={aoResponder} />);
    const linha = linhaDe(container);
    toque(linha, "pointerDown", 10, 100);
    toque(linha, "pointerMove", 10 + LIMIAR_PARA_RESPONDER - 20, 101);
    toque(linha, "pointerUp", 10 + LIMIAR_PARA_RESPONDER - 20, 101);
    expect(aoResponder).not.toHaveBeenCalled();
    expect(linha.style.transform).toBe("");
  });

  it("rolar a conversa (movimento vertical) NÃO responde — nem depois, ao andar para o lado", () => {
    const aoResponder = vi.fn();
    const { container } = render(<MessageBubble message={msg()} onResponder={aoResponder} />);
    const linha = linhaDe(container);
    toque(linha, "pointerDown", 10, 100);
    toque(linha, "pointerMove", 14, 160); // desceu: é rolagem, o gesto solta
    toque(linha, "pointerMove", 120, 162); // depois andou para o lado — já não é nosso
    toque(linha, "pointerUp", 120, 162);
    expect(aoResponder).not.toHaveBeenCalled();
  });

  it("com o MOUSE não vale (arrastar é selecionar texto; o botão de responder já existe)", () => {
    const aoResponder = vi.fn();
    const { container } = render(<MessageBubble message={msg()} onResponder={aoResponder} />);
    const linha = linhaDe(container);
    toque(linha, "pointerDown", 10, 100, "mouse");
    toque(linha, "pointerMove", 120, 101, "mouse");
    toque(linha, "pointerUp", 120, 101, "mouse");
    expect(aoResponder).not.toHaveBeenCalled();
  });

  it("começar na barra do player de áudio NÃO responde (arrastá-la é buscar no áudio)", () => {
    const aoResponder = vi.fn();
    render(
      <MessageBubble
        message={msg({ type: "audio", body: null, media_storage_path: "p", media_mime: "audio/ogg" })}
        onResponder={aoResponder}
      />,
    );
    const barra = screen.getByRole("slider", { name: /progresso do áudio/i });
    toque(barra, "pointerDown", 10, 100);
    toque(barra, "pointerMove", 120, 101);
    toque(barra, "pointerUp", 120, 101);
    expect(aoResponder).not.toHaveBeenCalled();
  });

  it("sem onResponder o gesto nem existe (nenhum touch-action tomado da tela)", () => {
    const { container } = render(<MessageBubble message={msg()} />);
    expect(linhaDe(container).style.touchAction).toBe("");
  });

  it("com onResponder a rolagem vertical segue livre (touch-action: pan-y)", () => {
    const { container } = render(<MessageBubble message={msg()} onResponder={vi.fn()} />);
    expect(linhaDe(container).style.touchAction).toBe("pan-y");
  });
});

describe("os dois lugares da citação dizem a mesma coisa", () => {
  it("a faixa do campo de envio usa o MESMO resumo da bolha", () => {
    // Duas cópias da regra divergem no primeiro tipo novo: a faixa dizia "(sem texto)" para um áudio
    // enquanto a bolha já dizia "Áudio". O Composer é pesado demais para montar aqui; o que importa
    // é que ele não volte a ter a sua própria conta do corpo.
    const fonte = readFileSync("components/inbox/Composer.tsx", "utf8");
    expect(fonte, "a faixa não usa o resumo comum").toMatch(/<CitacaoResumo\b/);
    expect(fonte, "a faixa voltou a mostrar o corpo cru").not.toMatch(/respondendo\.body/);
  });
});
