/**
 * Gatilho de SILÊNCIO (Task 8.1) — TIME-DRIVEN, não event-driven. Roda como
 * uma varredura periódica dentro do MESMO tick do cron
 * `app/api/v1/cron/followup-flow-worker/route.ts`, lado a lado com
 * `runFollowupTick` (lib/followup/engine.ts) — decisão de arquitetura já
 * tomada (ver HANDOFF): silêncio não tem um EVENTO que o dispare (é ausência
 * de evento por um período), então não pertence a `reactivity.ts` (que reage
 * a linhas de `event_log`).
 *
 * Fluxo por tick: acha pointers `status='active'` com `trigger_config.kind=
 * 'silence'` (de TODAS as orgs — mesmo design cross-org do
 * `fn_claim_due_followup_enrollments`) → GATEIA cada um via
 * `isPointerEnabledForAutomaticTrigger` (Task 7.2 — só enrolla se algum
 * agente PUBLICADO da org tem esse pointer habilitado) → acha contatos
 * silenciosos da org (sem inbound há >= threshold_minutes) → cria 1
 * enrollment por (pointer, contato) qualificado, nascendo no nó `trigger` do
 * grafo pinado com `next_eval_at=now`. Como `runSilenceSweep` roda DEPOIS de
 * `runFollowupTick` no MESMO tick do cron (route.ts), esse enrollment recém-
 * criado só é reclamado no PRÓXIMO tick (~1min depois), não neste.
 *
 * Idempotência + exclusividade: o índice único `idx_followup_enrollments_one_live`
 * é ORG-WIDE `(organization_id, contact_id)` (migration 0062, Task 8.6) — um
 * contato já vivo em QUALQUER fluxo da org barra novo enrollment (1 follow-up
 * vivo por lead), 23505 vira skip silencioso (`insertEnrollment` devolve
 * `inserted:false`), nunca erro. Um contato que COMPLETOU ou foi cancelado
 * pode ser re-enrollado na varredura seguinte se continuar silencioso —
 * aceitável no MVP, sem cooldown table.
 *
 * agent_id: cada pointer é gateado por `resolveAgentForAutomaticTrigger`, que
 * devolve o agente publicado que ARMA o pointer (menor uuid se >1) — esse
 * agent_id é PINADO no enrollment (persona + exibição na fila). `null` = gate-out.
 *
 * `segments`: única primitiva de segmentação já modelada no schema é
 * `contacts.tags` (GIN index `idx_contacts_tags_gin` já existe) — interpretado
 * como overlap entre `trigger_config.params.segments` e `contacts.tags`.
 * `segments` vazio/ausente = todos os contatos silenciosos da org.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { CONVERSATION_TERMINAL_STATUSES } from "@/lib/schemas";
import { flowGraphSchema } from "./graph-schema";
import { triggerConfigSchema } from "./api-schemas";
import { resolveAgentForAutomaticTrigger, type FollowupGateDb } from "./agent-followup-gate";
import { podeEntrarNoAutomatico, type RegraDeAnuncio } from "./regra-de-anuncio";
import {
  decidirEntrada,
  previsaoDeEntrada,
  type EstadoDoRitmo,
  type RitmoDeEntrada,
} from "./ritmo-de-entrada";

export interface SilencePointer {
  id: string;
  organization_id: string;
  active_version_id: string;
  threshold_minutes: number;
  segments: string[];
  /** `null` = sem ritmo: todos os parados entram de uma vez (comportamento original). */
  ritmo: RitmoDeEntrada | null;
  /**
   * Lead de anúncio só entra depois da avaliação (etapas liberadas). Ausente/`null` = sem restrição
   * (comportamento de sempre). Ver `regra-de-anuncio.ts`.
   */
  leads_de_anuncio?: RegraDeAnuncio | null;
}

/** As inscrições deste fluxo que ainda contam no limite das 24h, da mais antiga para a mais nova. */
export interface InscricoesRecentes {
  /** Instante de criação de cada inscrição na janela, ordem crescente. */
  criadasEm: Date[];
  /** A mais nova (mesmo fora da janela de 24h) — é dela que vem o intervalo. */
  ultima: { id: string; criadaEm: Date } | null;
}

/** DB surface o sweep precisa — narrow por consumidor (mesma doutrina de `AdminClient`/`ReactivityAdminClient`/`FollowupGateDb`). */
export interface SilenceSweepDb {
  /** Pointers ativos com trigger_config.kind='silence', de TODAS as orgs. */
  loadActiveSilencePointers(): Promise<SilencePointer[]>;
  /**
   * Contact ids da org sem inbound desde `cutoffIso` (inclusive); `segments` vazio = todos.
   * `regraAnuncio` (quando o fluxo tem): lead que veio de anúncio só é devolvido se já passou da avaliação.
   */
  loadSilentContactIds(
    orgId: string,
    cutoffIso: string,
    segments: string[],
    regraAnuncio?: RegraDeAnuncio | null,
  ): Promise<string[]>;
  /** Contatos da org com follow-up VIVO (active / waiting_reply / paused_handoff) em qualquer fluxo. */
  loadLiveContactIds(orgId: string): Promise<Set<string>>;
  /** Inscrições deste fluxo desde `sinceIso` + a mais recente de todas. Só é chamada quando o fluxo tem ritmo. */
  loadInscricoesRecentes(pointerId: string, sinceIso: string): Promise<InscricoesRecentes>;
  /** id do nó `trigger` do grafo pinado da version; `null` se version/nó não existir (defensivo — não deveria acontecer, validate-publish garante 1 trigger). */
  loadTriggerNodeId(orgId: string, versionId: string): Promise<string | null>;
  /** Insere o enrollment nascendo no nó trigger; `inserted:false` = 23505 (já vivo nesse pointer) → skip. */
  insertEnrollment(input: {
    organization_id: string;
    pointer_id: string;
    version_id: string;
    contact_id: string;
    current_node_id: string;
    next_eval_at: string;
    agent_id: string | null;
  }): Promise<{ inserted: boolean }>;
}

export interface SilenceSweepSummary {
  pointers_scanned: number;
  pointers_gated_out: number;
  enrolled: number;
  skipped_existing: number;
  /** Fluxos com ritmo em que esta varredura não inscreveu ninguém (intervalo ou limite do dia). */
  deferred_by_pacing: number;
}

export interface SilenceSweepDeps {
  db: SilenceSweepDb;
  gateDb: FollowupGateDb;
  clock: () => Date;
}

export async function runSilenceSweep(deps: SilenceSweepDeps): Promise<SilenceSweepSummary> {
  const { db, gateDb, clock } = deps;
  const summary: SilenceSweepSummary = {
    pointers_scanned: 0,
    pointers_gated_out: 0,
    enrolled: 0,
    skipped_existing: 0,
    deferred_by_pacing: 0,
  };

  const pointers = await db.loadActiveSilencePointers();
  summary.pointers_scanned = pointers.length;

  // Memoiza a resolução do agente por pointer dentro desta varredura — nada
  // impede 2 pointers silence na mesma org, e a query do gate já é 1 por org
  // (não precisa repetir). `null` = gate-out (nenhum agente publicado arma o
  // pointer); qualquer agent_id = habilitado E já pinado (o mesmo id que vai
  // pro enrollment). Colapsa gate + pick numa chamada só (Task 8.6).
  const agentCache = new Map<string, Promise<string | null>>();
  const resolveAgent = (orgId: string, pointerId: string): Promise<string | null> => {
    const key = `${orgId}:${pointerId}`;
    let hit = agentCache.get(key);
    if (!hit) {
      hit = resolveAgentForAutomaticTrigger(gateDb, orgId, pointerId);
      agentCache.set(key, hit);
    }
    return hit;
  };

  for (const pointer of pointers) {
    const agentId = await resolveAgent(pointer.organization_id, pointer.id);
    if (agentId === null) {
      summary.pointers_gated_out++;
      continue;
    }

    const triggerNodeId = await db.loadTriggerNodeId(pointer.organization_id, pointer.active_version_id);
    if (!triggerNodeId) continue;

    const cutoffIso = new Date(clock().getTime() - pointer.threshold_minutes * 60_000).toISOString();
    const contactIds = await db.loadSilentContactIds(
      pointer.organization_id,
      cutoffIso,
      pointer.segments,
      pointer.leads_de_anuncio ?? null,
    );
    const nextEvalAt = clock().toISOString();

    // Fluxo COM ritmo: entra no máximo UM por varredura, e só se o intervalo
    // desde a última inscrição venceu e o limite das 24h não foi atingido. A
    // varredura roda a cada minuto e o intervalo mínimo é de 1, então "um por
    // rodada" é o que faz o espaçamento valer sem guardar estado novo.
    if (pointer.ritmo) {
      const agora = clock();
      const recentes = await db.loadInscricoesRecentes(
        pointer.id,
        new Date(agora.getTime() - 24 * 60 * 60_000).toISOString(),
      );
      const estado: EstadoDoRitmo = {
        ultimaEm: recentes.ultima?.criadaEm ?? null,
        ultimaId: recentes.ultima?.id ?? null,
        nasUltimas24h: recentes.criadasEm.length,
      };
      const decisao = decidirEntrada(agora, pointer.ritmo, estado, recentes.criadasEm[0] ?? null);
      if (!decisao.pode) {
        summary.deferred_by_pacing++;
        continue;
      }
      const vivos = await db.loadLiveContactIds(pointer.organization_id);
      for (const contactId of contactIds) {
        if (vivos.has(contactId)) {
          summary.skipped_existing++;
          continue;
        }
        const { inserted } = await db.insertEnrollment({
          organization_id: pointer.organization_id,
          pointer_id: pointer.id,
          version_id: pointer.active_version_id,
          contact_id: contactId,
          current_node_id: triggerNodeId,
          next_eval_at: nextEvalAt,
          agent_id: agentId,
        });
        if (inserted) {
          summary.enrolled++;
          break;
        }
        summary.skipped_existing++;
      }
      continue;
    }

    for (const contactId of contactIds) {
      const { inserted } = await db.insertEnrollment({
        organization_id: pointer.organization_id,
        pointer_id: pointer.id,
        version_id: pointer.active_version_id,
        contact_id: contactId,
        current_node_id: triggerNodeId,
        next_eval_at: nextEvalAt,
        agent_id: agentId,
      });
      if (inserted) summary.enrolled++;
      else summary.skipped_existing++;
    }
  }

  return summary;
}

export interface ProximoDaFila {
  contactId: string;
  /** 1 = o próximo a entrar. */
  posicao: number;
  /** Quando deve entrar (previsão, não promessa). */
  entraEm: Date;
}

/**
 * A fila ANTES da inscrição: quem são os próximos contatos parados que o gatilho
 * vai inscrever e quando, por ordem. Só existe para fluxo COM ritmo — sem ritmo
 * todo mundo entra de uma vez e não há fila a mostrar.
 *
 * Usa as mesmas funções da varredura (o corte de silêncio, o filtro de segmento,
 * a ordem do mais antigo, o ritmo) para que a tela e o motor não possam divergir.
 */
export async function proximosDaFila(
  db: SilenceSweepDb,
  pointer: SilencePointer,
  clock: () => Date,
  quantos: number,
): Promise<ProximoDaFila[]> {
  if (!pointer.ritmo) return [];
  const agora = clock();
  const cutoffIso = new Date(agora.getTime() - pointer.threshold_minutes * 60_000).toISOString();
  const [silentes, vivos, recentes] = await Promise.all([
    db.loadSilentContactIds(pointer.organization_id, cutoffIso, pointer.segments, pointer.leads_de_anuncio ?? null),
    db.loadLiveContactIds(pointer.organization_id),
    db.loadInscricoesRecentes(pointer.id, new Date(agora.getTime() - 24 * 60 * 60_000).toISOString()),
  ]);
  const candidatos = silentes.filter((id) => !vivos.has(id)).slice(0, quantos);
  const previsoes = previsaoDeEntrada(
    agora,
    pointer.ritmo,
    {
      ultimaEm: recentes.ultima?.criadaEm ?? null,
      ultimaId: recentes.ultima?.id ?? null,
      nasUltimas24h: recentes.criadasEm.length,
    },
    recentes.criadasEm,
    candidatos.length,
  );
  return candidatos.map((contactId, i) => ({
    contactId,
    posicao: i + 1,
    entraEm: previsoes[i]!,
  }));
}

type ContactEmbed =
  | {
      tags: string[] | null;
      is_blocked: boolean | null;
      ai_authorized_at: string | null;
      source: string | null;
      source_metadata: Record<string, unknown> | null;
    }
  | null;

const LOTE_DE_CONTATOS = 200;

/**
 * Para cada contato, o lead MAIS RECENTE: de onde veio (`source`) e em que etapa está (`slug`).
 * Só roda quando o fluxo tem a regra de anúncio, e só para os candidatos já filtrados.
 */
async function carregaLeadMaisRecente(
  admin: SupabaseClient,
  orgId: string,
  contactIds: string[],
): Promise<Map<string, { source: string | null; etapaSlug: string | null }>> {
  const porContato = new Map<string, { source: string | null; etapaSlug: string | null }>();
  for (let i = 0; i < contactIds.length; i += LOTE_DE_CONTATOS) {
    const lote = contactIds.slice(i, i + LOTE_DE_CONTATOS);
    const { data, error } = await admin
      .from("crm_leads")
      .select("contact_id, source, created_at, etapa:stage_id(slug)")
      .eq("organization_id", orgId)
      .eq("fora_do_funil", false)
      .in("contact_id", lote)
      .order("created_at", { ascending: false });
    if (error) throw new Error(error.message);
    for (const row of (data ?? []) as unknown as Array<{
      contact_id: string;
      source: string | null;
      etapa: { slug: string | null } | null;
    }>) {
      // Ordem decrescente: a primeira linha de cada contato é o lead mais recente.
      if (!porContato.has(row.contact_id)) {
        porContato.set(row.contact_id, { source: row.source, etapaSlug: row.etapa?.slug ?? null });
      }
    }
  }
  return porContato;
}

/** Production adapter: `SilenceSweepDb` sobre o client service-role real. */
export function createSupabaseSilenceSweepDb(admin: SupabaseClient): SilenceSweepDb {
  return {
    async loadActiveSilencePointers() {
      const { data, error } = await admin
        .from("followup_flow_pointers")
        .select("id, organization_id, active_version_id, trigger_config")
        .eq("status", "active")
        .not("active_version_id", "is", null);
      if (error) throw new Error(error.message);

      const pointers: SilencePointer[] = [];
      for (const row of (data ?? []) as Array<{
        id: string;
        organization_id: string;
        active_version_id: string | null;
        trigger_config: unknown;
      }>) {
        if (!row.active_version_id) continue;
        const parsed = triggerConfigSchema.safeParse(row.trigger_config);
        if (!parsed.success || parsed.data.kind !== "silence") continue;
        pointers.push({
          id: row.id,
          organization_id: row.organization_id,
          active_version_id: row.active_version_id,
          threshold_minutes: parsed.data.params.threshold_minutes,
          segments: parsed.data.params.segments ?? [],
          ritmo: parsed.data.params.ritmo ?? null,
          leads_de_anuncio: parsed.data.params.leads_de_anuncio ?? null,
        });
      }
      return pointers;
    },

    async loadSilentContactIds(orgId, cutoffIso, segments, regraAnuncio) {
      // last_inbound_at é POR CONVERSA; o enrollment é POR CONTATO — reduz
      // client-side pro MAIS RECENTE `last_inbound_at` entre as conversas do
      // contato (um contato com 2+ channel_sessions não pode ser marcado
      // silencioso por causa da conversa mais antiga se a mais nova respondeu).
      //
      // `.not("status", "in", ...)` exclui conversas CLOSED/ARCHIVED — um humano
      // que encerrou a conversa não deveria ver um follow-up automático chegar
      // depois. Sem isto, o sweep contava `last_inbound_at` de QUALQUER
      // conversa, inclusive uma que um humano já fechou de propósito — medido
      // ao desenhar o primeiro fluxo de silêncio real (tenant YADEA): o gatilho
      // só faz sentido enquanto "o fluxo da conversa ainda está ativo".
      const { data, error } = await admin
        .from("conversations")
        .select(
          "contact_id, last_inbound_at, contacts:contact_id(tags, is_blocked, ai_authorized_at, source, source_metadata), sessao:channel_session_id(metadata)",
        )
        .eq("organization_id", orgId)
        .not("last_inbound_at", "is", null)
        .not("status", "in", `(${CONVERSATION_TERMINAL_STATUSES.join(",")})`);
      if (error) throw new Error(error.message);

      type Row = {
        contact_id: string;
        last_inbound_at: string;
        contacts: ContactEmbed;
        sessao: { metadata: Record<string, unknown> | null } | null;
      };
      const cutoff = new Date(cutoffIso).getTime();
      const latest = new Map<
        string,
        {
          at: number;
          tags: string[];
          blocked: boolean;
          gateAllowlist: boolean;
          autorizado: boolean;
          source: string | null;
          metadata: Record<string, unknown> | null;
        }
      >();
      for (const row of (data ?? []) as unknown as Row[]) {
        const at = new Date(row.last_inbound_at).getTime();
        const prev = latest.get(row.contact_id);
        if (!prev || at > prev.at) {
          latest.set(row.contact_id, {
            at,
            tags: row.contacts?.tags ?? [],
            blocked: row.contacts?.is_blocked ?? false,
            gateAllowlist: row.sessao?.metadata?.ai_gate === "allowlist",
            autorizado: row.contacts?.ai_authorized_at != null,
            source: row.contacts?.source ?? null,
            metadata: row.contacts?.source_metadata ?? null,
          });
        }
      }

      const silentes: Array<{ id: string; at: number }> = [];
      const doAnuncio = new Map<string, { source: string | null; etapaSlug: string | null }>();
      if (regraAnuncio) {
        // Só os contatos que passariam pelos demais filtros precisam do lead — mas a lista é pequena
        // (conversas abertas da org) e uma consulta em lotes é mais simples que adivinhar quem sobra.
        const ids = [...latest.keys()];
        for (const [id, lead] of await carregaLeadMaisRecente(admin, orgId, ids)) doAnuncio.set(id, lead);
      }
      for (const [contactId, v] of latest) {
        if (v.blocked) continue;
        // Gate `allowlist`: o follow-up automático também respeita a
        // elegibilidade — só entra contato que uma origem elegível autorizou.
        if (v.gateAllowlist && !v.autorizado) continue;
        if (v.at > cutoff) continue; // conversou depois do corte — não é silêncio
        if (segments.length > 0 && !segments.some((s) => v.tags.includes(s))) continue;
        // Lead de anúncio só entra no automático depois da avaliação (regra do fluxo, se houver).
        const lead = doAnuncio.get(contactId);
        if (
          !podeEntrarNoAutomatico(
            {
              contatoSource: v.source,
              contatoMetadata: v.metadata,
              leadSource: lead?.source ?? null,
              etapaSlug: lead?.etapaSlug ?? null,
            },
            regraAnuncio,
          )
        ) {
          continue;
        }
        silentes.push({ id: contactId, at: v.at });
      }
      // O parado HÁ MAIS TEMPO primeiro: é a ordem da fila (e do ritmo de
      // entrada). Empate decidido pelo id, para a ordem não mudar de uma
      // varredura para a outra.
      silentes.sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : 1));
      return silentes.map((s) => s.id);
    },

    async loadLiveContactIds(orgId) {
      const { data, error } = await admin
        .from("followup_enrollments")
        .select("contact_id")
        .eq("organization_id", orgId)
        .in("status", ["active", "waiting_reply", "paused_handoff"]);
      if (error) throw new Error(error.message);
      return new Set(((data ?? []) as Array<{ contact_id: string }>).map((r) => r.contact_id));
    },

    async loadInscricoesRecentes(pointerId, sinceIso) {
      const { data, error } = await admin
        .from("followup_enrollments")
        .select("id, started_at")
        .eq("pointer_id", pointerId)
        .gte("started_at", sinceIso)
        .order("started_at", { ascending: true });
      if (error) throw new Error(error.message);
      const rows = (data ?? []) as Array<{ id: string; started_at: string }>;
      // A mais recente pode estar FORA das 24h (fluxo parado há dias): nesse
      // caso o intervalo dela já venceu, e basta não haver nenhuma `ultima`.
      const ultimaRow = rows[rows.length - 1];
      return {
        criadasEm: rows.map((r) => new Date(r.started_at)),
        ultima: ultimaRow ? { id: ultimaRow.id, criadaEm: new Date(ultimaRow.started_at) } : null,
      };
    },

    async loadTriggerNodeId(orgId, versionId) {
      const { data, error } = await admin
        .from("followup_flow_versions")
        .select("graph")
        .eq("organization_id", orgId)
        .eq("id", versionId)
        .maybeSingle();
      if (error) throw new Error(error.message);
      if (!data) return null;
      const graph = flowGraphSchema.parse(data.graph);
      return graph.nodes.find((n) => n.type === "trigger")?.id ?? null;
    },

    async insertEnrollment(input) {
      // 23505 aqui agora é o índice ORG-WIDE (organization_id, contact_id) —
      // um contato já vivo em QUALQUER fluxo da org barra este insert (Task
      // 8.6: 1 follow-up vivo por lead). Vira skip silencioso, nunca erro.
      const { error } = await admin.from("followup_enrollments").insert(input);
      if (error) {
        if (error.code === "23505") return { inserted: false };
        throw new Error(error.message);
      }
      return { inserted: true };
    },
  };
}
