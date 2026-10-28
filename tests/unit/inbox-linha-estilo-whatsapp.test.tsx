/**
 * A linha da lista de conversas, no jeito do WhatsApp (pedido do dono, 2026-10-28).
 *
 * As REGRAS (hora, "Você:", rótulo de mídia, estado do tique) estão em
 * `lib/inbox/linha-da-conversa.test.ts`. Aqui se mede o que só o componente decide: o que aparece na
 * tela quando a regra diz "mostre", e — metade dos casos — o que NÃO aparece. Linha densa é a
 * ideia: a terceira linha só existe quando há algo do CRM a dizer, e "Você:" some quando o tique já
 * diz que a mensagem é nossa.
 */
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { format } from "date-fns";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";

import type * as CanaisModule from "@/hooks/channels/useChannelSessions";
import { ConversationListItem } from "@/components/inbox/ConversationListItem";
import { InboxFilters, type InboxFiltersValue } from "@/components/inbox/InboxFilters";
import type { ConversationWithContact } from "@/hooks/inbox/useConversationsRealtime";
import type { ActiveOrg } from "@/lib/auth/types";
import type { CorDeMarcador } from "@/lib/schemas/settings";

vi.mock("@/hooks/setores/useSetores", () => ({
  useSetores: () => ({ data: [], isLoading: false }),
  useMapaDeSetores: () => new Map(),
}));
vi.mock("@/hooks/auth/AuthProvider", () => ({
  useAuth: () => ({
    activeOrg: { orgId: "org-1", name: "Org", role: "manager", visibility_mode: "all" } satisfies ActiveOrg,
  }),
}));
vi.mock("@/hooks/channels/useChannelSessions", async (original) => {
  const real = await original<typeof CanaisModule>();
  return { ...real, useChannelSessions: () => ({ data: [] }) };
});
vi.mock("@/hooks/inbox/useConversationTags", () => ({
  useConversationTagVocabulary: () => ({ data: [] }),
}));
vi.mock("@/hooks/inbox/useConversationCounts", () => ({
  useConversationCounts: () => ({ data: { fila: 4, mine: 2, all: 9, grupos: 1, automatico: 3 } }),
}));

afterEach(cleanup);

const agora = () => new Date().toISOString();

function conversa(over: Record<string, unknown> = {}): ConversationWithContact {
  return {
    id: "c1",
    organization_id: "org",
    contact_id: "ct1",
    channel_session_id: "s1",
    channel: "whatsapp",
    status: "open",
    is_group: false,
    last_message_at: agora(),
    last_message_preview: "olá, tudo bem?",
    last_message_direction: "inbound",
    last_message_type: "text",
    last_message_status: "delivered",
    unread_count_for_assignee: 0,
    created_at: agora(),
    contacts: {
      id: "ct1",
      display_name: "Cliente",
      name: null,
      phone_number: "+595999",
      tags: [],
      is_blocked: false,
      is_anonymized: false,
    },
    ...over,
  } as unknown as ConversationWithContact;
}

const pintar = (c: ConversationWithContact, extra: Record<string, unknown> = {}) =>
  render(<ConversationListItem conversation={c} isSelected={false} onSelect={() => {}} {...extra} />);

describe("a hora, no formato do WhatsApp", () => {
  it("mensagem de hoje: só a hora", () => {
    const iso = agora();
    pintar(conversa({ last_message_at: iso }));
    expect(screen.getByTestId("hora-da-conversa")).toHaveTextContent(format(new Date(iso), "HH:mm"));
  });

  it("mensagem de ontem: 'Ontem'", () => {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    pintar(conversa({ last_message_at: d.toISOString() }));
    expect(screen.getByTestId("hora-da-conversa")).toHaveTextContent("Ontem");
  });

  it("mensagem de 3 semanas atrás: a data completa", () => {
    const d = new Date();
    d.setDate(d.getDate() - 21);
    pintar(conversa({ last_message_at: d.toISOString() }));
    expect(screen.getByTestId("hora-da-conversa")).toHaveTextContent(format(d, "dd/MM/yyyy"));
  });

  it("com mensagem não lida, a hora fica verde; sem, fica quieta", () => {
    pintar(conversa({ unread_count_for_assignee: 2 }));
    expect(screen.getByTestId("hora-da-conversa").className).toContain("text-success-fg");
    cleanup();
    pintar(conversa({ unread_count_for_assignee: 0 }));
    expect(screen.getByTestId("hora-da-conversa").className).not.toContain("text-success-fg");
  });
});

describe("o contador de não lidas", () => {
  it("mostra o número e o diz por extenso a quem usa leitor de tela", () => {
    pintar(conversa({ unread_count_for_assignee: 7 }));
    const c = screen.getByTestId("nao-lidas");
    expect(c).toHaveTextContent("7");
    expect(c).toHaveAttribute("aria-label", "7 mensagens não lidas");
  });

  it("acima de 99 vira '99+' — o círculo não cresce sem fim", () => {
    pintar(conversa({ unread_count_for_assignee: 340 }));
    expect(screen.getByTestId("nao-lidas")).toHaveTextContent("99+");
  });

  it("zero não desenha contador", () => {
    pintar(conversa({ unread_count_for_assignee: 0 }));
    expect(screen.queryByTestId("nao-lidas")).not.toBeInTheDocument();
  });
});

describe("a prévia: quem falou, o tipo e o tique", () => {
  it("mensagem do cliente: o texto, sem 'Você:' e sem tique", () => {
    pintar(conversa());
    expect(screen.getByTestId("previa-da-conversa")).toHaveTextContent("olá, tudo bem?");
    expect(screen.queryByText("Você:")).not.toBeInTheDocument();
    expect(screen.queryByRole("img", { name: /Enviada|Entregue|Lida/ })).not.toBeInTheDocument();
  });

  it.each([
    ["sent", "Enviada"],
    ["delivered", "Entregue"],
    ["read", "Lida"],
    ["queued", "Na fila para enviar"],
    ["failed", "Falhou ao enviar"],
  ])("mensagem nossa com status %s: o tique '%s'", (status, nome) => {
    pintar(
      conversa({ last_message_direction: "outbound", last_message_status: status, last_message_preview: "combinado" }),
    );
    expect(screen.getByRole("img", { name: nome })).toBeInTheDocument();
  });

  it("✓✓ lida é azul e ✓✓ entregue é cinza — a cor separa o que o formato não separa", () => {
    pintar(conversa({ last_message_direction: "outbound", last_message_status: "read" }));
    expect(screen.getByRole("img", { name: "Lida" }).className).toContain("text-info");
    cleanup();
    pintar(conversa({ last_message_direction: "outbound", last_message_status: "delivered" }));
    expect(screen.getByRole("img", { name: "Entregue" }).className).not.toContain("text-info");
  });

  it("com o tique à vista, 'Você:' não repete a informação (conversa 1 a 1)", () => {
    pintar(conversa({ last_message_direction: "outbound", last_message_status: "read" }));
    expect(screen.queryByText("Você:")).not.toBeInTheDocument();
  });

  it("sem status conhecido, 'Você:' é o que diz que a mensagem é nossa", () => {
    pintar(conversa({ last_message_direction: "outbound", last_message_status: null }));
    expect(screen.getByText("Você:")).toBeInTheDocument();
  });

  it("em grupo, 'Você:' fica mesmo com o tique — em grupo dizer QUEM falou importa", () => {
    pintar(
      conversa({ is_group: true, last_message_direction: "outbound", last_message_status: "read" }),
    );
    expect(screen.getByText("Você:")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Lida" })).toBeInTheDocument();
  });

  it("áudio gravado como '[audio]' aparece como 'Áudio', e os colchetes não chegam à tela", () => {
    pintar(
      conversa({ last_message_type: "audio", last_message_preview: "[audio]", last_message_direction: "outbound" }),
    );
    expect(screen.getByTestId("previa-da-conversa")).toHaveTextContent("Áudio");
    expect(screen.queryByText("[audio]")).not.toBeInTheDocument();
  });

  it("foto com legenda mostra a legenda", () => {
    pintar(conversa({ last_message_type: "image", last_message_preview: "olha o orçamento" }));
    expect(screen.getByTestId("previa-da-conversa")).toHaveTextContent("olha o orçamento");
  });

  it("conversa sem mensagem: 'Sem mensagens'", () => {
    pintar(
      conversa({
        last_message_preview: null,
        last_message_type: null,
        last_message_direction: null,
        last_message_status: null,
      }),
    );
    expect(screen.getByTestId("previa-da-conversa")).toHaveTextContent("Sem mensagens");
  });

  it("a prévia longa é cortada pela largura (CSS), não por um número fixo de letras", () => {
    const longa = "x".repeat(200);
    pintar(conversa({ last_message_preview: longa }));
    const previa = screen.getByTestId("previa-da-conversa");
    expect(previa).toHaveTextContent(longa);
    expect(previa.className).toContain("truncate");
  });
});

describe("a terceira linha só existe quando há algo do CRM a dizer", () => {
  it("conversa comum: duas linhas, como o WhatsApp", () => {
    pintar(conversa());
    expect(screen.queryByTestId("detalhes-da-conversa")).not.toBeInTheDocument();
  });

  it("na fila: a posição e a espera continuam, com o aria-label de sempre", () => {
    pintar(conversa(), { queuePosition: 2 });
    const detalhes = screen.getByTestId("detalhes-da-conversa");
    expect(within(detalhes).getByLabelText("Posição 2 na fila")).toBeInTheDocument();
  });

  it("tag aparece como etiqueta colorida com a cor do marcador da empresa", () => {
    const cores = new Map<string, CorDeMarcador>([["vip", "vermelho"]]);
    pintar(
      conversa({
        contacts: {
          id: "ct1",
          display_name: "Cliente",
          name: null,
          phone_number: "+595999",
          tags: ["vip", "novo"],
          is_blocked: false,
          is_anonymized: false,
        },
      }),
      { coresDasTags: cores },
    );
    expect(screen.getByText("vip").className).toContain("bg-red-500/15");
    // Tag que não está no vocabulário (nasceu digitada) cai no cinza — o mesmo do editor de tags.
    expect(screen.getByText("novo").className).toContain("bg-zinc-500/15");
  });

  it.each([
    ["is_blocked", "Bloqueado"],
    ["is_anonymized", "Anonimizado"],
  ])("contato com %s: o aviso '%s' continua aparecendo — e ele sozinho abre a terceira linha", (campo, aviso) => {
    pintar(
      conversa({
        contacts: {
          id: "ct1",
          display_name: "Cliente",
          name: null,
          phone_number: "+595999",
          tags: [],
          is_blocked: false,
          is_anonymized: false,
          [campo]: true,
        },
      }),
    );
    const detalhes = screen.getByTestId("detalhes-da-conversa");
    expect(within(detalhes).getByText(aviso)).toBeInTheDocument();
  });

  it("o selo do número só abre a terceira linha quando há mais de um número (mostrarCanal)", () => {
    const comCanal = conversa({ channel_sessions: { phone_number: "+19392301037", display_name: null, provider: null } });
    pintar(comCanal, { mostrarCanal: false });
    expect(screen.queryByTestId("detalhes-da-conversa")).not.toBeInTheDocument();
    cleanup();
    pintar(comCanal, { mostrarCanal: true });
    expect(within(screen.getByTestId("detalhes-da-conversa")).getByText("+19392301037")).toBeInTheDocument();
  });
});

describe("os filtros em chips", () => {
  const VALUE: InboxFiltersValue = { tab: "unassigned", search: "", onlyUnread: false };
  let onChange: Mock<(next: InboxFiltersValue) => void>;
  beforeEach(() => {
    onChange = vi.fn<(next: InboxFiltersValue) => void>();
  });

  it("Fila, Minhas e Grupos estão à vista, e só a visão atual está pressionada", () => {
    render(<InboxFilters value={VALUE} onChange={onChange} />);
    expect(screen.getByTestId("chip-unassigned")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("chip-mine")).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByTestId("chip-grupos")).toHaveAttribute("aria-pressed", "false");
  });

  it("a contagem da visão aparece dentro do chip", () => {
    render(<InboxFilters value={VALUE} onChange={onChange} />);
    expect(screen.getByTestId("chip-unassigned")).toHaveTextContent("4");
    expect(screen.getByTestId("chip-mine")).toHaveTextContent("2");
  });

  it("clicar num chip troca a visão e preserva o resto do filtro", async () => {
    render(<InboxFilters value={{ ...VALUE, onlyUnread: true, tag: "vip" }} onChange={onChange} />);
    await userEvent.click(screen.getByTestId("chip-mine"));
    expect(onChange).toHaveBeenCalledWith({ ...VALUE, tab: "mine", onlyUnread: true, tag: "vip" });
  });

  it("'Não lidas' liga e desliga o filtro de não lidas, sem mexer na visão", async () => {
    const { rerender } = render(<InboxFilters value={VALUE} onChange={onChange} />);
    expect(screen.getByTestId("chip-nao-lidas")).toHaveAttribute("aria-pressed", "false");
    await userEvent.click(screen.getByTestId("chip-nao-lidas"));
    expect(onChange).toHaveBeenLastCalledWith({ ...VALUE, onlyUnread: true });

    rerender(<InboxFilters value={{ ...VALUE, onlyUnread: true }} onChange={onChange} />);
    expect(screen.getByTestId("chip-nao-lidas")).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(screen.getByTestId("chip-nao-lidas"));
    expect(onChange).toHaveBeenLastCalledWith({ ...VALUE, onlyUnread: false });
  });

  it("visão que não tem chip (Todas) aparece no gatilho do menu, destacada, com a contagem", () => {
    render(<InboxFilters value={{ ...VALUE, tab: "all" }} onChange={onChange} />);
    const gatilho = screen.getByTestId("visao-do-inbox");
    expect(gatilho).toHaveAttribute("aria-pressed", "true");
    expect(gatilho).toHaveTextContent("Todas");
    expect(gatilho).toHaveTextContent("9");
    // Nenhum chip fica pressionado: a visão atual não é nenhum deles.
    expect(screen.getByTestId("chip-unassigned")).toHaveAttribute("aria-pressed", "false");
  });

  it("o menu continua listando TODAS as visões — nenhuma fica invisível", async () => {
    render(<InboxFilters value={VALUE} onChange={onChange} />);
    await userEvent.click(screen.getByTestId("visao-do-inbox"));
    for (const nome of [/Fila/, /Minhas/, /Todas/, /Grupos/, /Arquivadas/, /Automático/]) {
      expect(screen.getByRole("menuitem", { name: nome })).toBeInTheDocument();
    }
  });

  it("escolher uma visão no menu a aplica", async () => {
    render(<InboxFilters value={VALUE} onChange={onChange} />);
    await userEvent.click(screen.getByTestId("visao-do-inbox"));
    await userEvent.click(screen.getByRole("menuitem", { name: /Arquivadas/ }));
    expect(onChange).toHaveBeenCalledWith({ ...VALUE, tab: "closed" });
  });

  it("a busca continua achável pelo nome e o interruptor antigo saiu", () => {
    render(<InboxFilters value={VALUE} onChange={onChange} />);
    expect(screen.getByLabelText("Buscar conversas")).toBeInTheDocument();
    expect(screen.queryByLabelText("Apenas não lidos")).not.toBeInTheDocument();
  });
});
