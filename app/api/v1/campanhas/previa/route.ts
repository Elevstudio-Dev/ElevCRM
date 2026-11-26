/**
 * POST /api/v1/campanhas/previa — quantos recebem, quantos ficam de fora (e por
 * quê) e quando sai o primeiro e o último envio. Não grava nada (manager+).
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { previaDaCampanhaSchema } from "@/lib/campanhas/parametros";
import { previaDaCampanha } from "@/lib/campanhas/servico";
import { createAdminClient } from "@/lib/supabase/admin";

import { lerJson, respostaDeErro } from "../_comum";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "campanhas" });
  if (!authz.ok) return authz.response;

  const parsed = previaDaCampanhaSchema.safeParse(await lerJson(req));
  if (!parsed.success) {
    return fail("validation_failed", "Campos inválidos.", 422, { requestId, details: parsed.error.flatten() });
  }
  try {
    const previa = await previaDaCampanha(
      createAdminClient(),
      authz.org.orgId,
      parsed.data.etiquetas,
      parsed.data.ritmo,
      new Date(),
    );
    return ok(previa, { requestId });
  } catch (err) {
    return respostaDeErro(err, requestId, "previa");
  }
}
