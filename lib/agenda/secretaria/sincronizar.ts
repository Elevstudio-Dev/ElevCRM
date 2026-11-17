/**
 * COMO UM RELATO NOVO MUDA A AGENDA — o plano, sem tocar em banco.
 *
 * A secretaria conta o dia inteiro a cada vez ("hoje: 14h Maria, 15h João"), não um acréscimo. Então o relato novo
 * SUBSTITUI o anterior, mas só dentro da janela de dias que ele cobre e só no que um relato anterior criou:
 *
 *  - o que já existe e continua no relato: mantém (nada é regravado, o lembrete e o histórico seguem);
 *  - o que o relato traz e não existe: cria;
 *  - o que um relato criou, está na janela e sumiu do relato novo: cancela (a secretaria desmarcou ou corrigiu);
 *  - compromisso que NÃO nasceu de relato (marcado à mão, pela IA de vendas) nunca entra nesta conta;
 *  - o que já passou não é cancelado: é histórico.
 *
 * Quem aplica (`aplicar.ts`) só executa este plano. Separar decidir de gravar é o que torna a regra testável sem
 * banco e o relato REPROCESSÁVEL: rodar o mesmo relato duas vezes não muda nada na segunda.
 */
import { diaLocalISO } from "../fuso";
import { normalizarNome, type RelatoLido } from "./relato";

/** O marcador, no `reason` da exceção por data, de que o dia fechado veio de um relato. */
export const PREFIXO_DO_MOTIVO = "[secretaria] ";

export interface CompromissoDoRelato {
  id: string;
  /** `calendar_appointments.title` — o nome, como a secretaria escreveu. */
  nome: string;
  inicio: Date;
  fim: Date;
}

export interface FechamentoDoRelato {
  id: string;
  /** `YYYY-MM-DD` */
  data: string;
}

export interface NovoCompromisso {
  nome: string;
  inicio: Date;
  fim: Date;
}

export interface PlanoDeSincronizacao {
  criar: NovoCompromisso[];
  cancelarIds: string[];
  manterIds: string[];
  fecharDias: Array<{ data: string; motivo: string | null }>;
  reabrirIds: string[];
}

const chaveDe = (nome: string, inicio: Date): string => `${normalizarNome(nome)}|${inicio.toISOString()}`;

export function planejarSincronizacao(entrada: {
  /** Compromissos VIVOS que um relato criou e que caem na janela. */
  existentes: CompromissoDoRelato[];
  /** Dias fechados que um relato criou e que caem na janela. */
  fechamentosExistentes: FechamentoDoRelato[];
  relato: RelatoLido;
  fuso: string;
  /** Duração do atendimento, para quando a secretaria só disse a hora de início. */
  duracaoMin: number;
  /** INJETADO: nunca `new Date()` aqui dentro. */
  agora: Date;
}): PlanoDeSincronizacao {
  const { existentes, fechamentosExistentes, relato, fuso, duracaoMin, agora } = entrada;

  // 1. O que o relato traz, sem repetição (a mesma pessoa no mesmo horário citada duas vezes é um só compromisso).
  const doRelato = new Map<string, NovoCompromisso>();
  for (const m of relato.marcados) {
    const inicio = new Date(m.inicio);
    const fim = m.fim ? new Date(m.fim) : new Date(inicio.getTime() + duracaoMin * 60_000);
    const chave = chaveDe(m.nome, inicio);
    if (!doRelato.has(chave)) doRelato.set(chave, { nome: m.nome, inicio, fim });
  }

  // 2. Cruza com o que já existe.
  const manterIds: string[] = [];
  const cancelarIds: string[] = [];
  const jaExiste = new Set<string>();
  for (const e of existentes) {
    const chave = chaveDe(e.nome, e.inicio);
    if (doRelato.has(chave) && !jaExiste.has(chave)) {
      manterIds.push(e.id);
      jaExiste.add(chave);
    } else if (e.fim.getTime() >= agora.getTime()) {
      // Sumiu do relato (ou é duplicata do que já mantemos) e ainda não aconteceu: cancela. O que já passou é histórico.
      cancelarIds.push(e.id);
    }
  }
  const criar = [...doRelato.entries()].filter(([chave]) => !jaExiste.has(chave)).map(([, v]) => v);
  criar.sort((a, b) => a.inicio.getTime() - b.inicio.getTime());

  // 3. Dias fechados.
  const fechadosNoRelato = new Map(relato.dias_fechados.map((d) => [d.data, d.motivo ?? null]));
  const jaFechados = new Set(fechamentosExistentes.map((f) => f.data));
  const fecharDias = [...fechadosNoRelato.entries()]
    .filter(([data]) => !jaFechados.has(data))
    .map(([data, motivo]) => ({ data, motivo }));
  const reabrirIds = fechamentosExistentes.filter((f) => !fechadosNoRelato.has(f.data)).map((f) => f.id);

  return { criar, cancelarIds, manterIds, fecharDias, reabrirIds };
}

/** O motivo gravado na exceção: o prefixo (que diz "veio de um relato") e, se houver, o que a secretaria disse. */
export function motivoDoFechamento(motivo: string | null): string {
  return `${PREFIXO_DO_MOTIVO}${motivo ?? "fechado"}`.slice(0, 200);
}

/** O compromisso cai num dia local que o relato fechou? (Um fechamento com compromisso marcado é inconsistência.) */
export function conflitosComFechamento(relato: RelatoLido, fuso: string): string[] {
  const fechados = new Set(relato.dias_fechados.map((d) => d.data));
  return relato.marcados.filter((m) => fechados.has(diaLocalISO(new Date(m.inicio), fuso))).map((m) => m.nome);
}
