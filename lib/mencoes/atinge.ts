import { mencaoAtingeUsuario } from "@/lib/notifications/mentions";

import type { Mencao } from "./tipos";

/** Lê a coluna `mentions` que veio solta do banco/tempo real; o que não for marcação é ignorado. */
export function lerMencoes(bruto: unknown): Mencao[] {
  if (!Array.isArray(bruto)) return [];
  return bruto.flatMap((m): Mencao[] => {
    if (!m || typeof m !== "object") return [];
    const x = m as Record<string, unknown>;
    if (x.tipo === "todos") return [{ tipo: "todos" }];
    if (x.tipo === "pessoa" && typeof x.user_id === "string" && typeof x.nome === "string") {
      return [{ tipo: "pessoa", user_id: x.user_id, nome: x.nome }];
    }
    if (x.tipo === "participante" && typeof x.jid === "string" && typeof x.nome === "string") {
      return [{ tipo: "participante", jid: x.jid, nome: x.nome }];
    }
    return [];
  });
}

/**
 * Esta NOTA marca a pessoa? É o que decide o aviso na tela de quem a recebe pelo
 * tempo real.
 *
 * Havendo marcação guardada, só ELA vale — e só a de uma pessoa pelo id. O
 * `@todos` NÃO acende aviso aqui: a linha da nota chega ao navegador de qualquer
 * membro da organização (a RLS de notas é por organização), então acender o aviso
 * de um `@todos` mostraria o texto a quem talvez nem abra aquela conversa. Quem
 * a enxerga é avisado pelo servidor, que pergunta ao banco quem enxerga.
 *
 * Sem marcação guardada, vale o que a nota sempre fez: o texto digitado à mão
 * (`@ana`) casado com o nome ou o e-mail de quem olha.
 */
export function notaMarcaUsuario(input: {
  mentions: unknown;
  body: string;
  user: { id: string; email: string; full_name: string | null };
}): boolean {
  const lista = lerMencoes(input.mentions);
  if (lista.length > 0) return lista.some((m) => m.tipo === "pessoa" && m.user_id === input.user.id);
  return mencaoAtingeUsuario(input.body, input.user);
}

/**
 * Esta mensagem do CHAT DA EQUIPE marca a pessoa — pelo nome ou pelo `@todos`?
 * Aqui o `@todos` vale, porque a linha só chega a quem enxerga o canal (a RLS de
 * `team_messages` herda a do canal).
 */
export function chatMarcaUsuario(mentions: unknown, userId: string): "pessoa" | "todos" | null {
  const lista = lerMencoes(mentions);
  if (lista.some((m) => m.tipo === "pessoa" && m.user_id === userId)) return "pessoa";
  if (lista.some((m) => m.tipo === "todos")) return "todos";
  return null;
}
