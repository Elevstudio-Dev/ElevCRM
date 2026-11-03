import { createAdminClient } from "@/lib/supabase/admin";

import type { Marcavel } from "./servidor";

/**
 * QUEM PODE SER MARCADO — perguntado ao banco, que é quem sabe quem enxerga o quê.
 *
 * As duas funções (`fn_membros_que_veem_conversa`, `fn_membros_do_canal`; migration
 * 0222) só executam para o `service_role`, por isso o cliente é o admin. Isso é
 * seguro porque o chamador JÁ conferiu, sob RLS, que quem pediu enxerga a conversa
 * ou o canal — e porque o `organization_id` vem da sessão, nunca do corpo.
 *
 * Erro do banco devolve lista VAZIA: sem lista, ninguém é marcado nem avisado. É o
 * lado seguro — a mensagem em si é enviada do mesmo jeito.
 */

interface LinhaDoBanco {
  user_id: string;
  role: string;
  full_name: string | null;
  email: string | null;
}

async function chamar(
  funcao: "fn_membros_que_veem_conversa" | "fn_membros_do_canal",
  args: Record<string, string>,
): Promise<Marcavel[]> {
  const admin = createAdminClient();
  const { data, error } = await admin.rpc(funcao as never, args as never);
  if (error || !Array.isArray(data)) return [];
  return (data as LinhaDoBanco[]).map((l) => ({
    user_id: l.user_id,
    role: l.role,
    full_name: l.full_name,
    email: l.email,
  }));
}

export function marcaveisDaConversa(organizationId: string, conversationId: string): Promise<Marcavel[]> {
  return chamar("fn_membros_que_veem_conversa", { p_org: organizationId, p_conversation_id: conversationId });
}

export function marcaveisDoCanal(organizationId: string, channelId: string): Promise<Marcavel[]> {
  return chamar("fn_membros_do_canal", { p_org: organizationId, p_channel_id: channelId });
}

/** O que a tela recebe: id, nome e papel. Sem e-mail. */
export interface MarcavelParaATela {
  user_id: string;
  nome: string;
  role: string;
}

export function paraATela(lista: ReadonlyArray<Marcavel>, euId: string): MarcavelParaATela[] {
  return lista
    .filter((m) => m.user_id !== euId)
    .map((m) => ({ user_id: m.user_id, nome: m.full_name?.trim() || "Membro", role: m.role }))
    .sort((a, b) => a.nome.localeCompare(b.nome, "pt-BR"));
}
