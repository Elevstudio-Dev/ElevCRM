/**
 * CAMPANHAS — uma mensagem ativa, escrita pela IA para cada pessoa, a uma lista
 * escolhida por etiqueta, saindo por um número escolhido, no ritmo que protege
 * o número.
 *
 * ─── Por que em cima do motor de follow-up, e não um motor novo ─────────────
 * O motor já tem tudo o que um envio em massa seguro precisa e que levou meses
 * para acertar: a cadeia de envio (STOP, janela anti-ban, LGPD), o cancelamento
 * quando a pessoa responde (`cancel_on_reply`), a pausa quando um humano assume
 * a conversa, a tentativa de novo com espera, o aviso quando desiste. Uma
 * campanha é um fluxo de três nós (gatilho → mensagem da IA → fim) e uma
 * inscrição por destinatário, cada uma com a HORA do envio já em `next_eval_at`.
 *
 * ─── Onde mora o quê ────────────────────────────────────────────────────────
 *   - a campanha: `followup_flow_pointers`, `trigger_config.kind = 'campanha'`,
 *     com etiquetas, número, objetivo, ritmo e estado em `params`;
 *   - cada destinatário: uma linha de `followup_enrollments` deste pointer.
 * Nenhuma tabela nova: a segurança por organização (RLS) e a auditoria das
 * tabelas do follow-up valem do jeito que já estão.
 *
 * Todas as funções recebem o client ADMIN e o `organizationId` explícito — o
 * chamador (rota) já conferiu o papel; nenhum id de organização vem do corpo.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { capabilitiesOf } from "@/lib/channels/capabilities";
import { listSelectableChannels } from "@/lib/channels/selectable";
import { rotuloDoContato } from "@/lib/contacts/rotulo-do-contato";
import type { ChannelProvider } from "@/lib/channels/types";
import { publishFollowupFlowVersion } from "@/lib/followup/publish";
import type { FlowGraph } from "@/lib/followup/graph-schema";
import { validateFlowForPublish } from "@/lib/followup/validate-publish";
import { FUSO_PADRAO, fusoValido } from "@/lib/tempo/fusos";

import { contarPorDia, planejarHorarios, type RitmoDaCampanha } from "./horarios";
import { STATUS_DE_CANAL_PARADO, campanhaParamsSchema, type ImagemDaCampanha, type CampanhaParams, type CriarCampanha, type EstadoDaCampanha } from "./parametros";
import { montarPublico, type ContatoCandidato, type MotivoDeFora } from "./publico";
import {
  MOTIVO_CANCELAMENTO,
  MOTIVO_PAUSA,
  NOTA_ENVIADA,
  NO_GATILHO,
  contagemVazia,
  situacaoDoDestinatario,
  type Contagem,
  type Situacao,
} from "./situacao";

const PAGINA = 1000;
const LOTE = 200;
/** Inscrição que ainda segura o contato: o índice único do banco só deixa uma destas por contato. */
const STATUS_VIVOS = ["active", "waiting_reply", "paused_handoff", "paused_manual"];

export class ErroDeCampanha extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

function falha(error: { message: string } | null): void {
  if (error) throw new Error(error.message);
}

function lotes<T>(itens: readonly T[], tamanho = LOTE): T[][] {
  const saida: T[][] = [];
  for (let i = 0; i < itens.length; i += tamanho) saida.push(itens.slice(i, i + tamanho));
  return saida;
}

/**
 * A IA escreve cada mensagem — texto livre. Canal que só aceita modelo aprovado
 * fora da janela de 24h (API oficial) recusaria TODOS os envios, um por um, e a
 * campanha morreria em silêncio na fila. A recusa é aqui, com gente na tela.
 */
async function canalAceitaTextoLivre(
  admin: SupabaseClient,
  organizationId: string,
  canalId: string,
): Promise<boolean> {
  const { data, error } = await admin
    .from("channel_sessions")
    .select("provider")
    .eq("organization_id", organizationId)
    .eq("id", canalId)
    .maybeSingle();
  falha(error);
  const provider = (data as { provider?: string } | null)?.provider;
  if (!provider) return false;
  return capabilitiesOf(provider as ChannelProvider).freeformOutsideWindow;
}

export const BUCKET_DA_IMAGEM = "whatsapp-media";

export function pastaDeImagens(organizationId: string): string {
  return `${organizationId}/campanhas/`;
}

/** A arte tem de estar na pasta de campanhas DESTA organização, e existir de fato. */
async function conferirImagem(admin: SupabaseClient, organizationId: string, imagem: ImagemDaCampanha): Promise<void> {
  const pasta = pastaDeImagens(organizationId);
  const nome = imagem.storage_path.slice(pasta.length);
  if (!imagem.storage_path.startsWith(pasta) || nome.length === 0 || nome.includes("/")) {
    throw new ErroDeCampanha("imagem_invalida", "A imagem não pertence a esta organização. Envie a imagem de novo.", 422);
  }
  const { data, error } = await admin.storage.from(BUCKET_DA_IMAGEM).list(pasta.slice(0, -1), { search: nome, limit: 5 });
  falha(error);
  if (!(data ?? []).some((o) => o.name === nome)) {
    throw new ErroDeCampanha("imagem_invalida", "A imagem não foi encontrada. Envie a imagem de novo.", 422);
  }
}

/** Link temporário (10 min) só para a tela mostrar a arte. */
async function linkDaImagem(admin: SupabaseClient, imagem: ImagemDaCampanha | undefined): Promise<string | null> {
  if (!imagem) return null;
  const { data } = await admin.storage.from(BUCKET_DA_IMAGEM).createSignedUrl(imagem.storage_path, 600);
  return data?.signedUrl ?? null;
}

export async function fusoDaOrganizacao(admin: SupabaseClient, organizationId: string): Promise<string> {
  const { data, error } = await admin.from("organizations").select("timezone").eq("id", organizationId).maybeSingle();
  falha(error);
  const tz = (data as { timezone?: string | null } | null)?.timezone ?? null;
  return tz && fusoValido(tz) ? tz : FUSO_PADRAO;
}

/** Contatos que têm TODAS as etiquetas, já com os campos que decidem se recebem. */
async function carregarCandidatos(
  admin: SupabaseClient,
  organizationId: string,
  etiquetas: readonly string[],
): Promise<ContatoCandidato[]> {
  const saida: ContatoCandidato[] = [];
  for (let de = 0; ; de += PAGINA) {
    const { data, error } = await admin
      .from("contacts")
      .select("id, phone_number, tags, is_blocked, papel_interno, is_anonymized, is_merged_into")
      .eq("organization_id", organizationId)
      .contains("tags", [...etiquetas])
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
      .range(de, de + PAGINA - 1);
    falha(error);
    const linhas = (data ?? []) as ContatoCandidato[];
    saida.push(...linhas);
    if (linhas.length < PAGINA) break;
  }
  return saida;
}

/** Dos `contactIds`, os que já estão num follow-up vivo (o banco recusaria a 2ª inscrição). */
async function emFollowupVivo(
  admin: SupabaseClient,
  organizationId: string,
  contactIds: readonly string[],
): Promise<Set<string>> {
  const ocupados = new Set<string>();
  for (const lote of lotes(contactIds)) {
    const { data, error } = await admin
      .from("followup_enrollments")
      .select("contact_id")
      .eq("organization_id", organizationId)
      .in("contact_id", lote)
      .in("status", STATUS_VIVOS);
    falha(error);
    for (const r of (data ?? []) as { contact_id: string }[]) ocupados.add(r.contact_id);
  }
  return ocupados;
}

export interface PreviaDaCampanha {
  total_com_etiquetas: number;
  recebem: number;
  fora: Record<MotivoDeFora | "em_outro_followup", number>;
  /** Hora prevista do primeiro e do último envio, com o ritmo pedido. */
  primeiro_envio: string | null;
  ultimo_envio: string | null;
}

async function publicoFinal(
  admin: SupabaseClient,
  organizationId: string,
  etiquetas: readonly string[],
): Promise<{ total: number; recebem: string[]; fora: PreviaDaCampanha["fora"] }> {
  const candidatos = await carregarCandidatos(admin, organizationId, etiquetas);
  const publico = montarPublico(candidatos, etiquetas);
  const ocupados = await emFollowupVivo(admin, organizationId, publico.incluidos);
  return {
    total: candidatos.length,
    recebem: publico.incluidos.filter((id) => !ocupados.has(id)),
    fora: { ...publico.fora, em_outro_followup: ocupados.size },
  };
}

export async function previaDaCampanha(
  admin: SupabaseClient,
  organizationId: string,
  etiquetas: readonly string[],
  ritmo: RitmoDaCampanha | undefined,
  agora: Date,
): Promise<PreviaDaCampanha> {
  const publico = await publicoFinal(admin, organizationId, etiquetas);
  let primeiro: string | null = null;
  let ultimo: string | null = null;
  if (ritmo && publico.recebem.length > 0) {
    const fuso = await fusoDaOrganizacao(admin, organizationId);
    const horarios = planejarHorarios(agora, publico.recebem.length, ritmo, fuso, "previa");
    primeiro = horarios[0]!.toISOString();
    ultimo = horarios[horarios.length - 1]!.toISOString();
  }
  return {
    total_com_etiquetas: publico.total,
    recebem: publico.recebem.length,
    fora: publico.fora,
    primeiro_envio: primeiro,
    ultimo_envio: ultimo,
  };
}

/** Gatilho → mensagem da IA (número e abertura de campanha) → fim. */
export function grafoDaCampanha(objetivo: string, canalId: string, imagem?: ImagemDaCampanha): FlowGraph {
  const grafo: FlowGraph = {
    nodes: [
      { id: NO_GATILHO, type: "trigger", label: "Campanha", position: { x: 0, y: 0 }, config: {} },
      {
        id: "mensagem",
        type: "action",
        label: "Mensagem da IA",
        position: { x: 0, y: 160 },
        config: {
          mode: "ai_message",
          prompt_hint: objetivo,
          canal_id: canalId,
          abertura: "campanha",
          ...(imagem ? { imagem } : {}),
        },
      },
      {
        id: "fim",
        type: "end",
        label: "Enviada",
        position: { x: 0, y: 320 },
        config: { outcome: "custom", note: NOTA_ENVIADA },
      },
    ],
    edges: [
      { id: "e1", source: NO_GATILHO, target: "mensagem", priority: 0, condition: { type: "always" } },
      { id: "e2", source: "mensagem", target: "fim", priority: 0, condition: { type: "always" } },
    ],
  };
  return grafo;
}

/** Insere as inscrições com a hora de cada envio. Devolve quantas entraram. */
async function inscrever(
  admin: SupabaseClient,
  organizationId: string,
  pointerId: string,
  versionId: string,
  contactIds: readonly string[],
  horarios: readonly Date[],
): Promise<number> {
  const linhas = contactIds.map((contactId, i) => ({
    organization_id: organizationId,
    pointer_id: pointerId,
    version_id: versionId,
    contact_id: contactId,
    current_node_id: NO_GATILHO,
    status: "active",
    next_eval_at: horarios[i]!.toISOString(),
    agent_id: null,
  }));
  let entraram = 0;
  for (const lote of lotes(linhas)) {
    const { error } = await admin.from("followup_enrollments").insert(lote);
    if (!error) {
      entraram += lote.length;
      continue;
    }
    if (error.code !== "23505") throw new Error(error.message);
    // Alguém entrou num follow-up entre a prévia e agora: um por um, pulando quem já está.
    for (const linha of lote) {
      const { error: e1 } = await admin.from("followup_enrollments").insert(linha);
      if (!e1) entraram++;
      else if (e1.code !== "23505") throw new Error(e1.message);
    }
  }
  return entraram;
}

export interface CampanhaCriada {
  id: string;
  inscritos: number;
  primeiro_envio: string | null;
  ultimo_envio: string | null;
}

export async function criarCampanha(
  admin: SupabaseClient,
  organizationId: string,
  pedido: CriarCampanha,
  criadoPor: string,
  agora: Date,
): Promise<CampanhaCriada> {
  const canais = await listSelectableChannels(admin, organizationId);
  const canal = canais.find((c) => c.id === pedido.canal_id);
  if (!canal) {
    throw new ErroDeCampanha("canal_invalido", "O número escolhido não está conectado nesta organização.", 422);
  }
  // Número parado ou com falha: cada envio da fila morreria um por um, e cada morte vira um aviso.
  if (STATUS_DE_CANAL_PARADO.has(canal.status)) {
    throw new ErroDeCampanha(
      "canal_desconectado",
      "Este número está desconectado. Reconecte-o em Conexões ou escolha outro.",
      422,
    );
  }
  if (!(await canalAceitaTextoLivre(admin, organizationId, pedido.canal_id))) {
    throw new ErroDeCampanha(
      "canal_exige_modelo",
      "Este número é da API oficial: a primeira mensagem precisa ser um modelo aprovado pela Meta, e a campanha escreve com a IA. Escolha um número conectado por QR code.",
      422,
    );
  }

  const publico = await publicoFinal(admin, organizationId, pedido.etiquetas);
  if (publico.recebem.length === 0) {
    throw new ErroDeCampanha("publico_vazio", "Nenhum contato com essas etiquetas pode receber a campanha.", 422);
  }

  if (pedido.imagem) await conferirImagem(admin, organizationId, pedido.imagem);

  const grafo = grafoDaCampanha(pedido.objetivo, pedido.canal_id, pedido.imagem);
  const validacao = validateFlowForPublish(grafo);
  if (!validacao.ok) {
    throw new Error(`grafo da campanha reprovado: ${validacao.errors.map((e) => e.code).join(",")}`);
  }

  const params: CampanhaParams = {
    etiquetas: pedido.etiquetas,
    canal_id: pedido.canal_id,
    objetivo: pedido.objetivo,
    ritmo: pedido.ritmo,
    estado: "enviando",
    ...(pedido.imagem ? { imagem: pedido.imagem } : {}),
  };
  const { data: pointer, error: insErr } = await admin
    .from("followup_flow_pointers")
    .insert({
      organization_id: organizationId,
      name: `Campanha: ${pedido.nome}`,
      trigger_config: { kind: "campanha", params, cancel_on_reply: true },
      // Humano assumiu a conversa = a campanha sai da frente, não espera para voltar.
      handoff_policy: "cancel",
      draft_graph: grafo,
    })
    .select("id")
    .single();
  if (insErr?.code === "23505") {
    throw new ErroDeCampanha("nome_repetido", "Já existe uma campanha com este nome.", 409);
  }
  if (insErr || !pointer) throw new Error(insErr?.message ?? "campanha_insert_failed");

  const publicado = await publishFollowupFlowVersion(admin, {
    orgId: organizationId,
    pointerId: pointer.id,
    graph: grafo,
    createdBy: criadoPor,
  });
  if (!publicado.ok) {
    // Sem versão publicada a campanha não tem como enviar: apagar, e não deixar
    // na lista uma campanha "concluída" com zero destinatários.
    await admin.from("followup_flow_pointers").delete().eq("organization_id", organizationId).eq("id", pointer.id);
    throw new Error(publicado.message);
  }

  const fuso = await fusoDaOrganizacao(admin, organizationId);
  const horarios = planejarHorarios(agora, publico.recebem.length, pedido.ritmo, fuso, pointer.id);
  let inscritos: number;
  try {
    inscritos = await inscrever(admin, organizationId, pointer.id, publicado.version_id, publico.recebem, horarios);
  } catch (err) {
    // Parte entrou e parte não: tira da fila quem entrou (ninguém recebe uma
    // campanha pela metade sem a equipe saber) e marca cancelada — o erro sobe.
    await tirarDaFila(admin, organizationId, pointer.id, MOTIVO_CANCELAMENTO);
    const p = await carregarPointer(admin, organizationId, pointer.id);
    await gravarEstado(admin, organizationId, p, "cancelada");
    throw err;
  }

  return {
    id: pointer.id,
    inscritos,
    primeiro_envio: horarios[0]?.toISOString() ?? null,
    ultimo_envio: horarios[horarios.length - 1]?.toISOString() ?? null,
  };
}

interface PointerDaCampanha {
  id: string;
  name: string;
  status: string;
  active_version_id: string | null;
  created_at: string;
  params: CampanhaParams;
}

function lerPointer(row: Record<string, unknown>): PointerDaCampanha | null {
  const cfg = row.trigger_config as { kind?: string; params?: unknown } | null;
  if (cfg?.kind !== "campanha") return null;
  const params = campanhaParamsSchema.safeParse(cfg.params);
  if (!params.success) return null;
  return {
    id: row.id as string,
    name: row.name as string,
    status: row.status as string,
    active_version_id: (row.active_version_id as string | null) ?? null,
    created_at: row.created_at as string,
    params: params.data,
  };
}

async function carregarPointer(admin: SupabaseClient, organizationId: string, id: string): Promise<PointerDaCampanha> {
  const { data, error } = await admin
    .from("followup_flow_pointers")
    .select("id, name, status, active_version_id, created_at, trigger_config")
    .eq("organization_id", organizationId)
    .eq("id", id)
    .maybeSingle();
  falha(error);
  const p = data ? lerPointer(data as Record<string, unknown>) : null;
  if (!p) throw new ErroDeCampanha("not_found", "Campanha não encontrada.", 404);
  return p;
}

interface InscricaoDaCampanha {
  id: string;
  contact_id: string;
  status: string;
  current_node_id: string;
  next_eval_at: string | null;
  cancel_reason: string | null;
  last_error: string | null;
  started_at: string;
}

async function inscricoesDe(
  admin: SupabaseClient,
  organizationId: string,
  pointerIds: readonly string[],
): Promise<(InscricaoDaCampanha & { pointer_id: string })[]> {
  const saida: (InscricaoDaCampanha & { pointer_id: string })[] = [];
  if (pointerIds.length === 0) return saida;
  for (let de = 0; ; de += PAGINA) {
    const { data, error } = await admin
      .from("followup_enrollments")
      .select("id, pointer_id, contact_id, status, current_node_id, next_eval_at, cancel_reason, last_error, started_at")
      .eq("organization_id", organizationId)
      .in("pointer_id", [...pointerIds])
      .order("started_at", { ascending: true })
      .order("id", { ascending: true })
      .range(de, de + PAGINA - 1);
    falha(error);
    const linhas = (data ?? []) as (InscricaoDaCampanha & { pointer_id: string })[];
    saida.push(...linhas);
    if (linhas.length < PAGINA) break;
  }
  return saida;
}

/** `enrollment_id → quando a mensagem saiu` (evento `action_sent` gravado pela ponte do turno). */
async function enviosDe(
  admin: SupabaseClient,
  organizationId: string,
  enrollmentIds: readonly string[],
): Promise<Map<string, string>> {
  const mapa = new Map<string, string>();
  for (const lote of lotes(enrollmentIds)) {
    const { data, error } = await admin
      .from("followup_enrollment_events")
      .select("enrollment_id, created_at")
      .eq("organization_id", organizationId)
      .in("enrollment_id", lote)
      .eq("event_type", "action_sent");
    falha(error);
    for (const r of (data ?? []) as { enrollment_id: string; created_at: string }[]) {
      const antes = mapa.get(r.enrollment_id);
      if (!antes || r.created_at < antes) mapa.set(r.enrollment_id, r.created_at);
    }
  }
  return mapa;
}

interface ContatoDaTela {
  id: string;
  name: string | null;
  display_name: string | null;
  phone_number: string | null;
  is_blocked: boolean;
}

async function contatosDe(
  admin: SupabaseClient,
  organizationId: string,
  contactIds: readonly string[],
): Promise<Map<string, ContatoDaTela>> {
  const mapa = new Map<string, ContatoDaTela>();
  for (const lote of lotes(contactIds)) {
    const { data, error } = await admin
      .from("contacts")
      .select("id, name, display_name, phone_number, is_blocked")
      .eq("organization_id", organizationId)
      .in("id", lote);
    falha(error);
    for (const c of (data ?? []) as ContatoDaTela[]) mapa.set(c.id, c);
  }
  return mapa;
}

/** `contact_id → última mensagem recebida desde `desde``. */
async function respostasDe(
  admin: SupabaseClient,
  organizationId: string,
  contactIds: readonly string[],
  desde: string,
): Promise<Map<string, string>> {
  const mapa = new Map<string, string>();
  for (const lote of lotes(contactIds)) {
    const { data, error } = await admin
      .from("messages")
      .select("contact_id, sent_at")
      .eq("organization_id", organizationId)
      .in("contact_id", lote)
      .eq("direction", "inbound")
      .gte("sent_at", desde)
      .order("sent_at", { ascending: false })
      .limit(5000);
    falha(error);
    for (const r of (data ?? []) as { contact_id: string; sent_at: string }[]) {
      if (!mapa.has(r.contact_id)) mapa.set(r.contact_id, r.sent_at);
    }
  }
  return mapa;
}

export interface ResumoDaCampanha {
  id: string;
  nome: string;
  estado: EstadoDaCampanha | "concluida";
  etiquetas: string[];
  canal_id: string;
  criada_em: string;
  contagem: Contagem;
  proximo_envio: string | null;
}

function nomeSemPrefixo(nome: string): string {
  return nome.replace(/^Campanha: /u, "");
}

function estadoVisivel(params: CampanhaParams, contagem: Contagem): ResumoDaCampanha["estado"] {
  if (params.estado !== "enviando") return params.estado;
  return contagem.agendado + contagem.enviando > 0 ? "enviando" : "concluida";
}

/**
 * Situação de cada inscrição. Só a mais recente de cada contato conta: retomar
 * uma campanha pausada cria uma inscrição nova, e a pausada não pode aparecer
 * como um segundo destinatário.
 */
async function situacoes(
  admin: SupabaseClient,
  organizationId: string,
  inscricoes: readonly (InscricaoDaCampanha & { pointer_id: string })[],
  desde: string,
): Promise<{ inscricao: InscricaoDaCampanha & { pointer_id: string }; situacao: Situacao; enviadoEm: string | null; respondeuEm: string | null }[]> {
  const ultima = new Map<string, InscricaoDaCampanha & { pointer_id: string }>();
  for (const i of inscricoes) ultima.set(`${i.pointer_id}:${i.contact_id}`, i);
  const atuais = [...ultima.values()];
  const contactIds = [...new Set(atuais.map((i) => i.contact_id))];
  const [envios, respostas, contatos] = await Promise.all([
    enviosDe(admin, organizationId, inscricoes.map((i) => i.id)),
    respostasDe(admin, organizationId, contactIds, desde),
    contatosDe(admin, organizationId, contactIds),
  ]);
  // O envio pode ter saído numa inscrição anterior (pausada depois de mandar): vale para o contato.
  const enviadoPorContato = new Map<string, string>();
  for (const i of inscricoes) {
    const em = envios.get(i.id);
    if (em) enviadoPorContato.set(`${i.pointer_id}:${i.contact_id}`, em);
  }
  return atuais.map((inscricao) => {
    const enviadoEm = enviadoPorContato.get(`${inscricao.pointer_id}:${inscricao.contact_id}`) ?? null;
    const respondeuEm = respostas.get(inscricao.contact_id) ?? null;
    const bloqueado = contatos.get(inscricao.contact_id)?.is_blocked ?? false;
    return {
      inscricao,
      situacao: situacaoDoDestinatario(inscricao, enviadoEm, respondeuEm, bloqueado),
      enviadoEm,
      respondeuEm,
    };
  });
}

export async function listarCampanhas(admin: SupabaseClient, organizationId: string): Promise<ResumoDaCampanha[]> {
  const { data, error } = await admin
    .from("followup_flow_pointers")
    .select("id, name, status, active_version_id, created_at, trigger_config")
    .eq("organization_id", organizationId)
    .eq("trigger_config->>kind", "campanha")
    .order("created_at", { ascending: false });
  falha(error);
  const pointers = ((data ?? []) as Record<string, unknown>[])
    .map(lerPointer)
    .filter((p): p is PointerDaCampanha => p !== null);
  if (pointers.length === 0) return [];

  const maisAntiga = pointers.reduce((m, p) => (p.created_at < m ? p.created_at : m), pointers[0]!.created_at);
  const inscricoes = await inscricoesDe(admin, organizationId, pointers.map((p) => p.id));
  const linhas = await situacoes(admin, organizationId, inscricoes, maisAntiga);

  return pointers.map((p) => {
    const contagem = contagemVazia();
    let proximo: string | null = null;
    for (const l of linhas) {
      if (l.inscricao.pointer_id !== p.id) continue;
      contagem[l.situacao]++;
      if (l.situacao === "agendado" && l.inscricao.next_eval_at && (!proximo || l.inscricao.next_eval_at < proximo)) {
        proximo = l.inscricao.next_eval_at;
      }
    }
    return {
      id: p.id,
      nome: nomeSemPrefixo(p.name),
      estado: estadoVisivel(p.params, contagem),
      etiquetas: p.params.etiquetas,
      canal_id: p.params.canal_id,
      criada_em: p.created_at,
      contagem,
      proximo_envio: proximo,
    };
  });
}

export interface DestinatarioDaTela {
  contact_id: string;
  nome: string;
  telefone: string | null;
  situacao: Situacao;
  agendado_para: string | null;
  enviado_em: string | null;
  respondeu_em: string | null;
  erro: string | null;
}

export interface DetalheDaCampanha extends ResumoDaCampanha {
  objetivo: string;
  ritmo: RitmoDaCampanha;
  canal_nome: string | null;
  /** Link temporário da arte, quando a campanha tem uma. */
  imagem_url: string | null;
  destinatarios: DestinatarioDaTela[];
}

export async function detalharCampanha(
  admin: SupabaseClient,
  organizationId: string,
  id: string,
): Promise<DetalheDaCampanha> {
  const p = await carregarPointer(admin, organizationId, id);
  const inscricoes = await inscricoesDe(admin, organizationId, [p.id]);
  const linhas = await situacoes(admin, organizationId, inscricoes, p.created_at);
  const contatos = await contatosDe(admin, organizationId, linhas.map((l) => l.inscricao.contact_id));
  const canais = await listSelectableChannels(admin, organizationId);

  const contagem = contagemVazia();
  let proximo: string | null = null;
  const destinatarios: DestinatarioDaTela[] = linhas.map((l) => {
    contagem[l.situacao]++;
    const agendado = l.situacao === "agendado" ? l.inscricao.next_eval_at : null;
    if (agendado && (!proximo || agendado < proximo)) proximo = agendado;
    const c = contatos.get(l.inscricao.contact_id);
    return {
      contact_id: l.inscricao.contact_id,
      nome: rotuloDoContato(c),
      telefone: c?.phone_number ?? null,
      situacao: l.situacao,
      agendado_para: agendado,
      enviado_em: l.enviadoEm,
      respondeu_em: l.respondeuEm,
      erro: l.situacao === "falhou" ? l.inscricao.last_error : null,
    };
  });
  destinatarios.sort((a, b) => {
    const ka = a.enviado_em ?? a.agendado_para ?? "9999";
    const kb = b.enviado_em ?? b.agendado_para ?? "9999";
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });

  return {
    id: p.id,
    nome: nomeSemPrefixo(p.name),
    estado: estadoVisivel(p.params, contagem),
    etiquetas: p.params.etiquetas,
    canal_id: p.params.canal_id,
    canal_nome: canais.find((c) => c.id === p.params.canal_id)?.display_name ?? null,
    imagem_url: await linkDaImagem(admin, p.params.imagem),
    criada_em: p.created_at,
    objetivo: p.params.objetivo,
    ritmo: p.params.ritmo,
    contagem,
    proximo_envio: proximo,
    destinatarios,
  };
}

async function gravarEstado(
  admin: SupabaseClient,
  organizationId: string,
  p: PointerDaCampanha,
  estado: EstadoDaCampanha,
): Promise<void> {
  const { error } = await admin
    .from("followup_flow_pointers")
    .update({
      trigger_config: { kind: "campanha", params: { ...p.params, estado }, cancel_on_reply: true },
      ...(estado === "cancelada" ? { status: "disabled" } : {}),
      updated_at: new Date().toISOString(),
    })
    .eq("organization_id", organizationId)
    .eq("id", p.id);
  falha(error);
}

/**
 * Tira da fila quem ainda NÃO recebeu (parado no gatilho). Quem já está no meio
 * do envio termina — cortar ali deixaria a mensagem pela metade do caminho.
 */
async function tirarDaFila(
  admin: SupabaseClient,
  organizationId: string,
  pointerId: string,
  motivo: string,
): Promise<number> {
  const agora = new Date().toISOString();
  const { data, error } = await admin
    .from("followup_enrollments")
    .update({
      status: "cancelled",
      cancel_reason: motivo,
      next_eval_at: null,
      claimed_until: null,
      outcome: null,
      completed_at: agora,
      updated_at: agora,
    })
    .eq("organization_id", organizationId)
    .eq("pointer_id", pointerId)
    .eq("status", "active")
    .eq("current_node_id", NO_GATILHO)
    // Inscrição já pega pelo motor neste instante (lease vivo) fica: ela já vai enviar.
    .or(`claimed_until.is.null,claimed_until.lt."${agora}"`)
    .select("id");
  falha(error);
  return (data ?? []).length;
}

export async function pausarCampanha(admin: SupabaseClient, organizationId: string, id: string): Promise<number> {
  const p = await carregarPointer(admin, organizationId, id);
  if (p.params.estado !== "enviando") {
    throw new ErroDeCampanha("estado_invalido", "Só dá para pausar uma campanha que está enviando.", 409);
  }
  const tirados = await tirarDaFila(admin, organizationId, p.id, MOTIVO_PAUSA);
  await gravarEstado(admin, organizationId, p, "pausada");
  return tirados;
}

export async function cancelarCampanha(admin: SupabaseClient, organizationId: string, id: string): Promise<number> {
  const p = await carregarPointer(admin, organizationId, id);
  if (p.params.estado === "cancelada") {
    throw new ErroDeCampanha("estado_invalido", "Esta campanha já foi cancelada.", 409);
  }
  const tirados = await tirarDaFila(admin, organizationId, p.id, MOTIVO_CANCELAMENTO);
  await gravarEstado(admin, organizationId, p, "cancelada");
  return tirados;
}

/**
 * Volta a enviar para quem ficou parado na pausa. O público é conferido DE NOVO:
 * quem pediu para sair, entrou em outro follow-up ou perdeu a etiqueta durante a
 * pausa não recebe. A agenda recomeça agora, contando no teto de hoje o que já
 * saiu.
 */
export async function retomarCampanha(
  admin: SupabaseClient,
  organizationId: string,
  id: string,
  agora: Date,
): Promise<number> {
  const p = await carregarPointer(admin, organizationId, id);
  if (p.params.estado !== "pausada") {
    throw new ErroDeCampanha("estado_invalido", "Só dá para retomar uma campanha pausada.", 409);
  }
  if (!p.active_version_id) throw new Error("campanha sem versão publicada");

  const inscricoes = await inscricoesDe(admin, organizationId, [p.id]);
  const ultima = new Map<string, InscricaoDaCampanha>();
  for (const i of inscricoes) ultima.set(i.contact_id, i);
  const pausados = [...ultima.values()].filter((i) => i.cancel_reason === MOTIVO_PAUSA).map((i) => i.contact_id);

  const publico = await publicoFinal(admin, organizationId, p.params.etiquetas);
  const podem = new Set(publico.recebem);
  const voltam = pausados.filter((c) => podem.has(c));

  const fuso = await fusoDaOrganizacao(admin, organizationId);
  const envios = await enviosDe(admin, organizationId, inscricoes.map((i) => i.id));
  const jaNoDia = contarPorDia([...envios.values()].map((s) => new Date(s)), fuso);
  const horarios = planejarHorarios(agora, voltam.length, p.params.ritmo, fuso, `${p.id}:${agora.toISOString()}`, jaNoDia);
  const entraram = await inscrever(admin, organizationId, p.id, p.active_version_id, voltam, horarios);
  await gravarEstado(admin, organizationId, p, "enviando");
  return entraram;
}

/** Etiquetas da organização com quantos contatos têm cada uma (para escolher o público). */
export async function etiquetasDaOrganizacao(
  admin: SupabaseClient,
  organizationId: string,
): Promise<{ etiqueta: string; contatos: number }[]> {
  const contagem = new Map<string, number>();
  for (let de = 0; ; de += PAGINA) {
    const { data, error } = await admin
      .from("contacts")
      .select("tags")
      .eq("organization_id", organizationId)
      .not("tags", "eq", "{}")
      .order("id", { ascending: true })
      .range(de, de + PAGINA - 1);
    falha(error);
    const linhas = (data ?? []) as { tags: string[] | null }[];
    for (const l of linhas) for (const t of l.tags ?? []) contagem.set(t, (contagem.get(t) ?? 0) + 1);
    if (linhas.length < PAGINA) break;
  }
  return [...contagem.entries()]
    .map(([etiqueta, contatos]) => ({ etiqueta, contatos }))
    .sort((a, b) => a.etiqueta.localeCompare(b.etiqueta, "pt-BR"));
}
