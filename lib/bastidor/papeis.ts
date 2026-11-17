/**
 * PAPÉIS DE CONTATO — `contacts.papel_interno` (migration 0227).
 *
 * Um contato da EQUIPE pode ter um papel que o sistema entende:
 *
 *  - `secretaria`: a pessoa que sabe a agenda. O agente de bastidor lhe pergunta como está o dia, confirma
 *    horário e avisa quando algo é marcado.
 *  - `marketing`: a pessoa que lança campanhas. O agente de bastidor recebe o briefing, mostra a prévia e devolve o
 *    relatório.
 *
 * Quem tem papel está SEMPRE "fora do funil" (o banco exige — ver a migration): não vira lead, não entra em
 * relatório de vendas e o agente de VENDAS não lhe escreve. O agente de BASTIDOR escreve, e só dentro do que o papel
 * comporta. Esta lista é a fonte única: o veto do `before-send`, a API e a tela leem daqui.
 */

export const PAPEIS_INTERNOS = ["secretaria", "marketing"] as const;
export type PapelInterno = (typeof PAPEIS_INTERNOS)[number];

export function ehPapelInterno(valor: unknown): valor is PapelInterno {
  return typeof valor === "string" && (PAPEIS_INTERNOS as readonly string[]).includes(valor);
}

/** O que o agente de bastidor pode mandar a cada papel. Tipo fora desta lista, para aquele papel, é vetado. */
export const TIPOS_DE_MENSAGEM_DO_BASTIDOR = {
  secretaria: [
    "agenda_pergunta",
    "agenda_lembrete",
    "agenda_conferencia",
    "reserva_pergunta",
    "reserva_aviso",
  ],
  marketing: ["campanha_dialogo", "campanha_previa", "campanha_relatorio"],
} as const satisfies Record<PapelInterno, readonly string[]>;

export type TipoDeMensagemDoBastidor =
  (typeof TIPOS_DE_MENSAGEM_DO_BASTIDOR)[PapelInterno][number];

/** O papel comporta este tipo de mensagem? Sem papel, nada passa. */
export function papelPermiteTipo(
  papel: PapelInterno | null | undefined,
  tipo: TipoDeMensagemDoBastidor,
): boolean {
  if (papel === null || papel === undefined) return false;
  return (TIPOS_DE_MENSAGEM_DO_BASTIDOR[papel] as readonly string[]).includes(tipo);
}

/** Nome para a tela. */
export const ROTULO_DO_PAPEL: Record<PapelInterno, string> = {
  secretaria: "Secretaria",
  marketing: "Marketing",
};
