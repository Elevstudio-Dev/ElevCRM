/**
 * A CONFIGURAÇÃO DA SECRETARIA, em `organizations.settings.secretaria`.
 *
 * Mora no jsonb que a organização já tem — uma coluna a mais para três botões seria o anti-pattern de inflar o
 * schema. Quem lê nunca quebra: valor ausente, de tipo errado ou fora do intervalo cai no padrão, e o padrão do
 * `ativa` é FALSO — uma organização que nunca configurou nada não muda de comportamento.
 *
 * Os padrões são os da clínica-piloto (odontologia): avaliação de 30 minutos, perguntas à secretaria de manhã, à
 * tarde e perto do fim do expediente (que termina às 19h), de segunda a sexta.
 */
import { z } from "zod";

const HORA = /^([01]\d|2[0-3]):[0-5]\d$/;

export const configDaSecretariaSchema = z.object({
  /** Desligado por padrão: a agenda da secretaria só passa a valer quando alguém a liga. */
  ativa: z.boolean().default(false),
  /** O atendente dono da agenda (o dentista que faz a avaliação). Ausente = o responsável padrão do tipo. */
  dono_da_agenda_user_id: z.string().uuid().nullable().default(null),
  /** Duração da avaliação, para quando a secretaria só disse a hora de início. */
  duracao_min: z.number().int().min(5).max(240).default(30),
  /** Horários (HH:MM, no fuso da agenda) em que a IA pergunta como está a agenda. */
  perguntas: z.array(z.string().regex(HORA)).min(1).max(6).default(["08:30", "14:00", "18:15"]),
  /** Dias da semana em que pergunta (0 = domingo). Padrão: segunda a sexta. */
  dias: z.array(z.number().int().min(0).max(6)).min(1).max(7).default([1, 2, 3, 4, 5]),
  /** Quanto tempo a agenda conferida vale para o MESMO DIA. Passou, a IA para de oferecer horário de hoje. */
  validade_hoje_horas: z.number().min(0.5).max(24).default(6),
  /** Quanto tempo vale para os dias SEGUINTES. Passou, a IA para de oferecer qualquer horário e chama o humano. */
  validade_futuro_horas: z.number().min(1).max(168).default(24),
});

export type ConfigDaSecretaria = z.output<typeof configDaSecretariaSchema>;

/** O padrão inteiro (organização que nunca configurou). */
export const CONFIG_PADRAO_DA_SECRETARIA: ConfigDaSecretaria = configDaSecretariaSchema.parse({});

/** Lê `settings.secretaria`. NUNCA lança: o que não prestar vira o padrão (e `ativa` volta a ser falso). */
export function lerConfigDaSecretaria(settings: unknown): ConfigDaSecretaria {
  if (typeof settings !== "object" || settings === null) return CONFIG_PADRAO_DA_SECRETARIA;
  const bruto = (settings as Record<string, unknown>).secretaria;
  const lido = configDaSecretariaSchema.safeParse(bruto ?? {});
  return lido.success ? lido.data : CONFIG_PADRAO_DA_SECRETARIA;
}
