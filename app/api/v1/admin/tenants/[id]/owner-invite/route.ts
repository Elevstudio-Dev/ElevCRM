/**
 * POST /api/v1/admin/tenants/[id]/owner-invite
 *
 * A plataforma (re)emite o convite de ADMIN do dono de uma organização que já existe.
 * O convite é um token de 24h sem linha em tabela: se o cliente demorou, perdeu o e-mail
 * ou o e-mail nunca saiu, esta é a saída — sem ela só restava recriar o tenant.
 *
 * Body: `{ email }`. O papel é sempre `admin` (ver `lib/team/convidar-dono.ts`).
 * 404 se a organização não existe; 409 se não está ativa (suspensa ou redigida por LGPD:
 * convidar não leva a lugar nenhum — reative antes).
 *
 * `email_dispatched: false` não é erro: o link vem na resposta para o operador entregar
 * pelo canal que o cliente usa.
 */
import { type NextRequest } from "next/server";
import { randomUUID } from "node:crypto";
import { z } from "zod";

import { requirePlatformAdmin } from "@/lib/auth/requirePlatformAdmin";
import { createAdminClient } from "@/lib/supabase/admin";
import { ok, fail } from "@/lib/api/wrappers";
import { convidarDonoDaOrganizacao } from "@/lib/team/convidar-dono";

export const dynamic = "force-dynamic";

const paramsSchema = z.object({ id: z.string().uuid() });
const bodySchema = z.object({ email: z.string().email() });

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const requestId = randomUUID();

  let adminCtx: Awaited<ReturnType<typeof requirePlatformAdmin>>;
  try {
    adminCtx = await requirePlatformAdmin();
  } catch {
    return fail("forbidden", "Platform admin required", 403, { requestId });
  }

  const idParsed = paramsSchema.safeParse(await params);
  if (!idParsed.success) {
    return fail("validation_error", "Invalid tenant id", 400, { requestId });
  }
  const tenantId = idParsed.data.id;

  let body: z.infer<typeof bodySchema>;
  try {
    body = bodySchema.parse(await req.json());
  } catch {
    return fail("validation_error", "Invalid request body", 400, { requestId });
  }

  const admin = createAdminClient();
  const { data: org, error: orgError } = await admin
    .from("organizations")
    .select("id, display_name, status")
    .eq("id", tenantId)
    .maybeSingle();

  if (orgError || !org) {
    return fail("not_found", "Tenant not found", 404, { requestId });
  }
  if (org.status !== "active") {
    return fail("state_conflict", `Tenant is ${org.status}; only active tenants can be invited`, 409, {
      requestId,
    });
  }

  const ownerInvite = await convidarDonoDaOrganizacao({
    email: body.email,
    organizationId: org.id,
    orgName: org.display_name,
    plataforma: adminCtx.user,
    requestId,
  });

  return ok({ owner_invite: ownerInvite }, { status: 201, requestId });
}
