import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Emite o evento `user.mentioned` de cada pessoa marcada. É ele que o worker de
 * notificações transforma em push; o aviso na tela vem do tempo real, por outro
 * caminho. Best-effort: falhar aqui nunca desfaz a mensagem — quem chama não
 * espera esta função (`void`).
 */
export async function emitirMencoes(input: {
  organizationId: string;
  /** O que foi escrito: a nota ou a mensagem do chat. */
  entityKind: "conversation_note" | "team_message";
  entityId: string;
  avisar: ReadonlyArray<string>;
  fromUserId: string;
  /** Onde a pessoa vai cair ao clicar: conversa (nota) ou canal (chat). */
  destino: { conversation_id: string } | { channel_id: string };
  texto: string;
}): Promise<void> {
  if (input.avisar.length === 0) return;
  const admin = createAdminClient();
  const preview = input.texto.trim().slice(0, 140);
  await Promise.all(
    input.avisar.map((userId) =>
      admin.rpc("emit_event", {
        p_event_type: "user.mentioned",
        p_entity_kind: input.entityKind,
        p_entity_id: input.entityId,
        p_payload: {
          ...input.destino,
          to_user_id: userId,
          from_user_id: input.fromUserId,
          body_preview: preview,
        },
        p_metadata: {},
        p_organization_id: input.organizationId,
      }),
    ),
  );
}
