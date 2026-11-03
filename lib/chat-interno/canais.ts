/**
 * CHAT INTERNO — o que é puro sobre canais: chave do par direto, nome de
 * exibição, contagem de não lidas. Migration 0214.
 */
import type { Mencao } from "@/lib/mencoes/tipos";

export type TipoDeCanal = "geral" | "setor" | "direto";

export interface CanalDaEquipe {
  id: string;
  kind: TipoDeCanal;
  /** "Geral", o nome do setor, ou o nome da outra pessoa. */
  name: string;
  sector_id: string | null;
  sector_color: string | null;
  /** No canal direto: quem está do outro lado. */
  other_user_id: string | null;
  unread: number;
  last_message: { body: string; sender_name: string | null; created_at: string } | null;
}

export interface MensagemDaEquipe {
  id: string;
  channel_id: string;
  sender_user_id: string | null;
  sender_name: string | null;
  body: string;
  /** Quem foi marcado com @ (migration 0222). Mensagem antiga: `[]`. */
  mentions?: Mencao[];
  created_at: string;
}

/**
 * O par ordenado: `a:b` com `a < b`. É o que faz o canal direto entre Ana e
 * Bia ser UM canal, chame quem chamar primeiro.
 */
export function chaveDoParDireto(userA: string, userB: string): string {
  return [userA, userB].sort().join(":");
}

/** O outro lado de um canal direto, a partir da chave e de quem pergunta. */
export function outroDoPar(directKey: string, meuId: string): string | null {
  const [a, b] = directKey.split(":");
  if (!a || !b) return null;
  if (a === meuId) return b;
  if (b === meuId) return a;
  return null;
}

/**
 * Quantas mensagens a pessoa ainda não viu num canal.
 *
 * - com `last_read_at`: as depois dele, de outros;
 * - sem (nunca abriu): as das últimas 24h, de outros — o suficiente para o
 *   contador acender para quem chegou agora, sem cobrar o histórico inteiro.
 */
export function contarNaoLidas(
  mensagens: ReadonlyArray<{ created_at: string; sender_user_id: string | null }>,
  meuId: string,
  lastReadAt: string | null,
  agora: Date,
): number {
  const limite = lastReadAt ? new Date(lastReadAt).getTime() : agora.getTime() - 24 * 60 * 60 * 1000;
  let n = 0;
  for (const m of mensagens) {
    if (m.sender_user_id === meuId) continue;
    if (new Date(m.created_at).getTime() > limite) n += 1;
  }
  return n;
}

/** A ordem da lista: Geral, os setores (na ordem deles), as pessoas (por atividade). */
export function ordenarCanais<T extends CanalDaEquipe>(canais: T[]): T[] {
  const peso: Record<TipoDeCanal, number> = { geral: 0, setor: 1, direto: 2 };
  return [...canais].sort((a, b) => {
    if (peso[a.kind] !== peso[b.kind]) return peso[a.kind] - peso[b.kind];
    if (a.kind === "direto" && b.kind === "direto") {
      const ta = a.last_message?.created_at ?? "";
      const tb = b.last_message?.created_at ?? "";
      if (ta !== tb) return ta < tb ? 1 : -1;
    }
    return a.name.localeCompare(b.name, "pt-BR");
  });
}
