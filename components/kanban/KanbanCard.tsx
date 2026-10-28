"use client";
import { Draggable } from "@hello-pangea/dnd";
import type { MouseEvent } from "react";
import { useT } from "@/hooks/i18n/useT";
import { AvatarDoContato } from "@/components/contacts/AvatarDoContato";
import { phoneForDisplay } from "@/lib/channels/phone-variants";
import { rotuloDoContato } from "@/lib/contacts/rotulo-do-contato";
import { cn } from "@/lib/utils";
import type { Lead } from "@/lib/types/leads";
import { resolveCardState, stageAgeLabel, type CardInput } from "@/lib/kanban/card-state";
import { KanbanCardActions } from "./KanbanCardActions";
import { NextActionSlot } from "./NextActionSlot";
import { ReactivationSlot } from "./ReactivationSlot";
import { ConversaSlot } from "./ConversaSlot";
import { ScoreSlot } from "./ScoreSlot";
import { OwnerBadge } from "./OwnerBadge";

interface KanbanCardProps {
  /** O que o card mostra — explicitamente NÃO é a linha do banco. */
  card: CardInput;
  /** A linha do lead, só para o menu de ações (que muta o lead). */
  lead: Lead;
  index: number;
  pipelineId: string;
  isSelected?: boolean;
  /** O painel deste lead está aberto ao lado: o card se destaca, para saber de quem é a conversa. */
  isOpen?: boolean;
  /**
   * Contador de pulsos deste card (evento REMOTO). Muda a cada evento novo — é
   * a MUDANÇA que remonta o overlay e reinicia a animação; um booleano deixaria
   * o segundo evento dentro da janela passar despercebido.
   */
  pulseCount?: number;
  onSelect?: (leadId: string, additive: boolean) => void;
  /** Abrir o dossiê. Separado de `onSelect`: são gestos e intenções diferentes. */
  onOpen?: (leadId: string) => void;
}

function formatBRL(cents: number | null, currency: string | null): string | null {
  if (cents == null) return null;
  const code = currency ?? "BRL";
  try {
    return new Intl.NumberFormat("pt-BR", {
      style: "currency",
      currency: code,
      maximumFractionDigits: 0,
    }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${code}`;
  }
}

/**
 * O card do Kanban — orçamento FIXO: 5 elementos, 3 faixas, altura constante.
 *
 * As alturas são reservadas em vez de derivadas do conteúdo: título sempre
 * ocupa 2 linhas, valor sempre ocupa a sua linha (com "—" quando não há valor),
 * e a faixa do agente existe mesmo vazia. É isso que faz o board continuar
 * legível quando score, próxima ação e alerta chegarem — o card não cresce com
 * dados, ele TROCA de estado.
 *
 * Cor só aparece na borda esquerda, e só quando o estado pede (Lei C).
 */
export function KanbanCard({
  card,
  lead,
  index,
  pipelineId,
  isSelected,
  isOpen,
  pulseCount = 0,
  onSelect,
  onOpen,
}: KanbanCardProps) {
  const t = useT();
  const value = formatBRL(card.valueCents, card.currency);
  const state = resolveCardState(card, t);
  const age = stageAgeLabel(card.hoursInStage, t);
  // O ROSTO é do CLIENTE, não do negócio: a foto dele (ou as iniciais) abre o card. Lead sem contato
  // — criado à mão, vindo de webhook — não tem de quem tirar o nome, e então o título do negócio faz
  // as vezes dele; o card nunca fica sem círculo, senão a coluna perde o alinhamento.
  const contato = lead.contato ?? null;
  const nomeDoRosto = contato ? rotuloDoContato(contato, t) : card.title;
  const reservaDoRosto = contato?.phone_number ? phoneForDisplay(contato.phone_number) : "?";

  // Clique ABRE o dossiê; ctrl/cmd+clique SELECIONA. "Clicar abre" é a
  // convenção mais forte, e seleção múltipla é recurso de poder, que tolera
  // modificador. O arrasto continua funcionando porque o dnd distingue clique
  // de arrasto por movimento, não por handler.
  const handleClick = (e: MouseEvent<HTMLDivElement>) => {
    if (e.metaKey || e.ctrlKey) {
      onSelect?.(card.id, true);
      return;
    }
    onOpen?.(card.id);
  };

  return (
    <Draggable draggableId={card.id} index={index}>
      {(provided, snapshot) => (
        <div
          ref={provided.innerRef}
          {...provided.draggableProps}
          {...provided.dragHandleProps}
          // O dnd marca o handle como role="button"; com o menu de ações dentro,
          // isso vira nested-interactive no axe. "group" mantém o foco e o
          // teclado do dnd (tabIndex e handlers continuam vindo do spread) sem
          // aninhar dois controles — nada de aria-hidden nem de suprimir regra.
          role="group"
          aria-label={`${t("Lead")}: ${card.title}`}
          onClick={handleClick}
          // Tags saem do card (Lei A): ficam a um hover, sem ocupar altura.
          title={card.tags.length > 0 ? `Tags: ${card.tags.join(", ")}` : undefined}
          className={cn(
            // O desenho do quadro novo: canto macio de 12px (squircle onde o navegador sabe, raio
            // comum onde não), sombra fina e um levantar de 1px ao passar o mouse. O levantar usa a
            // propriedade `translate`, que NÃO é a `transform` que a biblioteca de arrastar escreve
            // no estilo do card — os dois não brigam.
            "group relative overflow-hidden rounded-[12px] border border-border bg-surface [corner-shape:squircle]",
            "py-2.5 pl-3 pr-3 shadow-xs transition-[translate,box-shadow,border-color] duration-150",
            "hover:-translate-y-px hover:border-border-strong hover:shadow-sm",
            "motion-reduce:transition-none motion-reduce:hover:translate-y-0",
            snapshot.isDragging && "rotate-1 shadow-md ring-1 ring-accent/40",
            isSelected && "ring-2 ring-accent",
            // O aberto ao lado: borda e anel na cor de ação, mais discretos que a seleção múltipla.
            isOpen && !isSelected && "border-primary ring-1 ring-primary/40",
          )}
        >
          {/* key = contador: cada evento remoto monta um overlay NOVO, e é isso
              que reinicia a animação. Fica no elemento interno — pôr no wrapper
              remontaria o draggable e quebraria o arrasto. */}
          {pulseCount > 0 && (
            <span
              key={pulseCount}
              aria-hidden
              // Observável de propósito: é assim que o teste prova que o
              // overlay REMONTOU (contador novo) em vez de ter sobrado do
              // evento anterior — e "sobrou" era exatamente o defeito.
              data-pulse={pulseCount}
              className="card-pulse pointer-events-none absolute inset-0"
            />
          )}
          {/* Borda de estado — 2px, a única cor do card. */}
          <span
            aria-hidden
            className={cn(
              "absolute inset-y-0 left-0 w-0.5",
              state.border === "accent" && "bg-accent",
              state.border === "warning" && "bg-warning",
              state.border === "neutral" && "bg-transparent",
            )}
          />

          {/* O ROSTO DO CLIENTE à esquerda, e ao lado dele as duas primeiras faixas (identidade e
              valor). `data-bloco` marca o conjunto para a prova. */}
          <div className="flex items-start gap-2.5" data-bloco="rosto-e-identidade">
            <AvatarDoContato
              contato={contato}
              nome={nomeDoRosto}
              reserva={reservaDoRosto}
              className="mt-0.5 h-9 w-9"
              classNameIniciais="text-[11px]"
            />
            <div className="min-w-0 flex-1">
              {/* ① identidade — altura FIXA de 2 linhas, com ou sem texto longo. */}
              <div className="flex items-start justify-between gap-2">
                <div className="flex min-w-0 flex-1 items-start gap-1.5">
                  {card.canonicalTag && (
                    <span
                      className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-accent"
                      title={card.canonicalTag}
                      // role="img": um span nu não aceita aria-label (aria-prohibited-attr).
                      role="img"
                      aria-label={`${t("Tag")}: ${card.canonicalTag}`}
                    />
                  )}
                  {/* O TÍTULO é o elemento ativável, não o card inteiro.
                      `role="group"` no card foi decisão da wave 2 (o dnd marca o
                      handle como button, e com o menu de ações dentro isso vira
                      nested-interactive no axe). Voltar o card para `button`
                      reintroduziria aquele defeito com cara de melhoria de
                      acessibilidade; deixar só onKeyDown daria uma ação que existe
                      e NÃO É DESCOBERTA por leitor de tela. O título como button
                      atende mouse, teclado e leitor sem desfazer a decisão antiga. */}
                  <h3 className="line-clamp-2 h-10 text-sm font-medium leading-5 text-text">
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        onOpen?.(card.id);
                      }}
                      className="text-left hover:underline"
                    >
                      {card.title}
                    </button>
                  </h3>
                </div>
                <KanbanCardActions lead={lead} pipelineId={pipelineId} />
              </div>

              {/* ② valor — altura reservada mesmo sem valor, senão o card encolhe. */}
              <p
                className={cn(
                  "mt-1 h-5 text-xs font-medium leading-5 tabular-nums",
                  value ? "text-text" : "text-text-muted",
                )}
              >
                {value ?? "—"}
              </p>
            </div>
          </div>

          {/* ③ a linha do agente — um slot, três estados, nunca três blocos. */}
          <div className="mt-1.5 flex h-6 items-center gap-2 text-xs">
            {state.slot.type === "awaiting" && (
              // A proposta do agente é a ÚNICA linha do card com ação: é o
              // ponto onde a decisão do humano entra. Sem os botões aqui, o
              // texto seria só mais um aviso — e a wave existe porque avisar
              // sem poder decidir é o que já acontecia (o dado ficava no banco).
              <NextActionSlot
                label={state.slot.label}
                leadId={card.id}
                approvedSeq={lead.next_action?.seq ?? -1}
                pipelineId={pipelineId}
              />
            )}
            {state.slot.type === "reactivation" && (
              // O negócio parou E aqui está o que fazer. Mesma faixa, mesma
              // altura: o card não cresce quando o sistema tem algo a propor.
              <ReactivationSlot
                leadId={card.id}
                proposalId={state.slot.proposalId}
                expiresAt={state.slot.expiresAt}
                pipelineId={pipelineId}
              />
            )}
            {state.slot.type === "cooling" && (
              // -fg é a variante de TEXTO do token (o -warning puro dá 3.7:1 em
              // 12px); a cor cheia fica na borda de estado, que é gráfica.
              <span className="truncate text-warning-fg">{state.slot.label}</span>
            )}
            {state.slot.type === "meter" && (
              <ScoreSlot
                probability={state.slot.probability}
                band={state.slot.band}
                reason={state.slot.reason}
                factors={state.slot.factors}
              />
            )}
          </div>

          {/* A última mensagem, com atalho para o inbox. Fica ANTES do rodapé
              de dono/tempo porque é conteúdo do negócio, não metadado do card —
              e some por inteiro quando não há conversa. */}
          <ConversaSlot conversa={lead.conversa} />

          {/* ④ dono · ⑤ tempo no estágio */}
          <div className="mt-1.5 flex h-7 items-center justify-between gap-2 border-t border-border pt-1">
            <OwnerBadge
              ownerKind={card.owner.kind}
              ownerName={card.owner.name}
              agentVersion={card.owner.agentVersion}
            />
            <span className="shrink-0 whitespace-nowrap text-[11px] tabular-nums text-text-muted">
              {state.showStageAge && age
                ? `${age} ${t("em")} ${card.stageName}`
                : `${t("em")} ${card.stageName}`}
            </span>
          </div>
        </div>
      )}
    </Draggable>
  );
}
