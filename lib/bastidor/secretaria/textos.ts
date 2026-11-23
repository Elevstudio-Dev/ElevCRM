/**
 * O QUE A IA ESCREVE À SECRETARIA. Tudo texto fixo, em código: a conversa de agenda não passa por modelo na hora
 * de RESPONDER (o modelo só LÊ, em `leitura.ts`). Assim a resposta é previsível, auditável e não inventa nada.
 *
 * Tom: curto, direto, de colega de trabalho. A secretaria está no meio do expediente.
 */
import { diaLocalISO } from "@/lib/agenda/fuso";
import { rotuloDaHora, rotuloDoDia } from "@/lib/agenda/secretaria/relato";
import type { ResultadoDaConferencia } from "@/lib/agenda/secretaria/relatos";

const FUSO_PADRAO = "America/Sao_Paulo";

export const TEXTO_NAO_ENTENDI_A_MENSAGEM =
  "Não consegui ler sua mensagem. Pode escrever a agenda em texto? Por exemplo: terça 14h Maria, 15h João; quarta fechado.";

export const TEXTO_NAO_ENTENDI_A_AGENDA =
  "Não consegui entender a agenda por essa mensagem. Pode me mandar dia por dia? Por exemplo: terça 14h Maria, 15h João; quarta fechado.";

export const TEXTO_OUTRO_ASSUNTO =
  "Oi! Eu cuido da agenda por aqui. Quando puder, me conta quem está marcado e se algum dia está fechado.";

export const TEXTO_DO_NAO = "Sem problema! O que está diferente? Me diga o que corrigir ou mande a agenda de novo.";

export const TEXTO_SEM_NADA_PARA_CONFERIR =
  "Não tenho nenhuma agenda esperando conferência agora. Me conta como está a agenda quando puder.";

/** Ela respondeu a um resumo que já passou da validade (12 h): nada foi aplicado e ela precisa saber disso. */
export const TEXTO_RESUMO_VENCIDO =
  "Esse resumo da agenda já venceu (passou mais de 12 horas) e eu não atualizei nada com ele. Me manda a agenda de novo, por favor, que eu confiro com você.";

/**
 * O "sim" veio depois de uma mensagem de alguém da equipe, não do agente: pode ser resposta a ela. O resumo volta,
 * inteiro, com a pergunta — e o próximo "sim" confirma.
 */
export function textoDeConfirmarOResumo(resumo: string): string {
  return `Só para eu não errar a agenda: esse *sim* é para este resumo?\n\n${resumo}`;
}

export const TEXTO_FALTA_CONFIGURAR =
  "Não consegui salvar a agenda agora: falta uma configuração no sistema. Peça à equipe do CRM para conferir.";

const EXEMPLO_DA_AGENDA = "Por exemplo: hoje 14h Maria, 15h João; sexta fechado.";

/**
 * A pergunta diária. O cumprimento acompanha o horário em que a pergunta foi MARCADA (não o instante do envio):
 * de manhã pergunta de hoje, à tarde de hoje e dos próximos dias, ao fim do dia do dia seguinte.
 */
export function textoDaPergunta(horario: string): string {
  const hora = Number(horario.split(":")[0] ?? "0");
  if (hora < 12) {
    return `Bom dia! Como está a agenda de hoje? Me conta quem está marcado e se algum dia está fechado, que eu atualizo por aqui. ${EXEMPLO_DA_AGENDA}`;
  }
  if (hora < 18) {
    return `Boa tarde! Mudou alguma coisa na agenda de hoje ou dos próximos dias? Me conta quem está marcado e eu atualizo. ${EXEMPLO_DA_AGENDA}`;
  }
  return `Antes de encerrar o dia: como ficou a agenda de amanhã e dos próximos dias? Me conta quem está marcado e se algum dia está fechado. ${EXEMPLO_DA_AGENDA}`;
}

/** O lembrete (uma vez só). Diz por que importa, sem cobrar. */
export const TEXTO_DO_LEMBRETE_DA_PERGUNTA =
  "Só relembrando a agenda: quando puder, me conta quem está marcado. Assim consigo oferecer horários certos aos pacientes.";

/**
 * O lembrete de CONFIRMAR o resumo (uma vez por resumo), que ocupa o lugar da pergunta diária enquanto um resumo
 * espera o "sim": ela já contou a agenda, perguntar de novo faria a conversa andar para trás.
 */
export const TEXTO_DO_LEMBRETE_DA_CONFERENCIA =
  "Falta só você confirmar o resumo da agenda que te mandei: responda *sim* se estiver certo, ou me diga o que corrigir.";

/** Perguntas de volta, uma por linha. Nunca grava nada. */
export function textoDeDuvida(perguntas: readonly string[]): string {
  if (perguntas.length === 1) return `Para não errar a agenda, preciso confirmar uma coisa:\n${perguntas[0]}`;
  return ["Para não errar a agenda, preciso confirmar:", ...perguntas.map((p) => `• ${p}`)].join("\n");
}

/**
 * O que mudou na agenda depois do "sim". Conta só o que ela precisa saber — inclusive o horário que NÃO foi anotado
 * porque a agenda daqui já tinha outro compromisso nele (marcado pela IA de vendas ou por alguém da equipe): nada
 * do que ela disse some calado.
 */
export function textoDeAgendaAtualizada(
  r: Pick<ResultadoDaConferencia, "criados" | "cancelados" | "diasFechados"> & {
    conflitos?: ResultadoDaConferencia["conflitos"];
  },
  fuso = FUSO_PADRAO,
): string {
  const partes: string[] = [];
  if (r.criados > 0) partes.push(`${r.criados} ${r.criados === 1 ? "horário anotado" : "horários anotados"}`);
  if (r.cancelados > 0) partes.push(`${r.cancelados} ${r.cancelados === 1 ? "removido" : "removidos"}`);
  if (r.diasFechados > 0) partes.push(`${r.diasFechados} ${r.diasFechados === 1 ? "dia fechado" : "dias fechados"}`);
  const detalhe = partes.length > 0 ? ` (${partes.join(", ")})` : "";
  const texto = `Pronto, agenda atualizada${detalhe}. Se mudar alguma coisa, é só me avisar por aqui.`;

  const conflitos = r.conflitos ?? [];
  if (conflitos.length === 0) return texto;
  const linhas = conflitos.map((c) => {
    const quando = new Date(c.inicio);
    return `• ${rotuloDoDia(diaLocalISO(quando, fuso))} ${rotuloDaHora(quando, fuso)} ${c.nome}`;
  });
  const cabeca =
    conflitos.length === 1
      ? "Só não anotei este horário, porque aqui já tinha outro compromisso marcado nele:"
      : "Só não anotei estes horários, porque aqui já tinha outro compromisso marcado neles:";
  return [texto, "", cabeca, ...linhas, "Se algum estiver errado, me avise que a equipe confere."].join("\n");
}
