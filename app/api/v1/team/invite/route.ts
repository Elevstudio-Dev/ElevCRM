/**
 * POST /api/v1/team/invite — bulk-invite up to 20 emails.
 *
 * Pragmatic MVP: invitations are stateless HMAC tokens (no team_invites table).
 * If a user with that email already has an active membership in the org, we
 * skip with reason `already_member`. Otherwise we sign a 24h token containing
 * a fresh invite_id (uuid) + email + org_id + role and email the link.
 *
 * Membership row is created at /accept-invite time (Server Action) — that's
 * also when audit emits `member.accepted`. Here we audit `member.invited`.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { ApiError } from "@/lib/api/types";
import { isServiceRoleConfigured } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";
import { inviteMemberSchema, validateRequest } from "@/lib/schemas";
import { marcaDaSaida } from "@/lib/branding/saida";
import { emitirConvite, type ConviteEmitido } from "@/lib/team/emitir-convite";

export const dynamic = "force-dynamic";

interface FailedItem {
  email: string;
  reason: string;
}

export async function POST(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "team" });
  if (!authz.ok) return authz.response;
  const { user: authUser, org: activeOrg } = authz;

  let input;
  try {
    input = await validateRequest(inviteMemberSchema, req);
  } catch (err) {
    if (err instanceof ApiError) {
      return fail(err.code, err.message, err.status, {
        details: err.details as Record<string, unknown> | undefined,
        requestId,
      });
    }
    throw err;
  }

  const sent: ConviteEmitido[] = [];
  const failed: FailedItem[] = [];

  const admin = isServiceRoleConfigured() ? createAdminClient() : null;
  const inviterName = authUser.full_name ?? authUser.email ?? "Um colega";
  // Uma vez, fora do laço: a marca é a mesma para todo convite desta chamada, e
  // resolvê-la por destinatário multiplicaria a leitura por 20 (o teto do lote).
  const marca = await marcaDaSaida(activeOrg.orgId);

  // Emails com membership ATIVA na org — para pular o reconvite de quem já é membro.
  // O schema `auth` NÃO é acessível via PostgREST (erro "Invalid schema: auth"), então
  // resolvemos email↔usuário pela GoTrue admin API (getUserById) — mesmo padrão de
  // app/api/v1/team/route.ts. N pequeno (poucos membros por org no perfil BPO).
  const memberEmails = new Set<string>();
  if (admin) {
    const { data: members } = await admin
      .from("user_organizations")
      .select("user_id")
      .eq("organization_id", activeOrg.orgId)
      .is("revoked_at", null);
    for (const m of members ?? []) {
      const { data: u } = await admin.auth.admin.getUserById(m.user_id as string);
      const memberEmail = u?.user?.email?.trim().toLowerCase();
      if (memberEmail) memberEmails.add(memberEmail);
    }
  }

  for (const inv of input.invitations) {
    const email = inv.email.trim().toLowerCase();

    // já é membro ativo → pula (não reenvia convite)
    if (memberEmails.has(email)) {
      failed.push({ email, reason: "already_member" });
      continue;
    }

    // Assinar, enviar e auditar é o gesto que a rota de plataforma também faz para o
    // dono de um cliente novo — vive em `lib/team/emitir-convite.ts` para não haver dois
    // lugares decidindo o que um convite vale. Aqui fica só a decisão de QUEM convidar.
    sent.push(
      await emitirConvite({
        email,
        role: inv.role,
        organizationId: activeOrg.orgId,
        orgName: activeOrg.name,
        inviterName,
        marca,
        actorUserId: authUser.id,
        requestId,
      }),
    );
  }

  return ok({ sent, failed }, { status: 201, requestId });
}
