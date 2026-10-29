/**
 * POST /api/v1/contacts/fora-do-funil/previa — o que mudaria, SEM mudar nada (atendente+).
 *
 * É o que o diálogo mostra antes de confirmar ("2 negócios abertos e 1 venda ganha de R$ 1.500,00 saem do funil e
 * do relatório"). POST porque a lista de ids da seleção em massa não cabe numa query string.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { previaDoMarcador } from "@/lib/contatos/fora-do-funil";
import { previaForaDoFunilSchema } from "@/lib/schemas/fora-do-funil";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "contacts", allowPlatformAdmin: true });
  if (!authz.ok) return authz.response;

  const parsed = previaForaDoFunilSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("validation_failed", "Dados inválidos.", 422, { requestId, details: parsed.error.flatten() });
  }

  try {
    const previa = await previaDoMarcador(
      await createClient(),
      authz.org.orgId,
      parsed.data.contact_ids,
      parsed.data.marcar,
    );
    return ok(previa, { requestId });
  } catch (err) {
    return fail("internal_error", err instanceof Error ? err.message : "Falha ao calcular.", 500, { requestId });
  }
}
