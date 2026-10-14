/**
 * contact-avatars — baixa e mantém atualizada a foto de perfil dos contatos.
 *
 * POR QUE UM CRON, E NÃO NA INGESTÃO
 * O webhook de entrada precisa responder rápido: baixar e subir uma imagem no meio
 * dele atrasaria a gravação da mensagem e, num pico, faria o canal reenfileirar.
 * Aqui vale a mesma regra do resto do repo — trabalho pesado sai do caminho
 * quente e vira varredura periódica.
 *
 * POR QUE O ARQUIVO, E NÃO A URL
 * O canal devolve uma URL assinada do CDN do WhatsApp, com `oe=<expiração>` no
 * fim. Medido numa instalação real: 9 dias. Guardar a URL faria todo avatar
 * sumir da tela em pouco mais de uma semana, sem erro nenhum. Então o arquivo
 * vai para o bucket privado `whatsapp-media`, como já se faz com a mídia das
 * mensagens, e a tela pede URL assinada na hora.
 *
 * ORDEM DA VARREDURA: `avatar_updated_at nulls first` — quem nunca teve foto
 * entra antes de quem só está desatualizado. O rosto que falta incomoda mais
 * que o rosto velho.
 *
 * Auth: Bearer INTERNAL_SECRET (fail-closed), igual aos demais crons.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { DEFAULT_CHANNEL_PROVIDER, getAdapter, type ChannelProvider } from "@/lib/channels";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

/** Contatos por invocação. Baixar imagem é I/O: cap baixo evita segurar o cron. */
const SCAN_LIMIT = 25;
/** Revisita a foto a cada 7 dias — gente troca de foto, mas não toda hora. */
const REFRESH_AFTER_DAYS = 7;
/** Foto de perfil do WhatsApp é pequena; acima disto é resposta errada. */
const MAX_BYTES = 2 * 1024 * 1024;

interface ContactRow {
  id: string;
  organization_id: string;
  avatar_storage_path: string | null;
  /** Onde perguntar a foto. Resolvido ao montar a lista, não dentro do laço:
   *  pessoa vem de `contacts.wa_identity`, grupo vem de
   *  `conversations.group_chat_id`, e o laço não precisa saber a diferença. */
  chatId: string | null;
}

/** `lid:123…` / `phone:+55…` → o chatId que o adapter espera. */
function chatIdFromIdentity(identity: string): string | null {
  if (identity.startsWith("lid:")) return `${identity.slice(4)}@lid`;
  if (identity.startsWith("phone:")) return `${identity.slice(6).replace(/\D/g, "")}@c.us`;
  return null;
}

/**
 * ONDE PERGUNTAR A FOTO — a identidade OPACA primeiro, o número depois.
 *
 * O WhatsApp passou a endereçar parte dos contatos por um id opaco (`@lid`) em
 * vez do número. Para esses, perguntar a foto por `<numero>@c.us` devolve
 * `null` — não um erro, não "sem foto": null, igual a quem realmente não tem.
 * Medido em 14/10 nos seis contatos que apareciam sem foto numa fila real: os
 * seis devolveram a URL quando perguntados por `<lid>@lid`, e null por `@c.us`.
 *
 * Por isso a ordem é esta e não a inversa: o `phone_number` continua existindo
 * para quem já tem `wa_lid`, então preferir o número silenciaria a foto de todo
 * contato que o WhatsApp já migrou — que é exatamente o que estava acontecendo.
 */
function ondePerguntarAFoto(c: {
  wa_lid: string | null;
  wa_identity: string | null;
}): string | null {
  if (c.wa_lid) return `${c.wa_lid}@lid`;
  return c.wa_identity ? chatIdFromIdentity(c.wa_identity) : null;
}

/**
 * Os grupos que ainda precisam de foto.
 *
 * O vínculo é pela CONVERSA, e várias conversas podem apontar para o mesmo
 * contato de grupo — por isso a deduplicação por contato antes de perguntar ao
 * banco quem está vencido. Sem ela, um grupo com duas conversas consumiria duas
 * vagas do lote e empurraria outro grupo para a rodada seguinte, para sempre.
 */
async function candidatosDeGrupo(
  admin: ReturnType<typeof createAdminClient>,
  cutoff: string,
  limite: number,
): Promise<ContactRow[]> {
  const { data: conversas } = await admin
    .from("conversations")
    .select("organization_id, contact_id, group_chat_id")
    .not("group_chat_id", "is", null)
    .order("last_message_at", { ascending: false, nullsFirst: false })
    .limit(limite * 5);

  const chatPorContato = new Map<string, string>();
  for (const c of (conversas ?? []) as Array<{
    contact_id: string | null;
    group_chat_id: string | null;
  }>) {
    if (c.contact_id && c.group_chat_id && !chatPorContato.has(c.contact_id)) {
      chatPorContato.set(c.contact_id, c.group_chat_id);
    }
  }
  if (chatPorContato.size === 0) return [];

  const { data: contatos } = await admin
    .from("contacts")
    .select("id, organization_id, avatar_storage_path")
    .in("id", [...chatPorContato.keys()])
    .eq("is_anonymized", false)
    .or(`avatar_updated_at.is.null,avatar_updated_at.lt.${cutoff}`)
    .order("avatar_updated_at", { ascending: true, nullsFirst: true })
    .limit(limite);

  return (contatos ?? []).map((c) => ({
    id: c.id as string,
    organization_id: c.organization_id as string,
    avatar_storage_path: (c.avatar_storage_path ?? null) as string | null,
    chatId: chatPorContato.get(c.id as string) ?? null,
  }));
}

async function handle(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();

  const auth = req.headers.get("authorization") ?? "";
  const provided = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length).trim() : "";
  const accepted = [env.INTERNAL_CRON_SECRET, env.INTERNAL_SECRET].filter(Boolean);
  if (accepted.length === 0 || !provided || !accepted.includes(provided)) {
    return fail("forbidden", "Cron secret missing or invalid.", 403, { requestId });
  }

  const admin = createAdminClient();
  const cutoff = new Date(Date.now() - REFRESH_AFTER_DAYS * 86_400_000).toISOString();

  // Nunca buscados (null) OU buscados há mais de REFRESH_AFTER_DAYS.
  //
  // `is_anonymized` fora é OBRIGATÓRIO, não otimização: sem esse filtro, um
  // contato anonimizado por pedido LGPD voltaria a ser varrido no refresh
  // seguinte e o cron BAIXARIA O ROSTO DELE DE NOVO — reintroduzindo, sozinho e
  // periodicamente, o dado pessoal que acabara de ser apagado. A anonimização é
  // declarada irreversível no produto; esta linha é o que sustenta isso.
  const { data: contatos, error: queryError } = await admin
    .from("contacts")
    .select("id, organization_id, wa_identity, wa_lid, avatar_storage_path")
    .or("wa_identity.not.is.null,wa_lid.not.is.null")
    .eq("is_anonymized", false)
    .or(`avatar_updated_at.is.null,avatar_updated_at.lt.${cutoff}`)
    .order("avatar_updated_at", { ascending: true, nullsFirst: true })
    .limit(SCAN_LIMIT);

  if (queryError) {
    logger.error("[contact-avatars] query failed", { detail: queryError.message, requestId });
    return fail("internal_error", queryError.message, 500, { requestId });
  }

  // Pessoas e grupos no MESMO lote, cada um com seu chatId já resolvido. O
  // limite é por fonte: um inbox cheio de grupos não pode deixar as pessoas
  // sem foto, nem o contrário.
  const pessoas: ContactRow[] = (
    (contatos ?? []) as Array<{
      id: string;
      organization_id: string;
      wa_identity: string | null;
      wa_lid: string | null;
      avatar_storage_path: string | null;
    }>
  ).map((c) => ({
    id: c.id,
    organization_id: c.organization_id,
    avatar_storage_path: c.avatar_storage_path,
    chatId: ondePerguntarAFoto(c),
  }));

  const grupos = await candidatosDeGrupo(admin, cutoff, SCAN_LIMIT);

  const rows: ContactRow[] = [...pessoas, ...grupos];
  let atualizados = 0;
  let semFoto = 0;
  let falhas = 0;

  for (const c of rows) {
    const chatId = c.chatId;
    // Carimba mesmo sem conseguir resolver o chatId: sem isso o contato voltaria
    // em TODA rodada do cron, para sempre, batendo no canal à toa.
    //
    // `is_anonymized = false` no UPDATE não repete o filtro do SELECT — fecha uma
    // corrida. Entre a seleção do lote e esta gravação há I/O de rede por contato
    // (canal, download, upload), e a anonimização em escopo de tenant percorre
    // centenas de contatos enquanto isto roda. Se o pedido LGPD alcançar este
    // contato no meio do caminho, sem esta cláusula o cron gravaria o rosto de
    // volta num contato JÁ anonimizado — e o filtro do SELECT nunca mais o
    // escolheria para corrigir. Devolve as linhas afetadas para que quem chamou
    // saiba se a gravação valeu.
    const carimbar = async (path: string | null): Promise<boolean> => {
      const { data: afetadas } = await admin
        .from("contacts")
        .update({
          ...(path !== null ? { avatar_storage_path: path } : {}),
          avatar_updated_at: new Date().toISOString(),
        })
        .eq("id", c.id)
        .eq("organization_id", c.organization_id)
        .eq("is_anonymized", false)
        .select("id");
      return (afetadas ?? []).length > 0;
    };

    if (!chatId) {
      await carimbar(null);
      semFoto++;
      continue;
    }

    try {
      const { data: sessao } = await admin
        .from("channel_sessions")
        .select("waha_session_name, provider")
        .eq("organization_id", c.organization_id)
        .eq("status", "WORKING")
        .limit(1)
        .maybeSingle();
      const ref = (sessao as { waha_session_name?: string | null } | null)?.waha_session_name;
      if (!ref) {
        await carimbar(null);
        semFoto++;
        continue;
      }

      // Pelo adapter, nunca falando com o canal direto: a doutrina
      // `restricao-de-canal` proíbe nomear provider fora de lib/channels/, e o
      // `pnpm lint:channels` reprova o build se acontecer (foi o que pegou a
      // primeira versão desta rota). Testar a PRESENÇA do método é como se
      // pergunta "este canal sabe fazer isso?" sem perguntar qual canal é.
      const adapter = getAdapter(
        (sessao as { provider?: ChannelProvider | null } | null)?.provider ??
          DEFAULT_CHANNEL_PROVIDER,
      );
      if (!adapter.fetchProfilePictureUrl) {
        await carimbar(null);
        semFoto++;
        continue;
      }
      const profilePictureURL = await adapter.fetchProfilePictureUrl({
        organizationId: c.organization_id,
        sessionRef: ref,
        recipient: chatId,
      });
      if (!profilePictureURL) {
        // Contato sem foto ou com privacidade fechada: estado normal, não erro.
        await carimbar(null);
        semFoto++;
        continue;
      }

      const img = await fetch(profilePictureURL);
      if (!img.ok) {
        await carimbar(null);
        falhas++;
        continue;
      }
      const buf = Buffer.from(await img.arrayBuffer());
      if (buf.byteLength === 0 || buf.byteLength > MAX_BYTES) {
        await carimbar(null);
        falhas++;
        continue;
      }

      // Caminho estável por contato: `upsert` sobrescreve a foto antiga em vez
      // de acumular um arquivo órfão por refresh (7 dias × N contatos viraria
      // lixo pago no bucket).
      const path = `${c.organization_id}/avatars/${c.id}.jpg`;
      const { error: upErr } = await admin.storage
        .from("whatsapp-media")
        .upload(path, buf, { contentType: "image/jpeg", upsert: true });
      if (upErr) {
        await carimbar(null);
        falhas++;
        continue;
      }

      const gravou = await carimbar(path);
      if (!gravou) {
        // O contato foi anonimizado enquanto baixávamos a foto dele. O arquivo
        // já subiu, então bloquear a gravação não basta: sem isto o objeto ficaria
        // no bucket sem ponteiro nenhum — pior que o defeito original, porque
        // invisível. Devolvemos à fila de redação, o mesmo caminho que a cascata
        // usa, e o worker de limpeza remove.
        await admin.from("storage_redaction_queue").upsert(
          {
            organization_id: c.organization_id,
            bucket: "whatsapp-media",
            object_path: path,
            status: "pending",
            attempts: 0,
            processed_at: null,
            error_message: null,
          },
          { onConflict: "bucket,object_path" },
        );
        logger.warn("[contact-avatars] anonimizado durante a busca; foto devolvida à fila", {
          contact_id: c.id,
          organization_id: c.organization_id,
          requestId,
        });
        semFoto++;
        continue;
      }
      atualizados++;
    } catch (err) {
      await carimbar(null);
      falhas++;
      logger.warn("[contact-avatars] contato falhou", {
        contact_id: c.id,
        detail: err instanceof Error ? err.message : String(err),
        requestId,
      });
    }
  }

  return ok(
    { scanned: rows.length, updated: atualizados, no_picture: semFoto, failed: falhas },
    { requestId },
  );
}

export const GET = handle;
export const POST = handle;
