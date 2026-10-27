"use client";
import { Droppable } from "@hello-pangea/dnd";
import type { CSSProperties } from "react";
import { useT } from "@/hooks/i18n/useT";
import { cn } from "@/lib/utils";
import type { Lead } from "@/lib/types/leads";
import type { Stage } from "@/lib/kanban/types";
import { buildCardInput } from "@/lib/kanban/card-state";
import { corDaEtapa } from "@/lib/kanban/cor-da-etapa";
import { CheckCircle, X } from "@/lib/ui/icons";
import { KanbanCard } from "./KanbanCard";

interface StageColumnProps {
  stage: Stage;
  leads: Lead[];
  pipelineId: string;
  /** owner_user_id → nome, resolvido no board. O dono agente vem no lead. */
  ownerNames?: Map<string, string | null>;
  /** ids que o radar classificou como esfriando (fonte única, não recalculada). */
  coolingIds?: Set<string>;
  /** Propostas de retomada vivas, por lead. */
  reactivations?: Map<string, { proposalId: string; expiresAt: string }>;
  /** `settings.canonical_tags` do pipeline — a única tag que fica no card. */
  canonicalTags?: string[];
  selectedLeadIds?: Set<string>;
  /** leadId → quantos eventos remotos já chegaram (muda = pulsa de novo). */
  pulses?: Map<string, number>;
  onSelect?: (leadId: string, additive: boolean) => void;
  /** Abrir o dossiê — atravessa o board até o card, como `pulses`. */
  onOpen?: (leadId: string) => void;
  /** Posição desta etapa entre as ABERTAS (ganho e perda ficam de fora). Define o tom da coluna. */
  posicaoEntreAbertas?: number;
  /** Quantas etapas abertas o funil tem. */
  totalAbertas?: number;
}

function formatBRL(cents: number): string {
  try {
    return new Intl.NumberFormat("pt-BR", {
      style: "currency",
      currency: "BRL",
      maximumFractionDigits: 0,
    }).format(cents / 100);
  } catch {
    return `R$ ${(cents / 100).toFixed(0)}`;
  }
}

export function StageColumn({
  stage,
  leads,
  pipelineId,
  ownerNames,
  coolingIds,
  reactivations,
  canonicalTags,
  selectedLeadIds,
  pulses,
  onSelect,
  onOpen,
  posicaoEntreAbertas = 0,
  totalAbertas = 1,
}: StageColumnProps) {
  const t = useT();
  const totalCents = leads.reduce((sum, l) => sum + (l.value_cents ?? 0), 0);
  // A cor da coluna: a que o operador escolheu, ou a do papel da etapa (ganho/perda/progressão).
  const cor = corDaEtapa(stage, posicaoEntreAbertas, totalAbertas);
  const accentStyle: CSSProperties = { backgroundColor: cor };
  // A faixa de cima é o que faz a coluna ler de longe; o ponto ao lado do nome fica para quem está perto.
  const faixaStyle: CSSProperties = { borderTopColor: cor, borderTopWidth: 3 };

  return (
    <div
      data-testid="coluna-do-funil"
      className="flex min-h-0 w-80 shrink-0 flex-col rounded-lg border border-border bg-surface-muted/40"
      style={faixaStyle}
    >
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2.5">
        <span className="h-2 w-2 rounded-full" style={accentStyle} aria-hidden />
        <h2 className="flex-1 truncate text-sm font-semibold text-text">
          {stage.name}
        </h2>
        {/* A cor não vai sozinha: etapa de ganho e de perda também têm ícone e texto para quem não
            distingue verde de vermelho (ou usa leitor de tela). */}
        {stage.is_won ? (
          <span className="inline-flex items-center text-success-fg" title={t("Etapa de ganho")}>
            <CheckCircle size={14} weight="fill" aria-hidden />
            <span className="sr-only">{t("Etapa de ganho")}</span>
          </span>
        ) : stage.is_lost ? (
          <span className="inline-flex items-center text-error-fg" title={t("Etapa de perda")}>
            <X size={14} weight="bold" aria-hidden />
            <span className="sr-only">{t("Etapa de perda")}</span>
          </span>
        ) : null}
        <span className="rounded-full bg-surface px-2 py-0.5 text-[11px] font-medium tabular-nums text-text-muted">
          {leads.length}
        </span>
      </div>

      {totalCents > 0 && (
        <div className="shrink-0 border-b border-border px-3 py-1.5 text-[11px] tabular-nums text-text-muted">
          {formatBRL(totalCents)}
        </div>
      )}

      <Droppable droppableId={stage.id} type="LEAD">
        {(provided, snapshot) => (
          <div
            ref={provided.innerRef}
            {...provided.droppableProps}
            data-testid="lista-da-coluna"
            // Cada coluna rola SOZINHA: o título e o total ficam parados em cima e só a lista de cards
            // desce. O Droppable é o próprio contêiner de rolagem de propósito — a biblioteca de
            // arrastar só sabe rolar sozinha um contêiner que seja o Droppable (ou pai dele).
            // `[&>*]:shrink-0`: numa coluna flex com teto, o padrão do flex é ENCOLHER cada card
            // para caber — sem isto 87 cards viram 87 tiras de título cortado em vez de rolar.
            // SEM `overscroll-contain`, de propósito: ele impede a rolagem de passar da lista para o
            // quadro, e aí a roda lateral (ou Shift+roda) com o mouse sobre uma coluna — onde o mouse
            // está quase sempre — deixava de rolar o quadro. Medido: 0px com ele, 400px sem.
            className={cn(
              "flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-2 transition-colors [&>*]:shrink-0",
              snapshot.isDraggingOver && "bg-accent/5",
            )}
          >
            {leads.map((lead, idx) => (
              <KanbanCard
                key={lead.id}
                card={buildCardInput(lead, {
                  stageName: stage.name,
                  ownerNames,
                  coolingIds,
                  reactivations,
                  canonicalTags,
                })}
                lead={lead}
                index={idx}
                pipelineId={pipelineId}
                isSelected={selectedLeadIds?.has(lead.id)}
                pulseCount={pulses?.get(lead.id) ?? 0}
                onSelect={onSelect}
                onOpen={onOpen}
              />
            ))}
            {provided.placeholder}
            {leads.length === 0 && !snapshot.isDraggingOver && (
              <div className="flex h-20 items-center justify-center text-[11px] text-text-muted">
                {t("vazio")}
              </div>
            )}
          </div>
        )}
      </Droppable>
    </div>
  );
}
