import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ENCAMINHAR, NA TELA: a bolha em modo de seleção, o toque longo, e o diálogo de confirmação.
 *
 * O que um teste de "renderiza" não pega e este pega: tocar numa bolha para marcá-la não pode abrir uma
 * resposta; uma mensagem que não pode ir não pode ser marcada (e a tela diz por quê); o diálogo diz
 * de quem são as mensagens e para quem vão antes de enviar; e o resultado mostra o que NÃO saiu.
 */

const { listaMock, mutarMock } = vi.hoisted(() => ({ listaMock: vi.fn(), mutarMock: vi.fn() }));
vi.mock("@/hooks/inbox/useEncaminhar", () => ({
  useConversasParaEncaminhar: () => listaMock(),
  useEncaminhar: () => ({ mutate: mutarMock, isPending: false, isError: false }),
}));

import { EncaminharDialog } from "@/components/inbox/EncaminharDialog";
import { MessageBubble } from "@/components/inbox/MessageBubble";
import { TEMPO_DO_TOQUE_LONGO_MS } from "@/lib/inbox/deslizar-para-responder";
import type { Message } from "@/lib/types/messaging";

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
    body: "oi, tudo bem?",
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
const linhaDe = (c: HTMLElement) => c.querySelector<HTMLElement>("[data-mensagem-id]")!;

describe("a bolha: começar a encaminhar", () => {
  it("o botão aparece e chama onEncaminhar com a mensagem", () => {
    const aoEncaminhar = vi.fn();
    const m = msg();
    render(<MessageBubble message={m} onEncaminhar={aoEncaminhar} onResponder={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /encaminhar esta mensagem/i }));
    expect(aoEncaminhar).toHaveBeenCalledWith(m);
  });

  it.each([
    ["apagada", { revoked_at: "2026-10-27T13:00:00Z" }],
    ["que falhou", { status: "failed", direction: "outbound" as const }],
    ["de localização", { type: "location" }],
  ])("mensagem %s NÃO oferece encaminhar", (_n, over) => {
    render(<MessageBubble message={msg(over)} onEncaminhar={vi.fn()} />);
    expect(screen.queryByRole("button", { name: /encaminhar esta mensagem/i })).not.toBeInTheDocument();
  });

  it("sem onEncaminhar (telas que não encaminham) o botão nem existe", () => {
    render(<MessageBubble message={msg()} onResponder={vi.fn()} />);
    expect(screen.queryByRole("button", { name: /encaminhar esta mensagem/i })).not.toBeInTheDocument();
  });

  it("a que veio de um encaminhamento leva o rótulo 'Encaminhada'", () => {
    const { rerender } = render(<MessageBubble message={msg()} />);
    expect(screen.queryByText("Encaminhada")).not.toBeInTheDocument();
    rerender(<MessageBubble message={msg({ metadata: { forwarded: true } })} />);
    expect(screen.getByText("Encaminhada")).toBeInTheDocument();
  });
});

describe("a bolha em modo de seleção", () => {
  const selecao = (over = {}) => ({ marcada: false, podeMarcar: true, aoAlternar: vi.fn(), ...over });

  it("ganha a caixa; tocar na linha alterna a marca; e NÃO abre resposta", () => {
    const aoAlternar = vi.fn();
    const aoResponder = vi.fn();
    const { container } = render(
      <MessageBubble message={msg()} selecao={selecao({ aoAlternar })} onResponder={aoResponder} onEncaminhar={vi.fn()} />,
    );
    expect(screen.getByRole("checkbox", { name: /selecionar mensagem/i })).not.toBeChecked();
    fireEvent.click(linhaDe(container));
    expect(aoAlternar).toHaveBeenCalledTimes(1);
    expect(aoResponder).not.toHaveBeenCalled();
    // Os botões de responder e encaminhar saem de cena: tocar para marcar não pode abrir outra coisa.
    expect(screen.queryByRole("button", { name: /responder a esta mensagem/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /encaminhar esta mensagem/i })).not.toBeInTheDocument();
  });

  it("marcada: a caixa vem marcada e a linha tinge", () => {
    const { container } = render(<MessageBubble message={msg()} selecao={selecao({ marcada: true })} />);
    expect(screen.getByRole("checkbox")).toBeChecked();
    expect(linhaDe(container).className).toContain("bg-primary/10");
  });

  it("não pode ser marcada: a caixa fica desabilitada, tocar NÃO alterna, e a dica diz por quê", () => {
    const aoAlternar = vi.fn();
    const { container } = render(
      <MessageBubble
        message={msg({ revoked_at: "2026-10-27T13:00:00Z" })}
        selecao={selecao({ podeMarcar: false, aoAlternar, motivo: "Mensagem apagada não pode ser encaminhada" })}
      />,
    );
    const caixa = screen.getByRole("checkbox");
    expect(caixa).toBeDisabled();
    expect(caixa).toHaveAttribute("title", "Mensagem apagada não pode ser encaminhada");
    fireEvent.click(linhaDe(container));
    expect(aoAlternar).not.toHaveBeenCalled();
  });

  it("tocar num controle de DENTRO (a citação) não alterna — ele faz o que faz", () => {
    const aoAlternar = vi.fn();
    const aoIr = vi.fn();
    render(
      <MessageBubble
        message={msg({ id: "resp", reply_to_message_id: "orig" })}
        citada={msg({ id: "orig", body: "a original" })}
        onIrParaMensagem={aoIr}
        selecao={selecao({ aoAlternar })}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /ir para a mensagem citada/i }));
    expect(aoIr).toHaveBeenCalledWith("orig");
    expect(aoAlternar).not.toHaveBeenCalled();
  });
});

describe("o toque longo começa a encaminhar", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const toque = (el: Element, tipo: "pointerDown" | "pointerMove" | "pointerUp", x: number, y: number) =>
    fireEvent[tipo](el, { pointerType: "touch", pointerId: 1, isPrimary: true, clientX: x, clientY: y });

  it("dedo parado pelo tempo do toque longo: começa; e soltar depois NÃO responde", () => {
    const aoEncaminhar = vi.fn();
    const aoResponder = vi.fn();
    const m = msg();
    const { container } = render(<MessageBubble message={m} onEncaminhar={aoEncaminhar} onResponder={aoResponder} />);
    const linha = linhaDe(container);
    toque(linha, "pointerDown", 10, 100);
    act(() => void vi.advanceTimersByTime(TEMPO_DO_TOQUE_LONGO_MS + 10));
    expect(aoEncaminhar).toHaveBeenCalledWith(m);
    toque(linha, "pointerUp", 10, 100);
    expect(aoResponder).not.toHaveBeenCalled();
  });

  it("depois do toque longo, arrastar para o lado e soltar NÃO responde (o dedo já fazia outra coisa)", () => {
    const aoResponder = vi.fn();
    const { container } = render(<MessageBubble message={msg()} onEncaminhar={vi.fn()} onResponder={aoResponder} />);
    const linha = linhaDe(container);
    toque(linha, "pointerDown", 10, 100);
    act(() => void vi.advanceTimersByTime(TEMPO_DO_TOQUE_LONGO_MS + 10));
    toque(linha, "pointerMove", 120, 101);
    toque(linha, "pointerUp", 120, 101);
    expect(aoResponder).not.toHaveBeenCalled();
  });

  it("começar a DESLIZAR para o lado desarma o toque longo (não vira seleção no meio da resposta)", () => {
    const aoEncaminhar = vi.fn();
    const { container } = render(<MessageBubble message={msg()} onEncaminhar={aoEncaminhar} onResponder={vi.fn()} />);
    const linha = linhaDe(container);
    toque(linha, "pointerDown", 10, 100);
    toque(linha, "pointerMove", 50, 101); // deslizando para a direita
    act(() => void vi.advanceTimersByTime(TEMPO_DO_TOQUE_LONGO_MS + 200));
    expect(aoEncaminhar).not.toHaveBeenCalled();
  });

  it("soltar ANTES do tempo é só um toque: não começa", () => {
    const aoEncaminhar = vi.fn();
    const { container } = render(<MessageBubble message={msg()} onEncaminhar={aoEncaminhar} />);
    const linha = linhaDe(container);
    toque(linha, "pointerDown", 10, 100);
    act(() => void vi.advanceTimersByTime(TEMPO_DO_TOQUE_LONGO_MS - 100));
    toque(linha, "pointerUp", 10, 100);
    act(() => void vi.advanceTimersByTime(1000));
    expect(aoEncaminhar).not.toHaveBeenCalled();
  });

  it("andar (era rolagem ou deslize) DESARMA o toque longo", () => {
    const aoEncaminhar = vi.fn();
    const { container } = render(<MessageBubble message={msg()} onEncaminhar={aoEncaminhar} />);
    const linha = linhaDe(container);
    toque(linha, "pointerDown", 10, 100);
    toque(linha, "pointerMove", 14, 160); // desceu: rolagem
    act(() => void vi.advanceTimersByTime(TEMPO_DO_TOQUE_LONGO_MS + 200));
    expect(aoEncaminhar).not.toHaveBeenCalled();
  });

  it("mensagem que não pode ser encaminhada não responde ao toque longo", () => {
    const aoEncaminhar = vi.fn();
    const { container } = render(
      <MessageBubble message={msg({ revoked_at: "2026-10-27T13:00:00Z" })} onEncaminhar={aoEncaminhar} />,
    );
    toque(linhaDe(container), "pointerDown", 10, 100);
    act(() => void vi.advanceTimersByTime(TEMPO_DO_TOQUE_LONGO_MS + 200));
    expect(aoEncaminhar).not.toHaveBeenCalled();
  });
});

describe("o diálogo de encaminhar", () => {
  const origem = {
    id: "conv-origem",
    contact_id: "ct-origem",
    contacts: { id: "ct-origem", name: "Maria Origem", display_name: null, phone_number: "+5511900000001" },
  } as never;
  const destino = (id: string, nome: string, over = {}) =>
    ({
      id,
      contact_id: `ct-${id}`,
      contacts: { id: `ct-${id}`, name: nome, display_name: null, phone_number: `+55119${id.slice(-4)}`, is_blocked: false },
      channel_sessions: { display_name: "Número 1" },
      ...over,
    }) as never;

  const mensagens = [
    msg({ id: "a", body: "primeira mensagem", sent_at: "2026-10-27T10:00:00Z" }),
    msg({ id: "b", type: "audio", body: null, media_storage_path: "p", sent_at: "2026-10-27T11:00:00Z" }),
  ];

  beforeEach(() => {
    mutarMock.mockReset();
    listaMock.mockReset().mockReturnValue({
      data: [destino("d0001", "João Destino"), destino("d0002", "Ana Destino"), destino("conv-origem", "Maria Origem", { contact_id: "ct-origem" })],
      isPending: false,
      isError: false,
    });
  });

  const montar = (over = {}) => {
    const props = { mensagens, origem, onFechar: vi.fn(), onConcluido: vi.fn(), ...over };
    render(<EncaminharDialog {...props} />);
    return props;
  };

  it("mostra o que vai (com o resumo de cada uma) e só liga o botão com um destino escolhido", () => {
    montar();
    const vai = screen.getByRole("region", { name: /o que vai ser encaminhado/i });
    expect(within(vai).getByText("primeira mensagem")).toBeInTheDocument();
    expect(within(vai).getByText("Áudio")).toBeInTheDocument();

    const botao = screen.getByRole("button", { name: /^encaminhar$/i });
    expect(botao).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox", { name: /joão destino/i }));
    expect(botao).toBeEnabled();
  });

  it("diz de QUEM são as mensagens e PARA QUEM vão, antes de enviar", () => {
    montar();
    expect(screen.queryByRole("note")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("checkbox", { name: /joão destino/i }));
    const nota = screen.getByRole("note");
    expect(nota).toHaveTextContent("Maria Origem");
    expect(nota).toHaveTextContent("João Destino");
  });

  it("a conversa atual aparece marcada como tal, e encaminhar para ela mesma não pede a conferência", () => {
    montar();
    expect(screen.getByText("Conversa atual")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("checkbox", { name: /maria origem/i }));
    expect(screen.queryByRole("note")).not.toBeInTheDocument();
  });

  it("no máximo 5 conversas: as outras ficam desabilitadas", () => {
    const muitas = Array.from({ length: 7 }, (_, i) => destino(`d${String(i).padStart(4, "0")}`, `Pessoa ${i}`));
    listaMock.mockReturnValue({ data: muitas, isPending: false, isError: false });
    montar();
    for (let i = 0; i < 5; i++) fireEvent.click(screen.getByRole("checkbox", { name: new RegExp(`^pessoa ${i}(?!\\d)`, "i") }));
    expect(screen.getByRole("checkbox", { name: /^pessoa 5(?!\d)/i })).toBeDisabled();
    expect(screen.getByRole("checkbox", { name: /^pessoa 6(?!\d)/i })).toBeDisabled();
    // As já escolhidas continuam desmarcáveis.
    expect(screen.getByRole("checkbox", { name: /^pessoa 0(?!\d)/i })).toBeEnabled();
  });

  it("contato bloqueado não pode ser escolhido", () => {
    listaMock.mockReturnValue({
      data: [destino("d0001", "Bloqueada", { contacts: { id: "x", name: "Bloqueada", phone_number: "+551", is_blocked: true } })],
      isPending: false,
      isError: false,
    });
    montar();
    expect(screen.getByRole("checkbox", { name: /bloqueada/i })).toBeDisabled();
  });

  it("envia as mensagens NA ORDEM e os destinos escolhidos; ao sair alguma, avisa quem abriu", () => {
    mutarMock.mockImplementation((_v, opts) =>
      opts.onSuccess({
        destinos: [{ conversation_id: "d0001", contato: "João Destino", enviadas: 2, falhas: [] }],
        total_enviadas: 2,
        total_falhas: 0,
      }),
    );
    const props = montar();
    fireEvent.click(screen.getByRole("checkbox", { name: /joão destino/i }));
    fireEvent.click(screen.getByRole("button", { name: /^encaminhar$/i }));

    expect(mutarMock.mock.calls[0]![0]).toEqual({
      message_ids: ["a", "b"],
      destination_conversation_ids: ["d0001"],
    });
    expect(props.onConcluido).toHaveBeenCalledTimes(1);
    // O resultado é lido NO diálogo (ele não fecha sozinho).
    expect(screen.getByTestId("resultado-do-encaminhamento")).toHaveTextContent("Encaminhado.");
    expect(props.onFechar).not.toHaveBeenCalled();
  });

  it("saiu só em parte: diz isso, e mostra o que NÃO saiu e por quê", () => {
    mutarMock.mockImplementation((_v, opts) =>
      opts.onSuccess({
        destinos: [
          { conversation_id: "d0001", contato: "João Destino", enviadas: 2, falhas: [] },
          { conversation_id: "d0002", contato: "Ana Destino", enviadas: 0, falhas: [{ message_id: "a", erro: "Conversa fechada." }] },
        ],
        total_enviadas: 2,
        total_falhas: 1,
      }),
    );
    montar();
    fireEvent.click(screen.getByRole("checkbox", { name: /joão destino/i }));
    fireEvent.click(screen.getByRole("checkbox", { name: /ana destino/i }));
    fireEvent.click(screen.getByRole("button", { name: /^encaminhar$/i }));

    const r = screen.getByTestId("resultado-do-encaminhamento");
    expect(r).toHaveTextContent("Encaminhado só em parte.");
    expect(r).toHaveTextContent("Conversa fechada.");
  });

  it("nada saiu: NÃO avisa quem abriu (a seleção continua para tentar de novo)", () => {
    mutarMock.mockImplementation((_v, opts) =>
      opts.onSuccess({
        destinos: [{ conversation_id: "d0001", contato: "João Destino", enviadas: 0, falhas: [{ message_id: "a", erro: "boom" }] }],
        total_enviadas: 0,
        total_falhas: 1,
      }),
    );
    const props = montar();
    fireEvent.click(screen.getByRole("checkbox", { name: /joão destino/i }));
    fireEvent.click(screen.getByRole("button", { name: /^encaminhar$/i }));
    expect(screen.getByTestId("resultado-do-encaminhamento")).toHaveTextContent("Nada foi encaminhado.");
    expect(props.onConcluido).not.toHaveBeenCalled();
  });

  it("cancelar fecha sem enviar nada", () => {
    const props = montar();
    fireEvent.click(screen.getByRole("button", { name: /^cancelar$/i }));
    expect(props.onFechar).toHaveBeenCalled();
    expect(mutarMock).not.toHaveBeenCalled();
  });
});
