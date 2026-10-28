/**
 * O CARD DO FUNIL NO DESENHO NOVO — o rosto do cliente, o anel de probabilidade e as costuras de dado.
 *
 * Três promessas que "renderiza sem erro" não segura:
 *
 *  1. o rosto é do CLIENTE (não do dono do negócio) e nunca falta: lead sem contato usa o título;
 *  2. o dado do rosto chega da rota — a coluna do SELECT, a ordem na cadeia (a resposta continua
 *     saindo de `leadsComConversa`) e a recusa de anonimizado na origem;
 *  3. o anel desenha o número, contido em 0–100.
 *
 * `AvatarDoContato` é dublado de propósito: o Radix só renderiza a `<img>` depois que ela CARREGA, e
 * jsdom não carrega imagem — o que se mede aqui é O QUE O CARD ENTREGA ao rosto.
 */
import { readFileSync } from "node:fs";

import { DragDropContext, Droppable } from "@hello-pangea/dnd";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { KanbanCard } from "@/components/kanban/KanbanCard";
import { AnelDeProbabilidade } from "@/components/kanban/ScoreSlot";
import { buildCardInput } from "@/lib/kanban/card-state";
import type { Lead } from "@/lib/types/leads";

const rosto = vi.hoisted(() => ({ ultimo: null as null | Record<string, unknown> }));

vi.mock("@/components/contacts/AvatarDoContato", () => ({
  AvatarDoContato: (props: Record<string, unknown>) => {
    rosto.ultimo = props;
    return <span data-testid="rosto">{String(props.nome)}</span>;
  },
}));
vi.mock("@/components/kanban/KanbanCardActions", () => ({ KanbanCardActions: () => null }));
vi.mock("@/components/kanban/NextActionSlot", () => ({ NextActionSlot: () => null }));
vi.mock("@/components/kanban/ReactivationSlot", () => ({ ReactivationSlot: () => null }));
vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));

afterEach(() => {
  cleanup();
  rosto.ultimo = null;
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
    tags: [],
    created_at: "2026-10-01T10:00:00Z",
    updated_at: "2026-10-01T10:00:00Z",
    ...over,
  } as unknown as Lead;
}

function pintar(l: Lead) {
  const card = buildCardInput(l, { stageName: "Negociação", ownerNames: undefined });
  return render(
    <DragDropContext onDragEnd={() => {}}>
      <Droppable droppableId="stage" type="LEAD">
        {(provided) => (
          <div ref={provided.innerRef} {...provided.droppableProps}>
            <KanbanCard card={card} lead={l} index={0} pipelineId="pipe" />
            {provided.placeholder}
          </div>
        )}
      </Droppable>
    </DragDropContext>,
  );
}

const contato = (over: Record<string, unknown> = {}) => ({
  id: "ct-1",
  display_name: "Maria Souza",
  name: null,
  phone_number: "+5511999990000",
  avatar_storage_path: "org/ct-1/a.jpg",
  is_anonymized: false,
  ...over,
});

describe("o rosto do card é o do CLIENTE", () => {
  it("lead com contato: o rosto leva o contato e o nome dele — não o título do negócio", () => {
    pintar(lead({ contato: contato() }));
    expect(screen.getByTestId("rosto")).toHaveTextContent("Maria Souza");
    expect(rosto.ultimo?.contato).toMatchObject({ id: "ct-1", avatar_storage_path: "org/ct-1/a.jpg" });
  });

  it("lead SEM contato (à mão, webhook): o título do negócio faz as vezes do nome — o círculo nunca some", () => {
    pintar(lead({ contact_id: null, contato: undefined }));
    expect(screen.getByTestId("rosto")).toHaveTextContent("Orçamento do portão");
    expect(rosto.ultimo?.contato).toBeNull();
  });

  it("contato sem nome: cai no telefone, pela mesma régua do inbox (não numa cadeia à mão)", () => {
    pintar(lead({ contato: contato({ display_name: null, name: null }) }));
    expect(screen.getByTestId("rosto").textContent).not.toBe("");
    expect(screen.getByTestId("rosto").textContent).not.toContain("Orçamento do portão");
  });

  it("o rosto fica ao lado do título, num bloco só — e o título continua sendo o botão que abre o dossiê", () => {
    const { container } = pintar(lead({ contato: contato() }));
    const bloco = container.querySelector('[data-bloco="rosto-e-identidade"]');
    expect(bloco).not.toBeNull();
    expect(bloco?.querySelector('[data-testid="rosto"]')).not.toBeNull();
    expect(bloco?.querySelector("h3 button")).toHaveTextContent("Orçamento do portão");
  });
});

describe("o anel de probabilidade", () => {
  const arco = (p: number, band: "quente" | "morno" | "frio" = "morno") => {
    const { container } = render(<AnelDeProbabilidade probability={p} band={band} />);
    return container.querySelector("[data-anel-arco]") as SVGCircleElement;
  };

  it("desenha o número: 0% é arco vazio, 100% é anel cheio", () => {
    const circ = 2 * Math.PI * 6;
    expect(Number(arco(0).getAttribute("stroke-dashoffset"))).toBeCloseTo(circ);
    cleanup();
    expect(Number(arco(100).getAttribute("stroke-dashoffset"))).toBeCloseTo(0);
    cleanup();
    expect(Number(arco(50).getAttribute("stroke-dashoffset"))).toBeCloseTo(circ / 2);
  });

  it("valor fora de 0–100 é contido — o anel não passa de cheio nem fica 'negativo'", () => {
    expect(arco(180).getAttribute("data-anel-arco")).toBe("100");
    cleanup();
    expect(arco(-20).getAttribute("data-anel-arco")).toBe("0");
  });

  it("a cor vem da FAIXA persistida, não do número", () => {
    expect(arco(90, "frio").getAttribute("class")).toContain("stroke-text-muted");
    cleanup();
    expect(arco(10, "quente").getAttribute("class")).toContain("stroke-accent");
  });
});

describe("as costuras do dado do rosto, na rota do quadro", () => {
  const rota = readFileSync("app/api/v1/pipelines/[id]/board/route.ts", "utf8");

  it("a rota lê o caminho da foto e a marca de anonimizado", () => {
    expect(rota).toMatch(/from\("contacts"\)[\s\S]*?avatar_storage_path[\s\S]*?is_anonymized/);
  });

  it("a linha passa por contatoDoCard — é lá que o anonimizado perde nome, telefone e foto", () => {
    expect(rota).toMatch(/contatoDoCard\(row\)/);
  });

  it("o contato entra ANTES da conversa e a resposta continua saindo do último elo", () => {
    const iContato = rota.indexOf("leadsComContato = await withContatos");
    const iConversa = rota.indexOf("leadsComConversa = await withConversas");
    expect(iContato).toBeGreaterThan(-1);
    expect(iConversa).toBeGreaterThan(iContato);
    // Chamar e não USAR o resultado é o defeito de verdade.
    expect(rota).toMatch(/withConversas\([\s\S]*?leadsComContato\.leads/);
    expect(rota).toMatch(/leads:\s*leadsComConversa\.leads/);
  });

  it("filtra por organização: contato de outro tenant não entra no quadro (a RLS é a segunda cerca)", () => {
    const bloco = /async function withContatos[\s\S]*?\n}\n/.exec(rota)?.[0] ?? "";
    expect(bloco).toContain('.eq("organization_id", organizationId)');
  });

  it("o card entrega ao rosto o contato do lead", () => {
    const card = readFileSync("components/kanban/KanbanCard.tsx", "utf8");
    expect(card).toContain("lead.contato");
    expect(card).toContain("<AvatarDoContato");
  });
});
