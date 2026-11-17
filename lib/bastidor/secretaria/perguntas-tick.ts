/**
 * UM TICK DAS PERGUNTAS À SECRETARIA — o que o cron executa a cada 5 minutos.
 *
 * Para cada secretaria de uma organização com a agenda da secretaria ligada: vê o que já foi perguntado hoje, marca
 * como respondido o que ela já respondeu, pede ao planejador (`perguntas.ts`, puro) o que falta e executa. Sem banco
 * nem fila aqui: tudo entra por `PortasDaSecretaria`, e o teste usa portas de mentira.
 *
 * ## Ordem das operações (por que cada uma vem antes da outra)
 *
 *  - PERGUNTAR: grava a linha ANTES de enfileirar. A chave única faz quem chegar segundo perder; assim duas instâncias
 *    do cron nunca mandam a mesma pergunta. O custo é aceito de propósito: se o enfileiramento falhar depois da
 *    gravação, a pergunta NÃO sai agora — mas fica registrada como pedida, e 30 minutos depois o ciclo do lembrete a
 *    reenvia e, em seguida, o administrador é avisado. A alternativa (enfileirar primeiro) mandaria pergunta em dobro.
 *  - LEMBRAR e AVISAR: carimbam a linha ANTES (update condicional "ainda não carimbado"), pela mesma razão.
 *
 * Uma secretaria que quebra NÃO derruba as outras do mesmo tick.
 */
import { planejarPerguntas, type AcaoDaPergunta, type PerguntaFeita } from "./perguntas";
import type { ConfigDaSecretaria } from "@/lib/agenda/secretaria/config";
import { diaLocalISO } from "@/lib/agenda/fuso";

export interface SecretariaAtiva {
  organizationId: string;
  contactId: string;
  nome: string | null;
  config: ConfigDaSecretaria;
  fuso: string;
}

export interface ConversaDaSecretaria {
  conversationId: string;
  channelSessionId: string;
}

export interface PedidoDeEnvio {
  acao: "perguntar" | "lembrar";
  dia: string;
  horario: string;
  conversa: ConversaDaSecretaria;
}

export type MotivoDoAviso = "sem_resposta" | "sem_conversa";

/** Tudo que o tick precisa de UMA secretaria. */
export interface PortasDaSecretaria {
  feitasHoje(dia: string): Promise<PerguntaFeita[]>;
  ultimaConferidaEm(): Promise<Date | null>;
  /** O instante da primeira mensagem DELA depois de `desde`, ou nulo. */
  primeiraRespostaDesde(desde: Date): Promise<Date | null>;
  /** Grava a linha. `true` se esta chamada foi quem gravou (a chave única decide). */
  registrar(dia: string, horario: string, estado: PerguntaFeita["estado"]): Promise<boolean>;
  marcarRespondida(dia: string, horario: string, quando: Date): Promise<void>;
  /** Carimba o lembrete. `true` só se ainda não estava carimbado (quem chegou primeiro ganha). */
  marcarLembrete(dia: string, horario: string): Promise<boolean>;
  /** Carimba o aviso ao administrador. `true` só se ainda não estava carimbado. */
  marcarAdminAvisado(dia: string, horario: string): Promise<boolean>;
  conversa(): Promise<ConversaDaSecretaria | null>;
  enfileirar(pedido: PedidoDeEnvio): Promise<void>;
  avisarAdmin(motivo: MotivoDoAviso, dia: string, horario: string): Promise<void>;
}

export interface PortasDoTick {
  agora(): Date;
  listarSecretarias(): Promise<SecretariaAtiva[]>;
  portasDe(secretaria: SecretariaAtiva): PortasDaSecretaria;
  /** Erro de UMA secretaria ou ação: vai para o log, nunca para fora do tick. */
  registrarErro(contexto: string, erro: unknown): void;
}

export interface ResultadoDoTick {
  secretarias: number;
  perguntadas: number;
  dispensadas: number;
  lembradas: number;
  avisos: number;
  respondidas: number;
  erros: number;
}

export async function executarTickDasPerguntas(p: PortasDoTick): Promise<ResultadoDoTick> {
  const r: ResultadoDoTick = { secretarias: 0, perguntadas: 0, dispensadas: 0, lembradas: 0, avisos: 0, respondidas: 0, erros: 0 };
  const secretarias = await p.listarSecretarias();
  for (const sec of secretarias) {
    r.secretarias += 1;
    try {
      await tickDeUmaSecretaria(p, sec, r);
    } catch (erro) {
      r.erros += 1;
      p.registrarErro("secretaria", erro);
    }
  }
  return r;
}

async function tickDeUmaSecretaria(p: PortasDoTick, sec: SecretariaAtiva, r: ResultadoDoTick): Promise<void> {
  const agora = p.agora();
  const portas = p.portasDe(sec);
  const hoje = diaLocalISO(agora, sec.fuso);

  // O que ela já respondeu sai do caminho antes de decidir lembrete e aviso.
  const feitas = await portas.feitasHoje(hoje);
  const atualizadas: PerguntaFeita[] = [];
  for (const f of feitas) {
    if (f.estado === "pedida" && f.respondidaEm === null) {
      const resposta = await portas.primeiraRespostaDesde(f.pedidaEm);
      if (resposta !== null) {
        await portas.marcarRespondida(f.dia, f.horario, resposta);
        r.respondidas += 1;
        atualizadas.push({ ...f, respondidaEm: resposta });
        continue;
      }
    }
    atualizadas.push(f);
  }

  const acoes = planejarPerguntas({
    config: sec.config,
    fuso: sec.fuso,
    agora,
    feitas: atualizadas,
    ultimaConferidaEm: await portas.ultimaConferidaEm(),
  });

  for (const acao of acoes) {
    try {
      await executar(portas, acao, r);
    } catch (erro) {
      r.erros += 1;
      p.registrarErro(`${acao.tipo} ${acao.horario}`, erro);
    }
  }
}

async function executar(portas: PortasDaSecretaria, a: AcaoDaPergunta, r: ResultadoDoTick): Promise<void> {
  switch (a.tipo) {
    case "dispensar": {
      if (await portas.registrar(a.dia, a.horario, "dispensada")) r.dispensadas += 1;
      return;
    }
    case "perguntar": {
      const conversa = await portas.conversa();
      if (conversa === null) {
        // Sem conversa não há como perguntar. Grava (para não repetir o aviso a cada 5 minutos) e avisa UMA vez.
        if (await portas.registrar(a.dia, a.horario, "sem_conversa")) {
          if (await portas.marcarAdminAvisado(a.dia, a.horario)) {
            await portas.avisarAdmin("sem_conversa", a.dia, a.horario);
            r.avisos += 1;
          }
        }
        return;
      }
      if (!(await portas.registrar(a.dia, a.horario, "pedida"))) return; // outra instância chegou primeiro
      await portas.enfileirar({ acao: "perguntar", dia: a.dia, horario: a.horario, conversa });
      r.perguntadas += 1;
      return;
    }
    case "lembrar": {
      const conversa = await portas.conversa();
      if (conversa === null) return; // a conversa sumiu; o aviso ao administrador cobre o resto
      if (!(await portas.marcarLembrete(a.dia, a.horario))) return;
      await portas.enfileirar({ acao: "lembrar", dia: a.dia, horario: a.horario, conversa });
      r.lembradas += 1;
      return;
    }
    case "avisar_admin": {
      if (!(await portas.marcarAdminAvisado(a.dia, a.horario))) return;
      await portas.avisarAdmin("sem_resposta", a.dia, a.horario);
      r.avisos += 1;
      return;
    }
  }
}
