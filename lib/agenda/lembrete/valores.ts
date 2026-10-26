/**
 * O QUE VAI NO TEXTO DO LEMBRETE — e como um modelo aprovado pela Meta o recebe.
 *
 * Duas pontas, uma regra:
 *   - o lembrete tem sete DADOS conhecidos (nome, data, hora, serviço, profissional,
 *     local, clínica);
 *   - o modelo aprovado tem SLOTS (`{{1}}` ou `{{nome}}`), derivados do contrato
 *     (`deriveTemplateContract`) e nunca redigitados.
 *
 * ─── Por que NÃO existe uma tela de mapeamento ────────────────────────────────
 *
 * Mapear slot → dado numa tela é mais um lugar para o contrato divergir da
 * definição (a doutrina de canal chama isso de "redigitar o contrato"). Em vez
 * disso o mapeamento é CONVENÇÃO, verificada na hora de salvar o tipo de
 * agendamento:
 *
 *   modelo NOMEADO     {{nome}} {{data}} {{hora}} {{servico}} {{profissional}}
 *                      {{local}} {{clinica}}  (e os sinônimos de SINONIMOS)
 *   modelo POSICIONAL  ordem fixa: 1=nome 2=data 3=hora 4=serviço 5=profissional 6=local
 *
 * Slot fora disso, variável em cabeçalho ou botão, ou tipo que não é texto ⇒ o
 * modelo é RECUSADO ao salvar. Se escapar (o modelo mudou na Meta depois), o envio
 * falha com o nome do slot — nunca manda `{{3}}` cru para um paciente.
 */
import { slotKey } from "@/lib/channels/meta/build-components";
import type { ParamSlot, TemplateContract } from "@/lib/channels/meta/template-contract";
import { tagDeIdioma } from "@/lib/i18n/datas";
import { IDIOMA_PADRAO } from "@/lib/i18n/idiomas";

export const CAMPOS_DO_LEMBRETE = [
  "nome",
  "data",
  "hora",
  "servico",
  "profissional",
  "local",
  "clinica",
] as const;
export type CampoDoLembrete = (typeof CAMPOS_DO_LEMBRETE)[number];

/** Em modelo posicional, `{{n}}` é o n-ésimo desta lista. Ordem é contrato: nunca reordenar. */
export const ORDEM_POSICIONAL: readonly CampoDoLembrete[] = [
  "nome",
  "data",
  "hora",
  "servico",
  "profissional",
  "local",
];

/** Nomes que um modelo NOMEADO pode usar, em minúsculas e sem acento. */
const SINONIMOS: Record<string, CampoDoLembrete> = {
  nome: "nome",
  primeiro_nome: "nome",
  paciente: "nome",
  cliente: "nome",
  data: "data",
  dia: "data",
  hora: "hora",
  horario: "hora",
  servico: "servico",
  tipo: "servico",
  procedimento: "servico",
  consulta: "servico",
  profissional: "profissional",
  dentista: "profissional",
  medico: "profissional",
  atendente: "profissional",
  local: "local",
  endereco: "local",
  clinica: "clinica",
  empresa: "clinica",
};

export interface DadosDoLembrete {
  nome: string;
  data: string;
  hora: string;
  servico: string;
  profissional: string;
  local: string;
  clinica: string;
  /** O endereço de verdade, quando há um. `local` cai para o nome da clínica; este não. */
  localReal: string | null;
}

export type PorqueOSlotNaoServe = "fora_do_corpo" | "nao_e_texto" | "campo_desconhecido";

export interface ProblemaDoModelo {
  /** O slot como o operador o vê na Meta: `1`, `nome`, `header:1`… */
  slot: string;
  porque: PorqueOSlotNaoServe;
}

const SEM_ACENTO = /[̀-ͯ]/g;

function semAcento(s: string): string {
  return s.normalize("NFD").replace(SEM_ACENTO, "");
}

/** Que dado do lembrete este slot pede? `null` = nenhum que conheçamos. */
export function campoDoSlot(
  slot: ParamSlot,
  formato: TemplateContract["parameterFormat"],
): CampoDoLembrete | null {
  if (formato === "POSITIONAL") {
    const n = Number(slot.key);
    if (!Number.isInteger(n) || n < 1) return null;
    return ORDEM_POSICIONAL[n - 1] ?? null;
  }
  return SINONIMOS[semAcento(slot.key).toLowerCase()] ?? null;
}

/** Os slots que o lembrete não sabe preencher. Vazio = o modelo serve. */
export function problemasDoModelo(contrato: TemplateContract): ProblemaDoModelo[] {
  const problemas: ProblemaDoModelo[] = [];
  for (const slot of contrato.slots) {
    const nome = slotKey(slot.address, slot.key);
    if (slot.address.kind !== "body") {
      problemas.push({ slot: nome, porque: "fora_do_corpo" });
    } else if (slot.expects !== "text") {
      problemas.push({ slot: nome, porque: "nao_e_texto" });
    } else if (campoDoSlot(slot, contrato.parameterFormat) === null) {
      problemas.push({ slot: nome, porque: "campo_desconhecido" });
    }
  }
  return problemas;
}

/**
 * Meta recusa quebra de linha, tabulação e mais de quatro espaços seguidos num
 * parâmetro de texto. O valor é do paciente/clínica, então higienizamos aqui em vez
 * de descobrir pelo erro 132000 do envio.
 */
export function limparParametro(valor: string): string {
  return valor.replace(/\s+/g, " ").trim().slice(0, 200);
}

export type ValoresMontados =
  | { ok: true; values: Record<string, string> }
  | { ok: false; problemas: ProblemaDoModelo[] };

/** Preenche os slots do contrato com os dados do lembrete, chaveado por `slotKey`. */
export function montarValores(contrato: TemplateContract, dados: DadosDoLembrete): ValoresMontados {
  const problemas = problemasDoModelo(contrato);
  if (problemas.length > 0) return { ok: false, problemas };

  const values: Record<string, string> = {};
  for (const slot of contrato.slots) {
    const campo = campoDoSlot(slot, contrato.parameterFormat);
    // `problemasDoModelo` já garantiu que todo slot tem campo; o ramo nulo existe só
    // para o compilador e nunca é alcançado.
    if (campo === null) continue;
    values[slotKey(slot.address, slot.key)] = limparParametro(dados[campo]);
  }
  return { ok: true, values };
}

// ─── os dados em si ──────────────────────────────────────────────────────────

/**
 * A etiqueta de idioma da data que o PACIENTE lê.
 *
 * Vem da camada de i18n (o guarda `i18n-a-data-segue-o-idioma` proíbe `"pt-BR"` escrito à
 * mão), e é o idioma PADRÃO do produto de propósito: o texto do lembrete é em português —
 * o corpo do modelo aprovado e o texto padrão —, então uma data em espanhol no meio dele
 * seria o defeito que o guarda existe para impedir, só que ao contrário. Quando o texto do
 * lembrete passar a seguir o idioma da organização, é AQUI que a data o segue.
 */
const TAG_DA_DATA = tagDeIdioma(IDIOMA_PADRAO);

/** "segunda-feira, 26/10" no fuso em que o compromisso foi marcado. */
export function formatarData(inicio: Date, fuso: string): string {
  return new Intl.DateTimeFormat(TAG_DA_DATA, {
    weekday: "long",
    day: "2-digit",
    month: "2-digit",
    timeZone: fuso,
  }).format(inicio);
}

/** "14:00" — 24 h, que é como a recepção fala. */
export function formatarHora(inicio: Date, fuso: string): string {
  return new Intl.DateTimeFormat(TAG_DA_DATA, {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone: fuso,
  }).format(inicio);
}

/**
 * O primeiro nome, em caixa de nome próprio.
 *
 * O nome vem do WhatsApp (apelido, emoji, CAIXA ALTA). Pega a primeira sequência
 * de LETRAS: "👑 MARIA da Silva" → "Maria". Sem letra nenhuma, "paciente" — que
 * cabe em "Olá, paciente!" sem soar como erro de sistema.
 */
export function primeiroNome(bruto: string | null | undefined): string {
  const m = /[\p{L}\p{M}][\p{L}\p{M}'’-]*/u.exec(bruto ?? "");
  if (!m) return "paciente";
  const palavra = m[0];
  return palavra.charAt(0).toLocaleUpperCase("pt-BR") + palavra.slice(1).toLocaleLowerCase("pt-BR");
}

export function dadosDoLembrete(entrada: {
  inicio: Date;
  fuso: string;
  nomeDoContato: string | null | undefined;
  servico: string;
  profissional: string | null | undefined;
  localReal: string | null | undefined;
  clinica: string | null | undefined;
}): DadosDoLembrete {
  const clinica = entrada.clinica?.trim() || "nossa clínica";
  const localReal = entrada.localReal?.trim() || null;
  return {
    nome: primeiroNome(entrada.nomeDoContato),
    data: formatarData(entrada.inicio, entrada.fuso),
    hora: formatarHora(entrada.inicio, entrada.fuso),
    servico: entrada.servico.trim() || "atendimento",
    profissional: entrada.profissional?.trim() || "a nossa equipe",
    local: localReal ?? clinica,
    clinica,
    localReal,
  };
}

/**
 * O texto de quando não há modelo e o canal aceita texto livre.
 *
 * "do seu horário" e não "da sua consulta": o tipo pode ser Retorno (masculino) ou
 * Avaliação (feminino), e a clínica escolhe o nome. Evita concordância errada
 * sem pedir nada ao operador.
 */
export function textoPadraoDoLembrete(d: DadosDoLembrete): string {
  const local = d.localReal ? ` Local: ${d.localReal}.` : "";
  return (
    `Olá, ${d.nome}! Lembrete do seu horário: ${d.servico}, ${d.data} às ${d.hora}, ` +
    `com ${d.profissional}.${local} Se precisar remarcar, é só responder esta mensagem.`
  );
}
