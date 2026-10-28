/**
 * O CARD DO FUNIL, SEM OS BURACOS — e com o que o vendedor procura.
 *
 * O card tinha altura reservada para tudo (título de 2 linhas, faixa do agente mesmo vazia, "—" no
 * lugar do valor) e ficava meio vazio. As promessas desta mudança, uma a uma:
 *
 *  1. o valor nunca é um traço: sem valor é "R$ 0,00", e com valor também leva os centavos;
 *  2. a faixa do agente SOME quando não há nada a dizer, e o título não reserva a 2ª linha;
 *  3. telefone, tags, prazo e origem aparecem — e só quando existem;
 *  4. a última mensagem diz QUEM falou (cliente × nós);
 *  5. o dado chega: a rota do quadro traz direção e tipo da última mensagem, e as cores das tags
 *     percorrem quadro → coluna → card.
 */
import { readFileSync } from "node:fs";

import { DragDropContext, Droppable } from "@hello-pangea/dnd";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { KanbanCard } from "@/components/kanban/KanbanCard";
import { buildCardInput } from "@/lib/kanban/card-state";
import type { CorDeMarcador } from "@/lib/schemas/settings";
import type { Lead } from "@/lib/types/leads";

vi.mock("@/components/contacts/AvatarDoContato", () => ({
  AvatarDoContato: () => <span data-testid="rosto" />,
}));
vi.mock("@/components/kanban/KanbanCardActions", () => ({ KanbanCardActions: () => null }));
vi.mock("@/components/kanban/NextActionSlot", () => ({ NextActionSlot: () => null }));
vi.mock("@/components/kanban/ReactivationSlot", () => ({ ReactivationSlot: () => null }));
vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));

// 28/10/2026, meio-dia: o "hoje" dos prazos.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 9, 28, 12, 0, 0));
});
afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

function lead(over: Partial<Lead> = {}): Lead {
  return {
    id: "lead-1",
    organization_id: "org",
    pipeline_id: "pipe",
    stage_id: "stage",
    contact_id: "ct-1",
    title: "Orçamento do portão",
    description: null,
    status: "open",
    lost_reason: null,
    position_in_stage: 1,
    value_cents: 150_000,
    currency: "BRL",
    commit_probability_pct: null,
    owner_user_id: null,
    owner_kind: null,
    owner_agent_id: null,
    source: "manual",
    expected_close_date: null,
    tags: [],
    created_at: "2026-10-27T10:00:00Z",
    updated_at: "2026-10-27T10:00:00Z",
    ...over,
  } as unknown as Lead;
}

const contato = (over: Record<string, unknown> = {}) => ({
  id: "ct-1",
  display_name: "Maria Souza",
  name: null,
  phone_number: "+5511999990000",
  avatar_storage_path: null,
  is_anonymized: false,
  ...over,
});

function pintar(l: Lead, props: { coresDasTags?: ReadonlyMap<string, CorDeMarcador>; canonicalTags?: string[] } = {}) {
  const card = buildCardInput(l, {
    stageName: "Negociação",
    ownerNames: undefined,
    canonicalTags: props.canonicalTags,
  });
  return render(
    <DragDropContext onDragEnd={() => {}}>
      <Droppable droppableId="stage" type="LEAD">
        {(provided) => (
          <div ref={provided.innerRef} {...provided.droppableProps}>
            <KanbanCard
              card={card}
              lead={l}
              index={0}
              pipelineId="pipe"
              coresDasTags={props.coresDasTags}
            />
            {provided.placeholder}
          </div>
        )}
      </Droppable>
    </DragDropContext>,
  );
}

describe("o valor nunca é um traço", () => {
  it("sem valor cadastrado: 'R$ 0,00', em tom apagado", () => {
    pintar(lead({ value_cents: null }));
    const valor = screen.getByTestId("valor-do-card");
    expect(valor.textContent?.replace(/\s/g, " ")).toBe("R$ 0,00");
    expect(valor).toHaveAttribute("data-sem-valor", "true");
    // O tom apagado É o aviso de "ninguém preencheu": o atributo sozinho não pinta nada.
    expect(valor.className).toContain("text-text-muted");
    expect(screen.queryByText("—")).not.toBeInTheDocument();
  });

  it("com valor: leva os centavos, para não parecer outro formato de dinheiro ao lado do R$ 0,00", () => {
    pintar(lead({ value_cents: 120_000 }));
    const valor = screen.getByTestId("valor-do-card");
    expect(valor.textContent?.replace(/\s/g, " ")).toBe("R$ 1.200,00");
    expect(valor).not.toHaveAttribute("data-sem-valor");
    expect(valor.className).not.toContain("text-text-muted");
  });

  it("valor 0 (cadastrado) também aparece como R$ 0,00, mas NÃO apagado: alguém digitou", () => {
    pintar(lead({ value_cents: 0 }));
    expect(screen.getByTestId("valor-do-card")).not.toHaveAttribute("data-sem-valor");
  });
});

describe("sem os buracos", () => {
  it("o título não reserva a segunda linha (sem altura fixa)", () => {
    const { container } = pintar(lead({ contato: contato() }));
    const h3 = container.querySelector("h3") as HTMLElement;
    expect(h3.className).not.toMatch(/\bh-10\b/);
  });

  it("sem sinal de IA a faixa do agente NÃO existe", () => {
    const { container } = pintar(lead({ contato: contato() }));
    // O card sem score/ação/esfriando é `idle`: nenhum slot de h-6 entre o rosto e o rodapé.
    expect(container.querySelector(".h-6.items-center.gap-2")).toBeNull();
  });

  it("com score a faixa aparece (o anel de probabilidade)", () => {
    const { container } = pintar(
      lead({
        contato: contato(),
        score: { probability: 37, reason: "r", band: "morno", factors: [], at: null },
      }),
    );
    expect(container.querySelector("[data-anel-arco]")).not.toBeNull();
  });
});

describe("telefone, tags, prazo e origem — só quando existem", () => {
  it("telefone do cliente embaixo do nome, formatado", () => {
    pintar(lead({ contato: contato() }));
    expect(screen.getByTestId("telefone-do-card").textContent).toMatch(/99999[- ]?0000/);
  });

  it("sem contato (lead à mão) ou anonimizado (sem telefone): a linha não existe", () => {
    pintar(lead({ contact_id: null, contato: undefined }));
    expect(screen.queryByTestId("telefone-do-card")).not.toBeInTheDocument();
    cleanup();
    pintar(lead({ contato: contato({ phone_number: null, is_anonymized: true }) }));
    expect(screen.queryByTestId("telefone-do-card")).not.toBeInTheDocument();
  });

  it("tags viram chips, com a cor do marcador da empresa", () => {
    const cores = new Map<string, CorDeMarcador>([["VIP", "vermelho" as CorDeMarcador]]);
    pintar(lead({ tags: ["VIP", "novo"] }), { coresDasTags: cores });
    const chips = screen.getByTestId("tags-do-card");
    expect(within(chips).getByText("VIP")).toBeInTheDocument();
    expect(within(chips).getByText("novo")).toBeInTheDocument();
  });

  it("mais tags que o teto: sobra vira '+N'", () => {
    pintar(lead({ tags: ["a", "b", "c", "d", "e"] }));
    expect(within(screen.getByTestId("tags-do-card")).getByText("+2")).toBeInTheDocument();
  });

  it("a tag canônica do pipeline vem primeiro", () => {
    pintar(lead({ tags: ["a", "b", "quente"] }), { canonicalTags: ["quente"] });
    const chips = screen.getByTestId("tags-do-card");
    expect(chips.firstElementChild?.textContent).toBe("quente");
  });

  it("sem tags, a linha não existe", () => {
    pintar(lead({ tags: [] }));
    expect(screen.queryByTestId("tags-do-card")).not.toBeInTheDocument();
  });

  it("prazo: 'Fecha em 3 dias' perto, e vermelho quando atrasado", () => {
    pintar(lead({ expected_close_date: "2026-10-31" }));
    const perto = screen.getByText("Fecha em 3 dias");
    expect(perto.closest("[data-faixa-do-prazo]")).toHaveAttribute("data-faixa-do-prazo", "proximo");
    cleanup();
    pintar(lead({ expected_close_date: "2026-10-26" }));
    const atrasado = screen.getByText("Atrasado há 2 dias");
    expect(atrasado.closest("[data-faixa-do-prazo]")).toHaveAttribute("data-faixa-do-prazo", "atrasado");
  });

  it("prazo de negócio já ganho ou perdido não aparece — a data prevista já não decide nada", () => {
    pintar(lead({ expected_close_date: "2026-10-26", status: "won" }));
    expect(screen.queryByText(/Atrasado/)).not.toBeInTheDocument();
  });

  it("origem: o nome legível, com o rótulo de leitor de tela", () => {
    pintar(lead({ source: "import" }));
    const linha = screen.getByTestId("origem-e-prazo");
    expect(within(linha).getByText("Importado")).toBeInTheDocument();
    expect(linha.querySelector("[data-origem]")).toHaveAttribute("data-origem", "importada");
  });
});

describe("a última mensagem diz QUEM falou", () => {
  const conversa = (over: Partial<NonNullable<Lead["conversa"]>>) =>
    ({
      id: "conv-1",
      preview: "ah blz",
      last_message_at: new Date(2026, 9, 28, 11, 30, 0).toISOString(),
      unread: 0,
      ...over,
    }) as NonNullable<Lead["conversa"]>;

  it("do cliente: 'Cliente:' em destaque", () => {
    pintar(lead({ contato: contato(), conversa: conversa({ direction: "inbound" }) }));
    const quem = screen.getByTestId("quem-falou");
    expect(quem).toHaveTextContent("Cliente:");
    expect(quem).toHaveAttribute("data-direcao", "inbound");
    expect(quem.className).toContain("font-medium");
  });

  it("nossa: 'Você:' no tom da linha", () => {
    pintar(lead({ contato: contato(), conversa: conversa({ direction: "outbound" }) }));
    const quem = screen.getByTestId("quem-falou");
    expect(quem).toHaveTextContent("Você:");
    expect(quem.className).not.toContain("font-medium");
  });

  it("sem direção conhecida (conversa de antes da 0219) o card não afirma quem foi", () => {
    pintar(lead({ contato: contato(), conversa: conversa({ direction: null }) }));
    expect(screen.queryByTestId("quem-falou")).not.toBeInTheDocument();
    expect(screen.getByText("ah blz")).toBeInTheDocument();
  });

  it("áudio aparece como 'Áudio', não como o literal [audio]", () => {
    pintar(
      lead({
        contato: contato(),
        conversa: conversa({ direction: "inbound", type: "audio", preview: "[audio]" }),
      }),
    );
    expect(screen.queryByText("[audio]")).not.toBeInTheDocument();
    expect(screen.getByText("Áudio")).toBeInTheDocument();
  });

  it("a hora da última mensagem aparece", () => {
    pintar(lead({ contato: contato(), conversa: conversa({ direction: "inbound" }) }));
    expect(screen.getByText("11:30")).toBeInTheDocument();
  });
});

describe("as costuras do dado", () => {
  const rota = readFileSync("app/api/v1/pipelines/[id]/board/route.ts", "utf8");

  it("a rota do quadro lê direção e tipo da última mensagem e os entrega na conversa", () => {
    const bloco = /async function withConversas[\s\S]*?\n}\n/.exec(rota)?.[0] ?? "";
    expect(bloco).toContain("last_message_direction");
    expect(bloco).toContain("last_message_type");
    expect(bloco).toMatch(/direction:\s*row\.last_message_direction/);
    expect(bloco).toMatch(/type:\s*row\.last_message_type/);
  });

  it("as cores das tags percorrem quadro → coluna → card", () => {
    const quadro = readFileSync("components/kanban/KanbanBoard.tsx", "utf8");
    const coluna = readFileSync("components/kanban/StageColumn.tsx", "utf8");
    expect(quadro).toContain("useConversationTagVocabulary");
    expect(quadro).toMatch(/coresDasTags=\{coresDasTags\}/);
    expect(coluna).toMatch(/coresDasTags=\{coresDasTags\}/);
  });
});
