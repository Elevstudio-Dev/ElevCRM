/**
 * QUEM RECEBE A CAMPANHA — a regra, sem banco, para o teste cobrir cada motivo.
 *
 * O público é "quem tem TODAS as etiquetas escolhidas". Daí saem, cada um com o
 * motivo visível na prévia (a equipe precisa saber por que 445 viraram 300):
 *
 *  - quem pediu para não receber (`is_blocked`) — nunca se manda campanha a quem
 *    respondeu PARAR;
 *  - telefone fixo ou inválido — WhatsApp não existe ali, e mandar para número
 *    sem WhatsApp em volume é sinal de spam para a plataforma;
 *  - contato da equipe (`papel_interno`) — a dentista não é paciente;
 *  - contato anonimizado (LGPD) ou mesclado em outro.
 */

export type MotivoDeFora = "pediu_para_sair" | "telefone_fixo" | "sem_telefone" | "equipe" | "anonimizado";

export interface ContatoCandidato {
  id: string;
  phone_number: string | null;
  tags: string[] | null;
  is_blocked: boolean;
  papel_interno: string | null;
  is_anonymized: boolean;
  is_merged_into: string | null;
}

export type TipoDeTelefone = "celular" | "fixo" | "invalido";

/**
 * Classifica um telefone do Brasil. Número de outro país é tratado como
 * celular: não há regra confiável para distinguir, e é raro na base.
 *
 * Celular com 8 dígitos começando em 6–9 é o formato antigo (sem o 9 na
 * frente) — muitas contas de WhatsApp antigas ainda estão registradas assim, e
 * o envio resolve o número. Fixo é 8 dígitos começando em 2–5.
 */
export function tipoDeTelefone(telefone: string | null | undefined): TipoDeTelefone {
  const digitos = (telefone ?? "").replace(/\D/gu, "");
  if (digitos.length < 10) return "invalido";

  let nacional: string;
  if (digitos.startsWith("55") && (digitos.length === 12 || digitos.length === 13)) {
    nacional = digitos.slice(2);
  } else if (digitos.length === 10 || digitos.length === 11) {
    nacional = digitos;
  } else {
    return digitos.length <= 15 ? "celular" : "invalido";
  }

  const numero = nacional.slice(2);
  if (numero.length === 9) return numero.startsWith("9") ? "celular" : "invalido";
  if (numero.length === 8) return /^[6-9]/u.test(numero) ? "celular" : "fixo";
  return "invalido";
}

export function temTodasAsEtiquetas(tags: readonly string[] | null, etiquetas: readonly string[]): boolean {
  const conjunto = new Set((tags ?? []).map((t) => t.toLowerCase()));
  return etiquetas.every((e) => conjunto.has(e.toLowerCase()));
}

export function motivoDeFora(c: ContatoCandidato): MotivoDeFora | null {
  if (c.is_anonymized || c.is_merged_into) return "anonimizado";
  if (c.is_blocked) return "pediu_para_sair";
  if (c.papel_interno) return "equipe";
  const tipo = tipoDeTelefone(c.phone_number);
  if (tipo === "invalido") return "sem_telefone";
  if (tipo === "fixo") return "telefone_fixo";
  return null;
}

export interface Publico {
  /** Recebem, na ordem em que a agenda vai atendê-los. */
  incluidos: string[];
  fora: Record<MotivoDeFora, number>;
}

export function montarPublico(contatos: readonly ContatoCandidato[], etiquetas: readonly string[]): Publico {
  const fora: Record<MotivoDeFora, number> = {
    pediu_para_sair: 0,
    telefone_fixo: 0,
    sem_telefone: 0,
    equipe: 0,
    anonimizado: 0,
  };
  const incluidos: string[] = [];
  for (const c of contatos) {
    if (!temTodasAsEtiquetas(c.tags, etiquetas)) continue;
    const motivo = motivoDeFora(c);
    if (motivo) {
      fora[motivo]++;
      continue;
    }
    incluidos.push(c.id);
  }
  return { incluidos, fora };
}
