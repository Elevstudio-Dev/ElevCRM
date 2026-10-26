/**
 * O EXECUTOR DO LEMBRETE — um compromisso por vez, com as portas injetadas.
 *
 * A regra de QUANDO mora em `./decisao`; a de O QUE VAI NO TEXTO, em `./valores`.
 * Aqui mora a COSTURA: ler o que falta, escolher a forma do envio pela capacidade do
 * canal, reivindicar o compromisso, mandar e registrar o desfecho. As portas
 * (`PortasDoLembrete`) existem para o desfecho ser provável sem banco e sem canal —
 * quem as liga ao Supabase é `./portas-supabase`.
 *
 * ─── Cinco coisas que este arquivo faz de propósito ──────────────────────────
 *
 * 1. **Forma do envio por capacidade, nunca por nome de provedor** (invariante 1 da
 *    doutrina de canal): `estadoDaJanela` diz se o canal tem a regra das 24 h.
 *      sem restrição → texto;
 *      com restrição → modelo aprovado (preferido mesmo com a janela aberta, por ser o
 *                      texto aprovado e ter os botões); sem modelo, texto só se a
 *                      janela estiver aberta.
 * 2. **Problema de CONFIGURAÇÃO não é falha do compromisso.** Sem modelo utilizável com
 *    a janela fechada, o compromisso continua `pending` com o motivo escrito e um alerta
 *    na Central (um por tipo, não um por paciente). Consertou o tipo? O próximo tick
 *    envia. Não consertou a tempo? Vira `late` sozinho. Marcar `failed` aqui puniria o
 *    paciente por um erro do cadastro.
 * 3. **Falha de ENVIO conta tentativa**, e a terceira vira `failed` + alerta.
 * 4. **Reivindicar antes de enviar**, com trava otimista em `reminder_attempts`: dois
 *    ticks sobrepostos não mandam duas mensagens.
 * 5. **Reconciliar antes de reenviar**: a chave `lembrete:<id>:<armado>` fica na
 *    mensagem. Se uma queda aconteceu entre mandar e carimbar, o tick seguinte acha a
 *    mensagem e só carimba.
 */
import { ApiError } from "@/lib/api/types";
import { estadoDaJanela, type EstadoDaJanela } from "@/lib/channels/janela";
import { renderTemplateBody } from "@/lib/channels/meta/render-template";
import { deriveTemplateContract } from "@/lib/channels/meta/template-contract";
import { isStatusSendable } from "@/lib/channels/meta/template-binding";

import { decidirLembrete, TENTATIVAS_MAXIMAS } from "./decisao";
import {
  dadosDoLembrete,
  montarValores,
  textoPadraoDoLembrete,
  type DadosDoLembrete,
  type ProblemaDoModelo,
} from "./valores";

// ─── o que as portas entregam ────────────────────────────────────────────────

/** O que `fn_lembretes_devidos` devolve: quem é, e de quem. */
export interface LembreteDevido {
  id: string;
  organizationId: string;
}

export interface CompromissoDevido {
  id: string;
  organizationId: string;
  contactId: string;
  conversationId: string | null;
  startsAt: Date;
  timeZone: string;
  /** `calendar_appointments.location_details` — vence o do tipo, que é o padrão. */
  localDoCompromisso: string | null;
  ownerUserId: string | null;
  titulo: string;
  tentativas: number;
  armadoEm: Date;
  /**
   * `reminder_armed_at` EXATAMENTE como o banco devolveu. O Postgres guarda microssegundos
   * e um `Date` do JavaScript só tem milissegundos: comparar `armadoEm.toISOString()` com
   * a coluna nunca casaria, e a trava otimista reprovaria todo compromisso em silêncio.
   */
  armadoEmBruto: string;
  detalheAtual: string | null;
  tipo: {
    id: string;
    nome: string;
    minutosAntes: number;
    modelo: string | null;
    localPadrao: string | null;
  };
  contato: { nome: string | null; semMensagens: boolean };
}

export interface ConversaDeEnvio {
  id: string;
  /** A sessão do canal está de pé (não arquivada e conectada)? */
  canalNoAr: boolean;
  /** Identificador do provedor — só repassado a `estadoDaJanela`, nunca comparado. */
  provedor: string | null;
  ultimaEntradaEm: string | null;
}

export interface ModeloAprovado {
  nome: string;
  idioma: string;
  status: string;
  componentes: unknown;
  formato: string | null;
}

export interface EnvioPedido {
  conversationId: string;
  chave: string;
  compromissoId: string;
  corpo: string;
  modelo: { nome: string; idioma: string; valores: Record<string, string> } | null;
}

export interface EnvioFeito {
  mensagemId: string;
  status: string;
  codigoDeErro: string | null;
}

export interface Alerta {
  /** O que identifica "o mesmo problema ainda aberto" (um aviso por tipo, por exemplo). */
  referencia: { tipo: "event_type" | "appointment"; id: string };
  titulo: string;
  corpo: string;
}

export interface PortasDoLembrete {
  agora(): Date;
  /** `null` = sumiu, foi cancelado, ou já tem desfecho: nada a fazer. */
  carregar(devido: LembreteDevido): Promise<CompromissoDevido | null>;
  nomeDoProfissional(userId: string | null): Promise<string | null>;
  nomeDaClinica(organizationId: string): Promise<string | null>;
  conversaParaOContato(c: CompromissoDevido): Promise<ConversaDeEnvio | null>;
  modeloAprovado(organizationId: string, nome: string): Promise<ModeloAprovado | null>;
  /**
   * Mensagem já enviada com esta chave (que não tenha falhado), se houver. Recebe a
   * conversa para a busca usar o índice dela: `messages.metadata` não tem índice, e
   * varrer a tabela inteira a cada envio não escala.
   */
  mensagemDaChave(
    c: CompromissoDevido,
    conversaId: string,
    chave: string,
  ): Promise<{ id: string } | null>;
  /** Trava otimista: só ganha quem ainda vê `tentativas` e `armadoEm` como lidos. */
  reivindicar(c: CompromissoDevido): Promise<boolean>;
  enviar(organizationId: string, pedido: EnvioPedido): Promise<EnvioFeito>;
  /** Escreve o desfecho, guardado por (estado=pending, armadoEm) — remarcar no meio não é pisado. */
  registrar(
    c: CompromissoDevido,
    desfecho:
      | { estado: "sent"; mensagemId: string; em: Date }
      | { estado: "skipped" | "failed"; detalhe: string }
      | { estado: "pending"; detalhe: string | null },
  ): Promise<void>;
  alertar(organizationId: string, alerta: Alerta): Promise<void>;
}

export type DesfechoDoTick = "enviado" | "pulado" | "esperando" | "falhou" | "ignorado";

// ─── a costura ───────────────────────────────────────────────────────────────

/** O modelo escolhido, já com texto e valores prontos para sair. */
interface ModeloPronto {
  nome: string;
  idioma: string;
  valores: Record<string, string>;
  corpo: string;
}

type AvaliacaoDoModelo =
  | { tipo: "nenhum" }
  | { tipo: "indisponivel"; motivo: string }
  | { tipo: "pronto"; modelo: ModeloPronto };

function avaliarModelo(
  nomeConfigurado: string | null,
  linha: ModeloAprovado | null,
  dados: DadosDoLembrete,
): AvaliacaoDoModelo {
  if (!nomeConfigurado) return { tipo: "nenhum" };
  if (!linha) return { tipo: "indisponivel", motivo: `no_template:${nomeConfigurado}` };
  if (!isStatusSendable(linha.status)) {
    return { tipo: "indisponivel", motivo: `no_template:${nomeConfigurado}:${linha.status}` };
  }

  const contrato = deriveTemplateContract({
    name: linha.nome,
    language: linha.idioma,
    ...(linha.formato ? { parameter_format: linha.formato } : {}),
    components: linha.componentes as never,
  });
  const valores = montarValores(contrato, dados);
  if (!valores.ok) {
    const primeiro: ProblemaDoModelo | undefined = valores.problemas[0];
    return { tipo: "indisponivel", motivo: `template_slot:${primeiro?.slot ?? "?"}` };
  }

  return {
    tipo: "pronto",
    modelo: {
      nome: linha.nome,
      idioma: linha.idioma,
      valores: valores.values,
      corpo: renderTemplateBody(linha.componentes, valores.values, {
        name: linha.nome,
        language: linha.idioma,
        ...(linha.formato ? { parameterFormat: linha.formato } : {}),
      }),
    },
  };
}

function alertaDeConfiguracao(c: CompromissoDevido, motivo: string): Alerta {
  const ondeConfigurar = "Ajuste em Configurações → Tipos de agendamento.";
  if (motivo.startsWith("template_slot:")) {
    const slot = motivo.slice("template_slot:".length);
    return {
      referencia: { tipo: "event_type", id: c.tipo.id },
      titulo: `Lembrete de «${c.tipo.nome}» não sai: o modelo usa uma variável desconhecida`,
      corpo:
        `O modelo «${c.tipo.modelo}» tem a variável «${slot}», que o lembrete não sabe preencher ` +
        `(use nome, data, hora, servico, profissional, local ou clinica; ou, em modelo posicional, ` +
        `as seis primeiras na ordem). ${ondeConfigurar}`,
    };
  }
  return {
    referencia: { tipo: "event_type", id: c.tipo.id },
    titulo: `Lembrete de «${c.tipo.nome}» não sai: falta um modelo aprovado`,
    corpo:
      c.tipo.modelo
        ? `O canal oficial só permite mensagem fora das 24 h com modelo aprovado, e «${c.tipo.modelo}» ` +
          `não está aprovado ou não foi encontrado. ${ondeConfigurar}`
        : `O canal oficial só permite mensagem fora das 24 h com modelo aprovado, e este tipo não tem ` +
          `um modelo de lembrete escolhido. ${ondeConfigurar}`,
  };
}

/**
 * Trata UM compromisso devido. Nunca lança por causa do paciente ou do canal — um
 * compromisso ruim não pode travar os outros do mesmo tick; o chamador só vê o desfecho.
 */
export async function processarLembrete(
  p: PortasDoLembrete,
  devido: LembreteDevido,
): Promise<DesfechoDoTick> {
  const c = await p.carregar(devido);
  if (!c) return "ignorado";

  const agora = p.agora();

  const decisao = decidirLembrete({
    agora,
    comecaEm: c.startsAt,
    minutosAntes: c.tipo.minutosAntes,
    armadoEm: c.armadoEm,
    contatoSemMensagens: c.contato.semMensagens,
    fuso: c.timeZone,
  });

  if (decisao.acao === "pular") {
    await p.registrar(c, { estado: "skipped", detalhe: decisao.motivo });
    return "pulado";
  }
  if (decisao.acao === "esperar") {
    if (c.detalheAtual !== decisao.motivo) {
      await p.registrar(c, { estado: "pending", detalhe: decisao.motivo });
    }
    return "esperando";
  }

  // ─── Daqui para baixo o lembrete DEVE sair. Falta achar por onde. ───────────

  const conversa = await p.conversaParaOContato(c);
  if (!conversa || !conversa.canalNoAr) {
    if (c.detalheAtual !== "channel_down") await p.registrar(c, { estado: "pending", detalhe: "channel_down" });
    return "esperando";
  }

  const [profissional, clinica, linhaDoModelo] = await Promise.all([
    p.nomeDoProfissional(c.ownerUserId),
    p.nomeDaClinica(c.organizationId),
    c.tipo.modelo ? p.modeloAprovado(c.organizationId, c.tipo.modelo) : Promise.resolve(null),
  ]);

  const dados = dadosDoLembrete({
    inicio: c.startsAt,
    fuso: c.timeZone,
    nomeDoContato: c.contato.nome,
    servico: c.tipo.nome || c.titulo,
    profissional,
    localReal: c.localDoCompromisso ?? c.tipo.localPadrao,
    clinica,
  });

  const janela: EstadoDaJanela = estadoDaJanela(conversa.provedor, conversa.ultimaEntradaEm, agora);
  const canalExigeModelo = janela.tipo !== "sem_restricao";
  const modelo = avaliarModelo(c.tipo.modelo, linhaDoModelo, dados);

  let pedido: Omit<EnvioPedido, "conversationId" | "chave" | "compromissoId">;
  if (!canalExigeModelo) {
    // Canal sem a regra das 24 h: texto. Se o tipo tem modelo utilizável, usa as
    // MESMAS palavras dele — o paciente lê o que a clínica aprovou.
    pedido = {
      corpo: modelo.tipo === "pronto" ? modelo.modelo.corpo : textoPadraoDoLembrete(dados),
      modelo: null,
    };
  } else if (modelo.tipo === "pronto") {
    pedido = {
      corpo: modelo.modelo.corpo,
      modelo: { nome: modelo.modelo.nome, idioma: modelo.modelo.idioma, valores: modelo.modelo.valores },
    };
  } else if (janela.tipo === "aberta") {
    // Dentro das 24 h o texto livre é permitido — mesmo com modelo quebrado, o paciente
    // recebe o aviso. A configuração quebrada ainda gera alerta.
    pedido = { corpo: textoPadraoDoLembrete(dados), modelo: null };
    if (modelo.tipo === "indisponivel") await p.alertar(c.organizationId, alertaDeConfiguracao(c, modelo.motivo));
  } else {
    // Janela fechada e nada que o canal aceite: é problema de cadastro, não do paciente.
    const motivo = modelo.tipo === "indisponivel" ? modelo.motivo : "no_template";
    if (c.detalheAtual !== motivo) await p.registrar(c, { estado: "pending", detalhe: motivo });
    await p.alertar(c.organizationId, alertaDeConfiguracao(c, motivo));
    return "esperando";
  }

  const chave = `lembrete:${c.id}:${c.armadoEm.getTime()}`;

  // Reconciliar antes de reenviar: uma queda entre mandar e carimbar deixa a mensagem
  // no banco e o compromisso sem carimbo.
  const jaSaiu = await p.mensagemDaChave(c, conversa.id, chave);
  if (jaSaiu) {
    await p.registrar(c, { estado: "sent", mensagemId: jaSaiu.id, em: agora });
    return "enviado";
  }

  if (!(await p.reivindicar(c))) return "ignorado";
  const tentativa = c.tentativas + 1;

  let feito: EnvioFeito;
  try {
    feito = await p.enviar(c.organizationId, {
      conversationId: conversa.id,
      chave,
      compromissoId: c.id,
      corpo: pedido.corpo,
      modelo: pedido.modelo,
    });
  } catch (err) {
    if (err instanceof ApiError && err.status === 403) {
      await p.registrar(c, { estado: "skipped", detalhe: "blocked" });
      return "pulado";
    }
    return falhaDeEnvio(p, c, tentativa, "send_error");
  }

  if (feito.status === "failed" || feito.status === "queued") {
    return falhaDeEnvio(p, c, tentativa, `${feito.status === "queued" ? "queued" : "send_failed"}:${feito.codigoDeErro ?? "?"}`);
  }

  await p.registrar(c, { estado: "sent", mensagemId: feito.mensagemId, em: agora });
  return "enviado";
}

async function falhaDeEnvio(
  p: PortasDoLembrete,
  c: CompromissoDevido,
  tentativa: number,
  detalhe: string,
): Promise<DesfechoDoTick> {
  if (tentativa >= TENTATIVAS_MAXIMAS) {
    await p.registrar(c, { estado: "failed", detalhe });
    await p.alertar(c.organizationId, {
      referencia: { tipo: "appointment", id: c.id },
      titulo: "Lembrete de consulta não saiu",
      corpo:
        `Tentei ${TENTATIVAS_MAXIMAS} vezes avisar ${c.contato.nome ?? "o paciente"} do atendimento de ` +
        `«${c.tipo.nome}» e o canal recusou (${detalhe}). Avise por telefone ou por uma mensagem manual.`,
    });
    return "falhou";
  }
  await p.registrar(c, { estado: "pending", detalhe });
  return "esperando";
}
