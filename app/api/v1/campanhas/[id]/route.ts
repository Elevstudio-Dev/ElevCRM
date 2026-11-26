/**
 * GET /api/v1/campanhas/:id — a campanha e cada destinatário com a situação
 * (agendado, enviado, respondeu, pediu para sair…) (qualquer membro).
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { detalharCampanha } from "@/lib/campanhas/servico";
import { createAdminClient } from "@/lib/supabase/admin";

import { UUID_RX, respostaDeErro } from "../_comum";

export const dynamic = "force-dynamic";

type RouteCtx = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const requestId = randomUUID();
  const { id } = await ctx.params;
  if (!UUID_RX.test(id)) return fail("invalid_request", "id inválido.", 400, { requestId });

  const authz = await requireRole("viewer", { requestId, resource: "campanhas" });
  if (!authz.ok) return authz.response;
  try {
    return ok(await detalharCampanha(createAdminClient(), authz.org.orgId, id), { requestId });
  } catch (err) {
    return respostaDeErro(err, requestId, "detalhar");
  }
}
