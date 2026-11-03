import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * O `@` NO CHAT DA EQUIPE — o campo do painel, com o hook e a API de verdade fora (mockados).
 *
 * Prova: a lista abre no canal em que há a quem marcar, o envio leva as marcações, a mensagem que
 * chega mostra o nome em destaque (e destaca mais a que me inclui), e o canal DIRETO não oferece `@`.
 */

const enviarMock = vi.fn();
let canais: Array<Record<string, unknown>> = [];
let mensagens: Array<Record<string, unknown>> = [];
let colegasDoCanal: Array<{ user_id: string; nome: string; role: string }> = [];

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (chave: string) => chave }));
vi.mock("@/hooks/i18n/useLocaleDeData", () => ({ useLocaleDeData: () => undefined }));
vi.mock("@/hooks/auth/AuthProvider", () => ({ useUser: () => ({ id: "u-eu" }) }));
vi.mock("@/hooks/inbox/useAssignableMembers", () => ({ useAssignableMembers: () => ({ data: [] }) }));
vi.mock("@/hooks/chat-interno/useChatInterno", () => ({
  useCanaisDaEquipe: () => ({ data: canais, isLoading: false }),
  useMensagensDoCanal: () => ({ data: mensagens, isLoading: false }),
  useEnviarMensagemDaEquipe: () => ({ mutate: enviarMock, isPending: false }),
  useMarcarCanalLido: () => ({ mutate: vi.fn() }),
  useAbrirConversaDireta: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/mencoes/useMarcaveis", () => ({
  // A MESMA lista para qualquer canal: o que decide se o canal direto a recebe é só o `enabled` que o
  // painel passa (o hook de verdade fica desligado ali). Se o mock já devolvesse vazio para o direto, o
  // teste passaria mesmo com o painel pedindo a lista.
  useMarcaveisDoCanal: (canalId: string | null, enabled: boolean) => ({
    data: enabled && canalId ? colegasDoCanal : undefined,
  }),
}));

import { PainelDoChat } from "@/components/chat-interno/PainelDoChat";

const GERAL = { id: "c-geral", kind: "geral", name: "Geral", sector_id: null, sector_color: null, other_user_id: null, unread: 0, last_message: null };
const DIRETO = { id: "c-bia", kind: "direto", name: "Bia", sector_id: null, sector_color: null, other_user_id: "u-bia", unread: 0, last_message: null };

/** O que a gaveta recebeu de `onOpenChange` — `false` é "fechou". */
const aoMudarAberto = vi.fn();

function abrir(canalInicial: string) {
  render(<PainelDoChat open onOpenChange={aoMudarAberto} canalInicial={canalInicial} />);
  return screen.getByLabelText("Mensagem para a equipe") as HTMLTextAreaElement;
}
const digitar = (campo: HTMLTextAreaElement, valor: string) => fireEvent.change(campo, { target: { value: valor } });

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  canais = [GERAL, DIRETO];
  mensagens = [];
  colegasDoCanal = [
    { user_id: "u-ana", nome: "Ana Souza", role: "agent" },
    { user_id: "u-caio", nome: "Caio Lima", role: "manager" },
  ];
  enviarMock.mockClear();
  aoMudarAberto.mockClear();
});
afterEach(cleanup);

describe("o campo do chat da equipe", () => {
  it("abre a lista com @todos e os colegas do canal", () => {
    const campo = abrir("c-geral");
    digitar(campo, "@");
    expect(screen.getAllByTestId("opcao-de-mencao").map((o) => o.getAttribute("data-nome"))).toEqual([
      "todos",
      "Ana Souza",
      "Caio Lima",
    ]);
    expect(screen.getByText("Avisa quem está neste canal")).toBeInTheDocument();
  });

  it("escolher e enviar leva a marcação para a API", () => {
    const campo = abrir("c-geral");
    digitar(campo, "@ca");
    fireEvent.keyDown(campo, { key: "Enter" });
    expect(campo.value).toBe("@Caio Lima ");
    expect(enviarMock).not.toHaveBeenCalled();

    digitar(campo, "@Caio Lima o boleto caiu?");
    fireEvent.keyDown(campo, { key: "Enter" });
    expect(enviarMock).toHaveBeenCalledWith(
      { body: "@Caio Lima o boleto caiu?", mentions: [{ tipo: "pessoa", user_id: "u-caio", nome: "Caio Lima" }] },
      expect.anything(),
    );
    expect(campo.value).toBe("");
  });

  it("se o envio falha, o texto e a marcação voltam", () => {
    const campo = abrir("c-geral");
    digitar(campo, "@an");
    fireEvent.keyDown(campo, { key: "Enter" });
    digitar(campo, "@Ana Souza oi");
    fireEvent.keyDown(campo, { key: "Enter" });

    act(() => (enviarMock.mock.calls[0]![1] as { onError: () => void }).onError());
    expect(campo.value).toBe("@Ana Souza oi");

    enviarMock.mockClear();
    fireEvent.keyDown(campo, { key: "Enter" });
    expect(enviarMock).toHaveBeenCalledWith(
      expect.objectContaining({ mentions: [{ tipo: "pessoa", user_id: "u-ana", nome: "Ana Souza" }] }),
      expect.anything(),
    );
  });

  it("mensagem sem @ sai sem marcação, e o Enter envia (a lista fechada não o rouba)", () => {
    const campo = abrir("c-geral");
    digitar(campo, "bom dia");
    fireEvent.keyDown(campo, { key: "Enter" });
    expect(enviarMock).toHaveBeenCalledWith({ body: "bom dia", mentions: [] }, expect.anything());
  });

  it("o Esc fecha a LISTA e NÃO a gaveta do chat — o texto que se escrevia continua lá", () => {
    // Medido no navegador: o Radix fecha a gaveta com um ouvinte de captura no `document`, antes de o campo
    // ver a tecla. O hook precisa pegar o Esc primeiro (no `window`) enquanto a lista está aberta.
    const campo = abrir("c-geral");
    digitar(campo, "oi @");
    expect(screen.getByTestId("menu-de-mencao")).toBeInTheDocument();

    fireEvent.keyDown(campo, { key: "Escape" });

    expect(screen.queryByTestId("menu-de-mencao")).not.toBeInTheDocument();
    expect(aoMudarAberto).not.toHaveBeenCalledWith(false);
    expect(campo.value).toBe("oi @");
  });

  it("com a lista FECHADA o Esc continua sendo da gaveta", () => {
    const campo = abrir("c-geral");
    digitar(campo, "oi");
    fireEvent.keyDown(campo, { key: "Escape" });
    expect(aoMudarAberto).toHaveBeenCalledWith(false);
  });

  it("o Esc que fechou a lista não deixa ela reabrir sozinha enquanto se continua no mesmo @", () => {
    const campo = abrir("c-geral");
    digitar(campo, "@a");
    fireEvent.keyDown(campo, { key: "Escape" });
    digitar(campo, "@an");
    expect(screen.queryByTestId("menu-de-mencao")).not.toBeInTheDocument();
    // E um @ NOVO abre de novo.
    digitar(campo, "@an @");
    expect(screen.getByTestId("menu-de-mencao")).toBeInTheDocument();
  });

  it("no canal DIRETO não há a quem marcar: o @ é só um caractere", () => {
    const campo = abrir("c-bia");
    digitar(campo, "@");
    expect(screen.queryByTestId("menu-de-mencao")).not.toBeInTheDocument();
  });
});

describe("a mensagem que chega", () => {
  const ana = { tipo: "pessoa", user_id: "u-ana", nome: "Ana Souza" };
  const eu = { tipo: "pessoa", user_id: "u-eu", nome: "Eu Mesmo" };

  it("mostra o nome marcado em destaque", () => {
    mensagens = [
      { id: "m1", channel_id: "c-geral", sender_user_id: "u-caio", sender_name: "Caio", body: "oi @Ana Souza, tudo bem?", mentions: [ana], created_at: new Date().toISOString() },
    ];
    abrir("c-geral");
    const marcas = screen.getAllByTestId("mencao");
    expect(marcas).toHaveLength(1);
    expect(marcas[0]).toHaveTextContent("@Ana Souza");
    expect(marcas[0]).not.toHaveAttribute("data-comigo");
  });

  it("destaca mais a marcação que ME inclui — e o @todos também me inclui", () => {
    mensagens = [
      { id: "m1", channel_id: "c-geral", sender_user_id: "u-caio", sender_name: "Caio", body: "@Eu Mesmo olha", mentions: [eu], created_at: new Date().toISOString() },
      { id: "m2", channel_id: "c-geral", sender_user_id: "u-caio", sender_name: "Caio", body: "@todos reunião", mentions: [{ tipo: "todos" }], created_at: new Date().toISOString() },
    ];
    abrir("c-geral");
    for (const m of screen.getAllByTestId("mencao")) expect(m).toHaveAttribute("data-comigo", "true");
  });

  it("mensagem antiga, sem `mentions`, aparece como texto puro", () => {
    mensagens = [
      { id: "m1", channel_id: "c-geral", sender_user_id: "u-caio", sender_name: "Caio", body: "oi @Ana Souza", created_at: new Date().toISOString() },
    ];
    abrir("c-geral");
    expect(screen.queryByTestId("mencao")).not.toBeInTheDocument();
    expect(screen.getByText("oi @Ana Souza")).toBeInTheDocument();
  });
});
