/**
 * COMO UM RELATO NOVO MUDA A AGENDA — o plano, sem tocar em banco.
 *
 * A secretaria conta o dia inteiro a cada vez ("hoje: 14h Maria, 15h João"), não um acréscimo. Então o relato novo
 * SUBSTITUI o anterior, mas só dentro da janela de dias que ele cobre e só no que um relato anterior criou:
 *
 *  - o que já existe e continua no relato: mantém (nada é regravado, o lembrete e o histórico seguem);
 *  - o que o relato traz e não existe: cria;
 *  - o que um relato criou, está na janela e sumiu do relato novo: cancela (a secretaria desmarcou ou corrigiu);
 *  - compromisso que NÃO nasceu de relato (marcado à mão, pela IA de vendas) nunca é cancelado nem alterado; se
 *    ocupa o mesmo horário de um compromisso do relato, o espelho daquele horário não é criado e vira CONFLITO;
 *  - o que já passou não é cancelado: é histórico;
 *  - trocou o paciente de um MESMO horário: o antigo é cancelado ANTES do novo ser criado (`substituirIds`).
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

/**
 * Um horário do relato que NÃO vira compromisso porque o banco só aceita um compromisso vivo por (dono, início)
 * (índice `calendar_appointments_sem_duplicata_idx`). A hora continua tomada — por outra coisa —, então a agenda
 * não fica com menos; e o conflito volta para a secretaria saber, em vez de sumir calado.
 *
 *  - `outro_compromisso`: o horário é de um compromisso que NÃO nasceu de relato (IA de vendas, marcação à mão).
 *    Um relato nunca toca nele.
 *  - `horario_ja_ocupado`: o horário já é de um compromisso de relato que FICA (mantido, ou já passou e é
 *    histórico), ou de outra pessoa do MESMO relato no mesmo horário.
 */
export interface ConflitoDeHorario {
  inicio: Date;
  nome: string;
  porque: "outro_compromisso" | "horario_ja_ocupado";
}

/** Um compromisso que não nasceu de relato, ocupando um início. */
export interface OcupanteForaDoRelato {
  inicio: Date;
  /** Título do compromisso e nome do contato (quando há). Vazios são ignorados. */
  nomes: string[];
}

/**
 * O ocupante é o MESMO paciente que o relato lista? TODAS as palavras do nome do relato (normalizadas como nos
 * "mantidos": sem acento, sem caixa) existem como palavras INTEIRAS em algum nome do ocupante (título ou contato).
 * Ex.: o relato diz "Maria" e a IA de vendas marcou "Avaliação - Maria Souza". Nome vazio nunca casa (ocupante sem
 * título é "outra pessoa").
 */
export function mesmoPaciente(nomeDoRelato: string, nomesDoOcupante: readonly string[]): boolean {
  const alvo = palavrasDoNome(nomeDoRelato);
  if (alvo.length === 0) return false;
  return nomesDoOcupante.some((n) => {
    const doOcupante = new Set(palavrasDoNome(n ?? ""));
    return alvo.every((p) => doOcupante.has(p));
  });
}

/**
 * As PALAVRAS de um nome, normalizadas (sem acento, sem caixa), separadas por espaço ou pontuação. Comparar palavras
 * inteiras, e não pedaços de texto: "Lia" não é "Avaliação", e "Ana" não é "Juliana" — um falso "mesmo paciente"
 * esconderia da secretaria um conflito de verdade.
 */
function palavrasDoNome(nome: string): string[] {
  return normalizarNome(nome)
    .split(/[^a-z0-9]+/)
    .filter((p) => p !== "");
}

export interface PlanoDeSincronizacao {
  criar: NovoCompromisso[];
  cancelarIds: string[];
  /**
   * SUBCONJUNTO de `cancelarIds`: os compromissos de relato que ocupam o MESMO início de um compromisso a criar
   * (a secretaria trocou o paciente daquele horário). Estes são cancelados ANTES do insert — senão o insert bate no
   * índice único e a conferência inteira cai. Todo o resto continua "criar antes de cancelar".
   */
  substituirIds: string[];
  manterIds: string[];
  fecharDias: Array<{ data: string; motivo: string | null }>;
  reabrirIds: string[];
  conflitos: ConflitoDeHorario[];
  /**
   * Do relato, mas JÁ na agenda por outro caminho: o horário é de um compromisso que não é de relato e é o MESMO
   * paciente (a IA de vendas marcou). Não vira espelho nem conflito: não há nada a avisar à secretaria.
   */
  jaNaAgenda: NovoCompromisso[];
}

const chaveDe = (nome: string, inicio: Date): string => `${normalizarNome(nome)}|${inicio.toISOString()}`;

export function planejarSincronizacao(entrada: {
  /** Compromissos VIVOS que um relato criou e que caem na janela. */
  existentes: CompromissoDoRelato[];
  /** Dias fechados que um relato criou e que caem na janela. */
  fechamentosExistentes: FechamentoDoRelato[];
  /**
   * Os compromissos VIVOS do mesmo dono, na janela, que NÃO nasceram de relato (IA de vendas, mão). Nunca são tocados.
   * `nomes`: o título e, se houver, o nome do contato — para reconhecer que é o MESMO paciente que o relato lista.
   */
  ocupadosForaDoRelato?: OcupanteForaDoRelato[];
  relato: RelatoLido;
  fuso: string;
  /** Duração do atendimento, para quando a secretaria só disse a hora de início. */
  duracaoMin: number;
  /** INJETADO: nunca `new Date()` aqui dentro. */
  agora: Date;
}): PlanoDeSincronizacao {
  const { existentes, fechamentosExistentes, relato, fuso, duracaoMin, agora } = entrada;
  const ocupadosForaDoRelato = entrada.ocupadosForaDoRelato ?? [];

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
  const aCriar = [...doRelato.entries()].filter(([chave]) => !jaExiste.has(chave)).map(([, v]) => v);
  aCriar.sort((a, b) => a.inicio.getTime() - b.inicio.getTime() || a.nome.localeCompare(b.nome));

  // 3. O MESMO horário. O banco aceita UM compromisso vivo por (dono, início). Quem ocupa cada início depois do plano:
  //    - compromisso que não é de relato: nunca sai (conflito `outro_compromisso`);
  //    - compromisso de relato que NÃO vai ser cancelado (mantido, ou passado): fica (conflito `horario_ja_ocupado`);
  //    - compromisso de relato que VAI ser cancelado: libera o horário — e, se alguém novo entra nele, é substituição.
  const cancelar = new Set(cancelarIds);
  const deOutro = new Map<number, string[]>();
  for (const o of ocupadosForaDoRelato) {
    const t = o.inicio.getTime();
    deOutro.set(t, [...(deOutro.get(t) ?? []), ...o.nomes]);
  }
  const deQuemFica = new Set(existentes.filter((e) => !cancelar.has(e.id)).map((e) => e.inicio.getTime()));
  const liberadosPor = new Map<number, string[]>();
  for (const e of existentes) {
    if (!cancelar.has(e.id)) continue;
    const t = e.inicio.getTime();
    liberadosPor.set(t, [...(liberadosPor.get(t) ?? []), e.id]);
  }

  const criar: NovoCompromisso[] = [];
  const conflitos: ConflitoDeHorario[] = [];
  const jaNaAgenda: NovoCompromisso[] = [];
  const substituir = new Set<string>();
  const tomados = new Set<number>();
  for (const c of aCriar) {
    const t = c.inicio.getTime();
    const ocupante = deOutro.get(t);
    if (ocupante !== undefined && mesmoPaciente(c.nome, ocupante)) {
      jaNaAgenda.push(c);
      continue;
    }
    if (ocupante !== undefined) {
      conflitos.push({ inicio: c.inicio, nome: c.nome, porque: "outro_compromisso" });
      continue;
    }
    if (deQuemFica.has(t) || tomados.has(t)) {
      conflitos.push({ inicio: c.inicio, nome: c.nome, porque: "horario_ja_ocupado" });
      continue;
    }
    tomados.add(t);
    criar.push(c);
    for (const id of liberadosPor.get(t) ?? []) substituir.add(id);
  }
  const substituirIds = cancelarIds.filter((id) => substituir.has(id));

  // 4. Dias fechados.
  const fechadosNoRelato = new Map(relato.dias_fechados.map((d) => [d.data, d.motivo ?? null]));
  const jaFechados = new Set(fechamentosExistentes.map((f) => f.data));
  const fecharDias = [...fechadosNoRelato.entries()]
    .filter(([data]) => !jaFechados.has(data))
    .map(([data, motivo]) => ({ data, motivo }));
  const reabrirIds = fechamentosExistentes.filter((f) => !fechadosNoRelato.has(f.data)).map((f) => f.id);

  return { criar, cancelarIds, substituirIds, manterIds, fecharDias, reabrirIds, conflitos, jaNaAgenda };
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
