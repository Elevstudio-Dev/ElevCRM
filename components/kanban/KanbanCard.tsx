"use client";
import { Draggable } from "@hello-pangea/dnd";
import type { MouseEvent } from "react";
import { useT } from "@/hooks/i18n/useT";
import { AvatarDoContato } from "@/components/contacts/AvatarDoContato";
import { Badge } from "@/components/ui/badge";
import { phoneForDisplay } from "@/lib/channels/phone-variants";
import { rotuloDoContato } from "@/lib/contacts/rotulo-do-contato";
import { resolveCardState, stageAgeLabel, type CardInput } from "@/lib/kanban/card-state";
import {
  type FaixaDoPrazo,
  type IconeDaOrigem,
  origemDoLead,
  prazoDoCard,
} from "@/lib/kanban/prazo-e-origem";
import { CLASSE_DE_COR } from "@/lib/marcadores/cores";
import { COR_DE_MARCADOR_PADRAO, type CorDeMarcador } from "@/lib/schemas/settings";
import type { Lead } from "@/lib/types/leads";
import {
  CalendarBlank,
  ChatCircle,
  Globe,
  Lightning,
  Megaphone,
  PencilSimple,
  Phone,
  QrCode,
  Robot,
  UploadSimple,
} from "@/lib/ui/icons";
import { cn } from "@/lib/utils";
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
  /**
   * A cor de cada marcador da empresa, pelo NOME. Vem por PROP, como na lista do Inbox: o vocabulário
   * é da organização, e uma leitura por card seriam dezenas de assinaturas para a mesma pergunta.
   * Tag fora do mapa cai no cinza.
   */
  coresDasTags?: ReadonlyMap<string, CorDeMarcador>;
  onSelect?: (leadId: string, additive: boolean) => void;
  /** Abrir o dossiê. Separado de `onSelect`: são gestos e intenções diferentes. */
  onOpen?: (leadId: string) => void;
}

/**
 * O valor do negócio, SEMPRE com os centavos e SEMPRE presente: sem valor é "R$ 0,00", não um traço.
 * Os centavos entram para todos pelo mesmo motivo — "R$ 0,00" ao lado de "R$ 1.200" pareceria dois
 * formatos de dinheiro na mesma coluna.
 */
function formatBRL(cents: number | null, currency: string | null): string {
  const code = currency ?? "BRL";
  const valor = (cents ?? 0) / 100;
  try {
    return new Intl.NumberFormat("pt-BR", {
      style: "currency",
      currency: code,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(valor);
  } catch {
    return `${valor.toFixed(2)} ${code}`;
  }
}

/** Um ícone por tipo de origem — o texto ao lado diz o nome, o ícone só ajuda a varrer a coluna. */
const ICONE_DA_ORIGEM: Record<IconeDaOrigem, typeof Globe> = {
  manual: PencilSimple,
  whatsapp: ChatCircle,
  automatica: Lightning,
  importada: UploadSimple,
  agente: Robot,
  qr: QrCode,
  anuncio: Megaphone,
  outra: Globe,
};

/** A cor do prazo. Nunca vai sozinha: o texto ("Atrasado há 2 dias") e o ícone continuam ao lado. */
const CLASSE_DO_PRAZO: Record<FaixaDoPrazo, string> = {
  atrasado: "font-medium text-error-fg",
  hoje: "font-medium text-warning-fg",
  proximo: "text-warning-fg",
  folga: "text-text-muted",
};

/** Quantas tags aparecem no card; o resto vira "+N" e fica no tooltip do card. */
const TAGS_VISIVEIS = 3;

/**
 * O card do Kanban — cada linha só existe quando tem o que dizer.
 *
 * A versão anterior reservava altura para tudo (título de 2 linhas, faixa do agente mesmo vazia,
 * "—" no lugar do valor) para o card nunca crescer. O preço foi um card meio vazio: a maior parte
 * do que ele guardava de espaço era espaço em branco. Agora a altura segue o conteúdo, e o que é
 * SEMPRE verdade fica: o rosto, o nome, o valor ("R$ 0,00" quando não há) e o rodapé de dono e tempo.
 * Telefone, faixa do agente, tags, última mensagem, prazo e origem aparecem quando existem.
 *
 * A faixa do agente continua sendo UM slot com um estado por vez (decisão pendente, esfriando,
 * proposta de retomada, probabilidade) — o que mudou é que no estado `idle` ela não ocupa linha.
 *
 * Cor de estado só aparece na borda esquerda (Lei C); o prazo atrasado e o prazo perto são a
 * exceção deliberada, e nunca vão sozinhos: levam ícone e texto.
 */
export function KanbanCard({
  card,
  lead,
  index,
  pipelineId,
  isSelected,
  isOpen,
  pulseCount = 0,
  coresDasTags,
  onSelect,
  onOpen,
}: KanbanCardProps) {
  const t = useT();
  const value = formatBRL(card.valueCents, card.currency);
  const semValor = card.valueCents == null;
  // As tags em chips: a canônica do pipeline vai primeiro (é a que o time escolheu destacar), e as
  // demais seguem na ordem em que o lead as tem.
  const tagsOrdenadas = card.canonicalTag
    ? [card.canonicalTag, ...card.tags.filter((tag) => tag !== card.canonicalTag)]
    : card.tags;
  const tagsVisiveis = tagsOrdenadas.slice(0, TAGS_VISIVEIS);
  const tagsOcultas = tagsOrdenadas.length - tagsVisiveis.length;
  // Prazo só conta para negócio ABERTO: em etapa de ganho ou perda a data prevista já não decide nada.
  const prazo = lead.status === "open" ? prazoDoCard(lead.expected_close_date, new Date(), t) : null;
  const origem = origemDoLead(lead.source, t, lead.source_metadata);
  const IconeDaOrigemDoLead = origem ? ICONE_DA_ORIGEM[origem.icone] : null;
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

          {/* O ROSTO DO CLIENTE à esquerda, e ao lado dele nome, telefone e valor. `data-bloco` marca o
              conjunto para a prova. */}
          <div className="flex items-start gap-2.5" data-bloco="rosto-e-identidade">
            <AvatarDoContato
              contato={contato}
              nome={nomeDoRosto}
              reserva={reservaDoRosto}
              className="mt-0.5 h-9 w-9"
              classNameIniciais="text-[11px]"
            />
            <div className="min-w-0 flex-1">
              {/* ① identidade — uma linha quando o título cabe, duas quando não cabe (o resto é
                  cortado). Não reserva mais a segunda linha à toa. */}
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
                  <h3 className="line-clamp-2 text-sm font-medium leading-5 text-text">
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
                {/* O botão de ações tem 28px e a linha do título 20px: sem a margem negativa ele
                    esticava a linha e deixava um vão entre o título e o telefone. */}
                <div className="-my-1 shrink-0">
                  <KanbanCardActions lead={lead} pipelineId={pipelineId} />
                </div>
              </div>

              {/* O telefone do cliente: é por ele que o atendente reconhece quem é, e o nome do
                  WhatsApp nem sempre ajuda. Sem contato (lead à mão) ou com contato anonimizado
                  (o servidor já tirou o número) a linha não existe. */}
              {contato?.phone_number ? (
                <p
                  data-testid="telefone-do-card"
                  className="flex items-center gap-1 text-[11px] leading-4 tabular-nums text-text-muted"
                >
                  <Phone size={11} weight="regular" className="shrink-0" aria-hidden />
                  {reservaDoRosto}
                </p>
              ) : null}

              {/* ② valor — sempre presente. Sem valor cadastrado é "R$ 0,00", em tom apagado: a cor
                  diz que ninguém preencheu, e o número não deixa um buraco no card. */}
              <p
                data-testid="valor-do-card"
                data-sem-valor={semValor ? "true" : undefined}
                className={cn(
                  "mt-0.5 text-xs font-medium leading-5 tabular-nums",
                  semValor ? "text-text-muted" : "text-text",
                )}
              >
                {value}
              </p>
            </div>
          </div>

          {/* ③ a linha do agente — um slot, um estado por vez, e NENHUMA linha quando não há nada a
              dizer (`idle`): antes ela reservava a altura mesmo vazia. */}
          {state.slot.type !== "idle" && (
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
          )}

          {/* As tags, em chips com a cor do marcador da empresa — antes só apareciam no tooltip. */}
          {tagsVisiveis.length > 0 ? (
            <div data-testid="tags-do-card" className="mt-1.5 flex flex-wrap items-center gap-1">
              {tagsVisiveis.map((tag) => {
                const cor = CLASSE_DE_COR[coresDasTags?.get(tag) ?? COR_DE_MARCADOR_PADRAO];
                return (
                  <Badge
                    key={tag}
                    variant="secondary"
                    className={cn(
                      "h-4 max-w-[8rem] border-transparent px-1.5 text-[10px]",
                      cor.fundo,
                      cor.texto,
                    )}
                  >
                    <span className="truncate">{tag}</span>
                  </Badge>
                );
              })}
              {tagsOcultas > 0 ? (
                <span className="text-[10px] text-text-muted">+{tagsOcultas}</span>
              ) : null}
            </div>
          ) : null}

          {/* A última mensagem, com atalho para o inbox. Fica ANTES do rodapé
              de dono/tempo porque é conteúdo do negócio, não metadado do card —
              e some por inteiro quando não há conversa. */}
          <ConversaSlot conversa={lead.conversa} />

          {/* De onde o negócio veio e quando ele vence. Só existe quando há um dos dois. */}
          {origem || prazo ? (
            <div
              data-testid="origem-e-prazo"
              className="mt-1 flex items-center justify-between gap-2 px-1 text-[11px] text-text-muted"
            >
              {origem && IconeDaOrigemDoLead ? (
                <span className="inline-flex min-w-0 items-center gap-1" data-origem={origem.icone}>
                  <IconeDaOrigemDoLead size={11} weight="regular" className="shrink-0" aria-hidden />
                  <span className="sr-only">{t("Origem")}: </span>
                  <span className="truncate">{origem.rotulo}</span>
                </span>
              ) : (
                <span />
              )}
              {prazo ? (
                <span
                  data-faixa-do-prazo={prazo.faixa}
                  className={cn(
                    "inline-flex shrink-0 items-center gap-1 tabular-nums",
                    CLASSE_DO_PRAZO[prazo.faixa],
                  )}
                >
                  <CalendarBlank size={11} weight="regular" aria-hidden />
                  {prazo.texto}
                </span>
              ) : null}
            </div>
          ) : null}

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
