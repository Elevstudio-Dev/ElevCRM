/**
 * Emite UM convite de equipe: assina o token, monta o e-mail, tenta enviar e audita.
 *
 * Existe porque dois caminhos precisam do mesmo gesto e não podem divergir:
 *  - `POST /api/v1/team/invite` — um admin convida gente para a SUA organização;
 *  - `POST /api/v1/admin/tenants` (e `.../owner-invite`) — a plataforma abre uma
 *    organização para um cliente e convida o DONO dela.
 *
 * Duplicar a assinatura do token seria deixar dois lugares decidindo o que um convite
 * vale (prazo, papel, a quem se destina). O convite é um token HMAC sem linha em tabela
 * nenhuma (ver `lib/auth/invite-token.ts`): o que for assinado aqui é tudo o que existe.
 *
 * ─── O que esta função NÃO decide ────────────────────────────────────────────
 * Quem pode convidar para quê. Isso é de quem chama: a rota de equipe exige `admin` da
 * organização (`requireRole`); as rotas de plataforma exigem `requirePlatformAdmin`.
 * Esta função assina o que lhe mandam — chamá-la sem autorizar antes é o erro.
 *
 * ─── O envio pode falhar sem derrubar o convite ─────────────────────────────
 * O token vale mesmo que o e-mail não saia (Resend sem chave, domínio não verificado).
 * `email_dispatched: false` + `accept_url` deixam quem convidou entregar o link por
 * outro meio — num serviço operado por Elev, é o WhatsApp do cliente.
 */
import { randomUUID } from "node:crypto";

import { env } from "@/lib/env";
import { audit } from "@/lib/audit";
import { signInviteToken, INVITE_TTL_SECONDS } from "@/lib/auth/invite-token";
import { buildInviteEmail } from "@/lib/email/templates/invite";
import { sendEmail } from "@/lib/email/resend";
import type { MarcaDeSaida } from "@/lib/branding/saida";
import type { Role } from "@/lib/schemas";

export interface EmitirConviteEntrada {
  email: string;
  role: Role;
  organizationId: string;
  orgName: string;
  /** Quem aparece como remetente do convite no e-mail. */
  inviterName: string;
  marca: MarcaDeSaida;
  actorUserId: string;
  requestId: string;
  /** Convite aberto pela plataforma (Elev), não por um admin da própria organização. */
  porAdminDePlataforma?: boolean;
}

export interface ConviteEmitido {
  email: string;
  invite_id: string;
  expires_at: string;
  email_dispatched: boolean;
  accept_url: string;
}

export async function emitirConvite(entrada: EmitirConviteEntrada): Promise<ConviteEmitido> {
  const email = entrada.email.trim().toLowerCase();
  const inviteId = randomUUID();
  const exp = Math.floor(Date.now() / 1000) + INVITE_TTL_SECONDS;
  const token = signInviteToken({
    invite_id: inviteId,
    email,
    organization_id: entrada.organizationId,
    role: entrada.role,
    exp,
  });
  // env.* parseia process.env em runtime → funciona na imagem genérica self-host
  // (não fica queimado no bundle como process.env.NEXT_PUBLIC_APP_URL direto).
  const acceptUrl = `${env.NEXT_PUBLIC_APP_URL.replace(/\/$/, "")}/team/accept-invite/${token}`;
  const expiresAt = new Date(exp * 1000);

  const { subject, html, text } = buildInviteEmail({
    inviterName: entrada.inviterName,
    orgName: entrada.orgName,
    acceptUrl,
    role: entrada.role,
    expiresAt,
    marca: entrada.marca,
  });

  const result = await sendEmail({
    to: email,
    subject,
    html,
    text,
    fromName: entrada.marca.nome,
    tags: [
      { name: "kind", value: "team_invite" },
      { name: "org", value: entrada.organizationId },
    ],
  });

  await audit({
    action: "member.invited",
    actorUserId: entrada.actorUserId,
    organizationId: entrada.organizationId,
    resourceType: "membership",
    resourceId: inviteId,
    requestId: entrada.requestId,
    ...(entrada.porAdminDePlataforma ? { actingAsPlatformAdmin: true } : {}),
    metadata: {
      email,
      role: entrada.role,
      email_dispatched: result.ok,
      email_error: result.ok ? null : (result.error ?? null),
    },
  });

  return {
    email,
    invite_id: inviteId,
    expires_at: expiresAt.toISOString(),
    email_dispatched: result.ok,
    accept_url: acceptUrl,
  };
}
