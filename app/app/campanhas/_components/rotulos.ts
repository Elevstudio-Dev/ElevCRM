/**
 * Rótulos e cores das situações — um lugar só para a lista e o detalhe dizerem
 * a mesma coisa. Os textos passam por `t()` em quem renderiza.
 */
import type { Situacao } from "@/lib/campanhas/situacao";
import type { ResumoDaCampanha } from "@/lib/campanhas/servico";

type Variante = "default" | "neutral" | "success" | "warning" | "error" | "info";

export const ROTULO_DA_SITUACAO: Record<Situacao, { texto: string; variante: Variante }> = {
  agendado: { texto: "Agendado", variante: "neutral" },
  enviando: { texto: "Enviando", variante: "info" },
  enviado: { texto: "Enviado", variante: "default" },
  respondeu: { texto: "Respondeu", variante: "success" },
  pediu_para_sair: { texto: "Pediu para sair", variante: "warning" },
  conversou_antes: { texto: "Conversou antes da vez", variante: "neutral" },
  pausado: { texto: "Pausado", variante: "neutral" },
  cancelado: { texto: "Cancelado", variante: "neutral" },
  falhou: { texto: "Falhou", variante: "error" },
};

export const ROTULO_DO_ESTADO: Record<ResumoDaCampanha["estado"], { texto: string; variante: Variante }> = {
  enviando: { texto: "Enviando", variante: "info" },
  pausada: { texto: "Pausada", variante: "warning" },
  cancelada: { texto: "Cancelada", variante: "neutral" },
  concluida: { texto: "Concluída", variante: "success" },
};

/** `tagDoIdioma` vem de `useTagDeIdioma()`: a data segue o idioma escolhido pela pessoa. */
export function dataHora(iso: string | null, tagDoIdioma: string): string {
  if (!iso) return "—";
  return new Intl.DateTimeFormat(tagDoIdioma, {
    weekday: "short",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(iso));
}

/** Quantos já receberam a mensagem (inclui quem respondeu e quem pediu para sair depois). */
export function jaReceberam(c: ResumoDaCampanha["contagem"]): number {
  return c.enviado + c.respondeu + c.pediu_para_sair;
}

export function totalDaCampanha(c: ResumoDaCampanha["contagem"]): number {
  return Object.values(c).reduce((a, b) => a + b, 0);
}
