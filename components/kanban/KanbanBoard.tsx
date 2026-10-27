"use client";
import { useCallback, useMemo, useRef, useState } from "react";
import { DragDropContext, type DropResult } from "@hello-pangea/dnd";
import { useT } from "@/hooks/i18n/useT";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useBoard } from "@/hooks/kanban/useBoard";
import { useMoveCard } from "@/hooks/kanban/useMoveCard";
import { useAssignableMembers } from "@/hooks/inbox/useAssignableMembers";
import { useAtRiskLeads } from "@/hooks/leads/useAtRiskLeads";
import { useReactivations } from "@/hooks/leads/useReactivations";
import { midpoint } from "@/lib/kanban/fractional-indexing";
import type { Lead } from "@/lib/types/leads";
import type { Pipeline, Stage } from "@/lib/kanban/types";
import { StageColumn } from "./StageColumn";
import { LeadDossier } from "./LeadDossier";
import { camposDoFunil } from "@/lib/leads/campos-do-funil";

interface KanbanBoardProps {
  pipelineId: string;
  /** Optional override: if provided, skips internal useBoard fetch. */
  stages?: Stage[];
  leads?: Lead[];
  pipeline?: Pipeline;
  selectedIds?: string[];
  /**
   * Ids que chegaram por evento remoto, quando o board recebe os dados de fora.
   *
   * Quem assina o realtime é quem chama `useBoard` com o pipeline — e nesta
   * página é o _client, não este componente (aqui `useBoard(null)` fica
   * desligado por causa do `useExternal`). Sem esta prop o pulso nasce no lugar
   * certo e morre na fronteira: o dado vem por prop e o sinal ficava para trás.
   */
  pulses?: Map<string, number>;
  onSelectionChange?: (ids: string[]) => void;
  /** Lead a abrir já na montagem (deep link `?lead=` — ver o dossiê abaixo). */
  leadInicial?: string | null;
}

function groupLeadsByStage(stages: Stage[], leads: Lead[]): Map<string, Lead[]> {
  const map = new Map<string, Lead[]>();
  for (const stage of stages) map.set(stage.id, []);
  for (const lead of leads) {
    const bucket = map.get(lead.stage_id);
    if (bucket) bucket.push(lead);
  }
  // Already ordered by position_in_stage at fetch time, but be defensive.
  for (const list of map.values()) {
    list.sort((a, b) => a.position_in_stage - b.position_in_stage);
  }
  return map;
}

function BoardSkeleton() {
  return (
    <div className="flex gap-3 overflow-x-auto p-4">
      {[0, 1, 2].map((c) => (
        <div
          key={c}
          className="flex w-80 shrink-0 flex-col gap-2 rounded-lg border border-border bg-surface-muted/40 p-3"
        >
          <Skeleton className="h-5 w-32" />
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-24 w-full animate-pulse" />
          ))}
        </div>
      ))}
    </div>
  );
}

export function KanbanBoard({
  pipelineId,
  stages: stagesProp,
  leads: leadsProp,
  pipeline: pipelineProp,
  selectedIds,
  pulses: pulsesProp,
  onSelectionChange,
  leadInicial,
}: KanbanBoardProps) {
  const t = useT();
  const useExternal = stagesProp !== undefined && leadsProp !== undefined;
  const queryResult = useBoard(useExternal ? null : pipelineId);
  const moveCard = useMoveCard(pipelineId);
  const { data: members } = useAssignableMembers(true);
  const ownerNames = useMemo(
    () => new Map((members ?? []).map((m) => [m.user_id, m.full_name])),
    [members],
  );
  // Esfriando vem do MESMO radar que alimenta /app/radar — o board não
  // reclassifica nada (contrato §3.3). `em_voo` fica de fora: a IA já prometeu
  // voltar, então não há decisão pendente para o humano.
  const { data: atRisk } = useAtRiskLeads();
  // As propostas vivas vêm da MESMA forma que o risco: uma lista por org, que o
  // card consome sem saber de onde veio. Ver o cabeçalho da rota.
  const { data: propostasVivas } = useReactivations();
  const reactivations = useMemo(() => {
    const m = new Map<string, { proposalId: string; expiresAt: string }>();
    for (const p of propostasVivas ?? []) {
      m.set(p.lead_id, { proposalId: p.proposal_id, expiresAt: p.expires_at });
    }
    return m;
  }, [propostasVivas]);
  const coolingIds = useMemo(() => {
    const ids = new Set<string>();
    for (const item of atRisk?.items ?? []) {
      if (item.pipeline_id !== pipelineId) continue;
      if (item.risk === "em_risco" || item.risk === "critico") ids.add(item.id);
    }
    return ids;
  }, [atRisk, pipelineId]);
  // A tag canônica do pipeline é a ÚNICA que fica no card (como ponto de 6px);
  // as outras saem para o hover. Já existe em settings — não inventa campo.
  const canonicalTags = useMemo(() => {
    const raw = (pipelineProp ?? queryResult.data?.pipeline)?.settings?.canonical_tags;
    return Array.isArray(raw) ? raw.filter((t): t is string => typeof t === "string") : [];
  }, [pipelineProp, queryResult.data?.pipeline]);

  // O dossiê é do BOARD e não da página: ele precisa do lead inteiro e do nome
  // do estágio, que só existem aqui depois do agrupamento.
  //
  // `leadInicial` é o deep link: até aqui o dossiê SÓ abria por clique, então
  // nenhuma outra tela do produto conseguia apontar para um lead específico —
  // o histórico de captação tinha o id e nenhum lugar para levá-lo. Uma vez
  // aberto, o estado local manda (fechar não reabre pela URL).
  const [dossieId, setDossieId] = useState<string | null>(leadInicial ?? null);
  const [internalSelected, setInternalSelected] = useState<Set<string>>(new Set());
  const selectedLeadIds = useMemo(
    () => (selectedIds ? new Set(selectedIds) : internalSelected),
    [selectedIds, internalSelected],
  );

  const data = useExternal
    ? {
        pipeline: pipelineProp ?? ({} as Pipeline),
        stages: stagesProp,
        leads: leadsProp,
      }
    : queryResult.data;
  const isLoading = useExternal ? false : queryResult.isLoading;
  const isError = useExternal ? false : queryResult.isError;
  const error = useExternal ? null : queryResult.error;

  const leadDoDossie = dossieId
    ? (data?.leads.find((l) => l.id === dossieId) ?? null)
    : null;

  const grouped = useMemo(() => {
    if (!data) return null;
    return groupLeadsByStage(data.stages, data.leads);
  }, [data]);

  const handleSelect = useCallback(
    (leadId: string, additive: boolean) => {
      const apply = (prev: Set<string>): Set<string> => {
        const next = new Set(additive ? prev : []);
        if (additive && prev.has(leadId)) {
          next.delete(leadId);
        } else {
          next.add(leadId);
        }
        return next;
      };
      if (onSelectionChange) {
        const nextSet = apply(selectedLeadIds);
        onSelectionChange(Array.from(nextSet));
      } else {
        setInternalSelected((prev) => apply(prev));
      }
    },
    [onSelectionChange, selectedLeadIds],
  );

  // ROLAGEM LATERAL TRAVADA ENQUANTO UM CARD É ARRASTADO. A biblioteca de arrastar mede onde cada
  // coluna está UMA vez, ao levantar o card, e só acompanha a rolagem da lista de cada coluna (que é
  // o contêiner de rolagem dela) — rolagem aninhada ela documenta como não suportada. Se o quadro
  // andar para os lados no meio do arraste, o card continua "achando" a coluna que estava ali antes:
  // medido (Chromium, mouse real): depois de rolar 664px o mouse estava sobre "Em separação" e a
  // biblioteca seguia dizendo "Aguardando pagamento" — soltar ali moveria o lead para a etapa errada.
  // Roda e trackpad são o único caminho que sobra durante um arraste (o mouse está ocupado, e o
  // teclado a própria biblioteca já filtra), então é só eles que se travam. A rolagem VERTICAL da
  // coluna continua livre: essa a biblioteca acompanha.
  const arrastando = useRef(false);
  const desligaTravaLateral = useRef<(() => void) | null>(null);
  const aoMontarQuadro = useCallback((el: HTMLDivElement | null) => {
    desligaTravaLateral.current?.();
    desligaTravaLateral.current = null;
    if (!el) return;
    const trava = (e: WheelEvent) => {
      if (arrastando.current && (e.deltaX !== 0 || e.shiftKey)) e.preventDefault();
    };
    // Não-passivo de propósito: `preventDefault` num ouvinte passivo é ignorado em silêncio.
    el.addEventListener("wheel", trava, { passive: false });
    desligaTravaLateral.current = () => el.removeEventListener("wheel", trava);
  }, []);

  const handleDragEnd = useCallback(
    (result: DropResult) => {
      // Todo fim de arraste passa aqui — soltar, cancelar com Esc, soltar fora. Destravar ANTES dos
      // retornos antecipados abaixo, senão cancelar deixaria o quadro travado até o próximo arraste.
      arrastando.current = false;
      if (!data || !grouped) return;
      const { source, destination, draggableId } = result;
      if (!destination) return;
      if (
        source.droppableId === destination.droppableId &&
        source.index === destination.index
      ) {
        return;
      }

      const lead = data.leads.find((l) => l.id === draggableId);
      if (!lead) return;

      const destStageId = destination.droppableId;
      const destList = (grouped.get(destStageId) ?? []).filter(
        (l) => l.id !== draggableId,
      );

      const before = destination.index > 0 ? destList[destination.index - 1] : null;
      const after =
        destination.index < destList.length ? destList[destination.index] : null;

      const newPosition = midpoint(
        before?.position_in_stage ?? null,
        after?.position_in_stage ?? null,
      );

      if (Number.isNaN(newPosition)) {
        // Collision — Wave 8 will handle global rebalance. For now, abort silently.
        return;
      }

      moveCard.mutate({
        leadId: lead.id,
        stageId: destStageId,
        positionInStage: newPosition,
        expectedUpdatedAt: lead.updated_at,
      });
    },
    [data, grouped, moveCard],
  );

  if (isLoading) {
    return <BoardSkeleton />;
  }

  if (isError) {
    return (
      <Card className="m-4 p-6 text-sm text-text-muted">
        {t("Falha ao carregar o board.")}
        {error instanceof Error ? ` ${error.message}` : null}
      </Card>
    );
  }

  if (!data || !grouped) {
    return null;
  }

  // Ganho e perda ficam fora da conta: a cor das abertas é uma progressão (do claro ao escuro) e as
  // duas terminais têm cor própria (verde e vermelho). Ver `lib/kanban/cor-da-etapa`.
  const etapasAbertas = data.stages.filter((s) => !s.is_won && !s.is_lost);

  if (data.stages.length === 0) {
    return (
      <Card className="m-4 p-6 text-sm text-text-muted">
        {t("Nenhum lead nesta pipeline ainda.")}
      </Card>
    );
  }

  return (
    <DragDropContext
      onDragStart={() => {
        arrastando.current = true;
      }}
      onDragEnd={handleDragEnd}
    >
      {/* O QUADRO É A ALTURA QUE SOBRA NA TELA, e só rola para os lados. Antes era `h-full` — 100% da
          página, que já gastou uma parte com título e filtros — e as colunas não tinham teto: os
          cards passavam da borda da coluna e quem rolava era o quadro inteiro, todas as colunas
          juntas. `flex-1 min-h-0` faz o quadro ocupar exatamente o resto; `overflow-y-hidden`
          garante que a rolagem vertical mora em cada coluna (ver StageColumn), não aqui.

          `relative` NÃO é enfeite: um filho `position: absolute` só é recortado pelo `overflow` do quadro
          se o quadro (ou algo entre os dois) for o bloco de contenção dele. Sem isto, o texto `sr-only`
          da etapa de ganho/perda e as faixas dos cards escapavam do quadro e esticavam o DOCUMENTO em
          milhares de pixels para a direita — a janela ganhava rolagem horizontal e, ao arrastar um card
          para o fim, quem rolava era a PÁGINA INTEIRA, deixando um pedaço vazio. */}
      <div
        ref={aoMontarQuadro}
        data-testid="quadro-do-funil"
        className="relative flex min-h-0 flex-1 gap-3 overflow-x-auto overflow-y-hidden p-4"
      >
        {data.stages.map((stage) => (
          <StageColumn
            key={stage.id}
            stage={stage}
            posicaoEntreAbertas={etapasAbertas.indexOf(stage)}
            totalAbertas={etapasAbertas.length}
            leads={grouped.get(stage.id) ?? []}
            pipelineId={pipelineId}
            ownerNames={ownerNames}
            coolingIds={coolingIds}
            reactivations={reactivations}
            pulses={pulsesProp ?? queryResult.pulses}
            canonicalTags={canonicalTags}
            selectedLeadIds={selectedLeadIds}
            onSelect={handleSelect}
            onOpen={setDossieId}
          />
        ))}
      </div>
      {leadDoDossie && (
        <LeadDossier
          open
          onOpenChange={(v: boolean) => !v && setDossieId(null)}
          lead={leadDoDossie}
          pipelineId={pipelineId}
          fieldDefs={camposDoFunil(data.pipeline.settings ?? null)}
          stageName={
            data.stages.find((s) => s.id === leadDoDossie.stage_id)?.name ?? "—"
          }
          ownerNames={ownerNames}
        />
      )}
    </DragDropContext>
  );
}
