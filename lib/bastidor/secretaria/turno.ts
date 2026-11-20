/**
 * O TURNO DA SECRETARIA — a decisão do que fazer com UMA mensagem dela.
 *
 * Este arquivo é só a ORQUESTRAÇÃO, sem banco, sem modelo e sem canal: tudo que toca o mundo entra por `Portas`.
 * Assim o roteiro inteiro (relato novo, "sim", correção, dúvida, replay) é testado com portas de mentira, e o
 * handler do worker (`lib/agent-engine/agent/bastidor-turn.ts`) só liga as portas de verdade.
 *
 * O roteiro:
 *
 *   mensagem                                   há resumo esperando conferência?
 *   ─────────                                  ───────────────────────────────
 *   "sim"                                      sim → aplica na agenda e confirma
 *   "não"                                      sim → pergunta o que corrigir (o resumo continua esperando)
 *   qualquer outra coisa                       sim → relê COMO CORREÇÃO do resumo; novo resumo para conferir
 *   "sim" depois de mensagem HUMANA            sim → reenvia o resumo perguntando se o "sim" é para ele
 *   "sim"/"não" sem nada esperando             — → "não tenho nada esperando" (ou "esse resumo já venceu")
 *   qualquer outra coisa                       não → lê como relato novo
 *
 * Três regras que não se negociam:
 *  1. A agenda SÓ muda no "sim" inequívoco (`interpretarRespostaDeConferencia` é conservadora de propósito).
 *  2. Dúvida vira pergunta, nunca palpite: o relato com ambiguidade nem é registrado.
 *  3. Resumo velho não vale: um "sim" dado 12 horas depois do resumo não confirma nada (a agenda mudou nesse meio
 *     tempo). As 12 horas vão até o instante em que ELA respondeu, não até o job rodar.
 */
import type { RelatoLido } from "@/lib/agenda/secretaria/relato";
import { resumoParaConferencia } from "@/lib/agenda/secretaria/relato";
import type { ResultadoDaConferencia } from "@/lib/agenda/secretaria/relatos";

import { lerRespostaDoModelo, montarPromptDeLeitura } from "./leitura";
import { interpretarRespostaDeConferencia } from "./resposta";
import {
  TEXTO_DO_NAO,
  TEXTO_FALTA_CONFIGURAR,
  TEXTO_NAO_ENTENDI_A_AGENDA,
  TEXTO_NAO_ENTENDI_A_MENSAGEM,
  TEXTO_OUTRO_ASSUNTO,
  TEXTO_RESUMO_VENCIDO,
  TEXTO_SEM_NADA_PARA_CONFERIR,
  textoDeAgendaAtualizada,
  textoDeConfirmarOResumo,
  textoDeDuvida,
} from "./textos";

/** Quanto tempo um resumo espera pelo "sim". Depois disso a agenda pode ter mudado e ele é descartado. */
export const VALIDADE_DO_RESUMO_HORAS = 12;

export interface RelatoPendente {
  id: string;
  lido: RelatoLido;
  criadoEm: Date;
}

export interface Portas {
  agora: Date;
  /** Fuso da agenda (o da jornada do dono; senão o da organização). */
  fuso: string;
  /**
   * O que ela escreveu desde a última resposta nossa, na ordem (mensagens em rajada juntas). Vazio = não leu nada.
   * "Resposta nossa" NÃO inclui as mensagens automáticas de agenda do cron (pergunta, lembrete): ver
   * `lib/agent-engine/agent/bastidor-mensagens.ts`.
   */
  texto: string;
  /** Quando ela mandou a última mensagem de `texto`. É até AQUI que a validade do resumo é medida. Nulo = agora. */
  respondeuEm: Date | null;
  /**
   * Quem escreveu a última resposta nossa antes do `texto`. Um "sim" depois de uma mensagem HUMANA (alguém da equipe
   * escreveu do aparelho) pode ser resposta a ela, não ao resumo: nesse caso o resumo é reenviado com a pergunta.
   */
  ultimaRespostaNossa: "bastidor" | "humana" | "nenhuma";
  /** Resumo esperando conferência, se houver. */
  pendente: RelatoPendente | null;
  /** Relato que ESTA mesma mensagem já gerou numa tentativa anterior do job (replay). */
  jaRegistrado: { id: string; estado: string; lido: RelatoLido } | null;

  /** O modelo lê o prompt e devolve texto. Falha propaga (o job tenta de novo). */
  lerComModelo(prompt: string): Promise<string>;
  registrar(lido: RelatoLido, texto: string): Promise<{ id: string; duplicado: boolean }>;
  conferir(relatoId: string): Promise<ResultadoDaConferencia>;
  marcarCorrigido(relatoId: string): Promise<void>;
  descartar(relatoId: string): Promise<void>;
  /** Manda a resposta. Quem chama não precisa saber se saiu: veto da cadeia é decisão de negócio, não erro. */
  enviar(texto: string): Promise<void>;
}

export type DesfechoDoTurno =
  | { acao: "agenda_conferida"; resultado: ResultadoDaConferencia }
  | { acao: "resumo_enviado"; relatoId: string; corrigiu: boolean; replay: boolean }
  | {
      acao: "perguntou";
      motivo: "duvida" | "ilegivel" | "nao" | "sem_texto" | "sem_nada_para_conferir" | "resumo_vencido" | "confirmar_resumo";
    }
  | { acao: "outro_assunto" }
  | { acao: "falta_configurar" };

const idadeEmHoras = (de: Date, ate: Date): number => (ate.getTime() - de.getTime()) / 3_600_000;

export async function executarTurnoDaSecretaria(p: Portas): Promise<DesfechoDoTurno> {
  // Replay: esta mesma mensagem já virou resumo (o job caiu depois de registrar, antes de enviar). Reenvia o MESMO
  // resumo — o ledger de envio deduplica por (job, posição), então não sai duas vezes.
  if (p.jaRegistrado && p.jaRegistrado.estado === "lido") {
    await p.enviar(resumoParaConferencia(p.jaRegistrado.lido, p.fuso));
    return { acao: "resumo_enviado", relatoId: p.jaRegistrado.id, corrigiu: false, replay: true };
  }

  if (p.texto.trim() === "") {
    await p.enviar(TEXTO_NAO_ENTENDI_A_MENSAGEM);
    return { acao: "perguntou", motivo: "sem_texto" };
  }

  // A validade é medida até quando ELA RESPONDEU: um "sim" dado 8 minutos depois do resumo continua valendo se o job
  // só rodar no dia seguinte (fila parada, falha e reprocessamento). Sem o instante da resposta, mede até agora.
  let pendente = p.pendente;
  let venceu = false;
  if (pendente && idadeEmHoras(pendente.criadoEm, p.respondeuEm ?? p.agora) > VALIDADE_DO_RESUMO_HORAS) {
    await p.descartar(pendente.id);
    pendente = null;
    venceu = true;
  }

  const resposta = interpretarRespostaDeConferencia(p.texto);

  if (pendente) {
    if (resposta === "sim" && p.ultimaRespostaNossa !== "bastidor") {
      // O "sim" veio depois de uma mensagem HUMANA (ou o resumo nem chegou a sair): pode ser resposta a outra coisa.
      // A agenda só muda no "sim" inequívoco — então o resumo volta, com a pergunta, e o relato continua esperando.
      // O próximo "sim" vem depois desta mensagem do agente e confirma.
      await p.enviar(textoDeConfirmarOResumo(resumoParaConferencia(pendente.lido, p.fuso)));
      return { acao: "perguntou", motivo: "confirmar_resumo" };
    }
    if (resposta === "sim") {
      try {
        const resultado = await p.conferir(pendente.id);
        await p.enviar(textoDeAgendaAtualizada(resultado, p.fuso));
        return { acao: "agenda_conferida", resultado };
      } catch (err) {
        if (err instanceof Error && err.message === "dono_da_agenda_nao_definido") {
          await p.enviar(TEXTO_FALTA_CONFIGURAR);
          return { acao: "falta_configurar" };
        }
        throw err;
      }
    }
    if (resposta === "nao") {
      await p.enviar(TEXTO_DO_NAO);
      return { acao: "perguntou", motivo: "nao" };
    }
  } else if (resposta !== "outro") {
    // Havia um resumo, mas ela respondeu tarde demais: dizer "não tenho nada esperando" faria ela achar que a agenda
    // já estava atualizada. Diz que venceu e pede a agenda de novo.
    if (venceu) {
      await p.enviar(TEXTO_RESUMO_VENCIDO);
      return { acao: "perguntou", motivo: "resumo_vencido" };
    }
    await p.enviar(TEXTO_SEM_NADA_PARA_CONFERIR);
    return { acao: "perguntou", motivo: "sem_nada_para_conferir" };
  }

  const prompt = montarPromptDeLeitura({
    texto: p.texto,
    agora: p.agora,
    fuso: p.fuso,
    relatoAnterior: pendente?.lido ?? null,
  });
  const leitura = lerRespostaDoModelo(await p.lerComModelo(prompt), p.fuso, p.agora);

  switch (leitura.tipo) {
    case "outro":
      await p.enviar(TEXTO_OUTRO_ASSUNTO);
      return { acao: "outro_assunto" };
    case "ilegivel":
      await p.enviar(TEXTO_NAO_ENTENDI_A_AGENDA);
      return { acao: "perguntou", motivo: "ilegivel" };
    case "duvida":
      await p.enviar(textoDeDuvida(leitura.perguntas));
      return { acao: "perguntou", motivo: "duvida" };
    case "relato": {
      const { id, duplicado } = await p.registrar(leitura.relato, p.texto);
      // O resumo errado só sai da fila DEPOIS de o novo existir: se registrar falha, nada mudou.
      if (pendente) await p.marcarCorrigido(pendente.id);
      await p.enviar(resumoParaConferencia(leitura.relato, p.fuso));
      return { acao: "resumo_enviado", relatoId: id, corrigiu: pendente !== null, replay: duplicado };
    }
  }
}
