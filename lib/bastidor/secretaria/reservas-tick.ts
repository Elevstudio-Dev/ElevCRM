/**
 * O TICK DAS RESERVAS — o que o cron (a cada 5 min) faz pelos pedidos de horário que esperam a secretaria.
 *
 *  1. VENCIDAS: a validade passou sem resposta. O cron FECHA a reserva como `expirada` (quem ganha o fechamento é
 *     quem fala; a resposta dela e o vencimento no mesmo minuto não se atropelam) e enfileira o aviso ao paciente —
 *     o worker é quem manda, pela cadeia de proteções, com horários parecidos calculados no servidor.
 *  2. SEM PERGUNTA: reserva esperando que ninguém perguntou (job perdido, ou outra pergunta estava em aberto). O cron
 *     reenfileira; o worker serializa (uma pergunta por vez) e carimba, então repetir é inofensivo.
 *  3. CONFIRMADA SEM COMPROMISSO: o processo caiu entre reivindicar o "sim" e marcar. Só a equipe resolve.
 *
 * Sem banco nem canal aqui: tudo entra por `PortasDoTickDeReservas` (ligadas em `reservas-supabase.ts`), e a regra é
 * testada com portas de mentira. O cron NÃO envia mensagem.
 */
import type { AcaoDaReserva, ConversaDeContato } from "@/lib/agenda/secretaria/conversa";
import type { Reserva } from "@/lib/agenda/secretaria/reservas";

export interface PortasDoTickDeReservas {
  agora(): Date;
  registrarErro(contexto: string, e: unknown): void;
  vencidas(agora: Date): Promise<Reserva[]>;
  semPergunta(agora: Date): Promise<Reserva[]>;
  confirmadasSemCompromisso(agora: Date): Promise<Reserva[]>;
  /** Reivindica o fechamento como `expirada`. `false` = alguém fechou antes. */
  expirar(reserva: Reserva, agora: Date): Promise<boolean>;
  conversaDaSecretaria(organizationId: string): Promise<ConversaDeContato | null>;
  enfileirar(organizationId: string, conversa: ConversaDeContato, acao: AcaoDaReserva, reservaId: string): Promise<void>;
  chamarEquipe(organizationId: string, pacienteId: string, aviso: { titulo: string; corpo: string }): Promise<void>;
}

export interface ResultadoDoTickDeReservas {
  expiradas: number;
  perguntasPedidas: number;
  semCompromisso: number;
}

export async function executarTickDasReservas(p: PortasDoTickDeReservas): Promise<ResultadoDoTickDeReservas> {
  const agora = p.agora();
  const resultado: ResultadoDoTickDeReservas = { expiradas: 0, perguntasPedidas: 0, semCompromisso: 0 };

  // Cada reserva é tratada sozinha: uma que falha não impede as outras.
  for (const r of await p.vencidas(agora)) {
    try {
      if (!(await p.expirar(r, agora))) continue;
      resultado.expiradas += 1;
      const conversa = await p.conversaDaSecretaria(r.organizationId);
      if (conversa === null) {
        // Sem conversa com a secretaria o worker não tem por onde avisar o paciente: a equipe faz à mão.
        await p.chamarEquipe(r.organizationId, r.contactId, {
          titulo: `Avise ${r.nomePaciente}: o pedido de horário venceu`,
          corpo:
            `${r.nomePaciente} escolheu um horário e a secretaria não respondeu a tempo. A IA não tem como avisá-lo ` +
            `agora. Abra a conversa e combine um novo horário.`,
        });
        continue;
      }
      try {
        await p.enfileirar(r.organizationId, conversa, "avisar_paciente_reserva", r.id);
      } catch (e) {
        p.registrarErro("reservas: enfileirar o aviso de vencimento", e);
        // A reserva já está fechada, então o cron não vai tentar de novo: a equipe é quem avisa.
        await p.chamarEquipe(r.organizationId, r.contactId, {
          titulo: `Avise ${r.nomePaciente}: o pedido de horário venceu`,
          corpo: `${r.nomePaciente} escolheu um horário e a secretaria não respondeu a tempo. Abra a conversa e combine um novo horário.`,
        });
      }
    } catch (e) {
      p.registrarErro("reservas: vencimento", e);
    }
  }

  for (const r of await p.semPergunta(agora)) {
    try {
      const conversa = await p.conversaDaSecretaria(r.organizationId);
      if (conversa === null) continue; // ainda sem conversa: a reserva vence e a equipe é chamada acima
      await p.enfileirar(r.organizationId, conversa, "perguntar_reserva", r.id);
      resultado.perguntasPedidas += 1;
    } catch (e) {
      p.registrarErro("reservas: reenfileirar a pergunta", e);
    }
  }

  for (const r of await p.confirmadasSemCompromisso(agora)) {
    try {
      await p.chamarEquipe(r.organizationId, r.contactId, {
        titulo: `Confirme à mão o horário de ${r.nomePaciente}`,
        corpo:
          `A secretaria confirmou o horário de ${r.nomePaciente}, mas o sistema não conseguiu marcar o compromisso. ` +
          `Marque na agenda e avise o paciente.`,
      });
      resultado.semCompromisso += 1;
    } catch (e) {
      p.registrarErro("reservas: confirmada sem compromisso", e);
    }
  }

  return resultado;
}
