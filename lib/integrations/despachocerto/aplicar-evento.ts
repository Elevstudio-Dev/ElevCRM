/**
 * O QUE UMA OS DEIXA NO CRM: as tags, no contato e nas conversas dele.
 *
 * Pedido do dono: "quando eu criar uma OS no Despacho Certo e vincular esse
 * contato, o Elev CRM puxa o número dessa OS e cria uma tag para o contato e
 * para a conversa. E também da placa."
 *
 * ─── Quem é o contato, e por que não pelo telefone ──────────────────────────
 *
 * Pelo VÍNCULO (`integration_contact_links`), que nasceu quando alguém clicou
 * "Cadastrar" no inbox. Casar por telefone seria frágil nos dois sentidos: o
 * cliente troca de número num dos lados, ou dois cadastros compartilham o
 * telefone da empresa — e a OS marcaria a conversa errada, que é pior que não
 * marcar nenhuma.
 *
 * Sem vínculo, a função não inventa: devolve `vinculado: false` e o outro lado
 * registra isso. É o caso legítimo de uma OS de cliente que nunca falou pelo
 * WhatsApp.
 *
 * ─── Quais conversas ────────────────────────────────────────────────────────
 *
 * TODAS as do contato que não estão arquivadas. Marcar só a mais recente
 * deixaria a OS invisível para quem abrisse a conversa antiga — e num
 * despachante a conversa do orçamento e a da entrega são a mesma pessoa em
 * fios diferentes.
 *
 * ─── Escrever só quando há o que escrever ───────────────────────────────────
 *
 * Uma OS que muda de status cinco vezes no dia manda cinco eventos com as
 * MESMAS tags. Cada `update` acorda o tempo real do inbox e mexe no
 * `updated_at` do contato. `juntarTags` diz o que é novo; nada novo, nada de
 * escrita.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { logger } from "@/lib/logger";
import { PROVEDOR, type EventoDeOs, type ResultadoDoEvento } from "./contrato";
import { juntarTags, tagsDoEvento } from "./tags";

export async function aplicarEventoDeOs(
  admin: SupabaseClient,
  organizationId: string,
  evento: EventoDeOs,
  requestId: string,
): Promise<ResultadoDoEvento> {
  const os = evento.work_order;
  const tags = tagsDoEvento({
    numero: os.number,
    placa: os.plate ?? null,
    placasAdicionais: os.additional_plates,
  });

  const { data: vinculo } = await admin
    .from("integration_contact_links")
    .select("contact_id")
    .eq("organization_id", organizationId)
    .eq("provider", PROVEDOR)
    .eq("external_id", os.client_id)
    .maybeSingle();

  if (!vinculo) {
    logger.info("despachocerto: OS sem contato vinculado", {
      requestId,
      organization_id: organizationId,
      client_id: os.client_id,
      work_order: os.number,
    });
    return { vinculado: false, tags_novas: [], conversas_marcadas: 0 };
  }

  const contactId = vinculo.contact_id as string;

  // ── o contato ────────────────────────────────────────────────────────────
  const { data: contato } = await admin
    .from("contacts")
    .select("id, tags")
    .eq("organization_id", organizationId)
    .eq("id", contactId)
    .maybeSingle();

  const noContato = juntarTags((contato?.tags as string[] | null) ?? [], tags);
  if (noContato.acrescentadas.length > 0) {
    await admin
      .from("contacts")
      .update({ tags: noContato.todas, updated_at: new Date().toISOString() })
      .eq("organization_id", organizationId)
      .eq("id", contactId);
  }

  // ── as conversas ─────────────────────────────────────────────────────────
  const { data: conversas } = await admin
    .from("conversations")
    .select("id, tags")
    .eq("organization_id", organizationId)
    .eq("contact_id", contactId)
    .neq("status", "archived");

  let marcadas = 0;
  for (const conversa of conversas ?? []) {
    const naConversa = juntarTags((conversa.tags as string[] | null) ?? [], tags);
    if (naConversa.acrescentadas.length === 0) continue;
    const { error } = await admin
      .from("conversations")
      .update({ tags: naConversa.todas })
      .eq("organization_id", organizationId)
      .eq("id", conversa.id as string);
    if (!error) marcadas += 1;
  }

  logger.info("despachocerto: OS aplicada", {
    requestId,
    organization_id: organizationId,
    contact_id: contactId,
    work_order: os.number,
    tags_novas: noContato.acrescentadas,
    conversas_marcadas: marcadas,
  });

  return {
    vinculado: true,
    tags_novas: noContato.acrescentadas,
    conversas_marcadas: marcadas,
  };
}
