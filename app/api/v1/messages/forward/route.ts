/**
 * POST /api/v1/messages/forward — encaminha mensagens de uma conversa para outras
 * (handler em ./_handler.ts). Cada cópia sai pelo mesmo caminho do envio comum.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { ApiError } from "@/lib/api/types";
import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { forwardMessagesSchema, validateRequest, type ForwardMessagesInput } from "@/lib/schemas";
import { createClient } from "@/lib/supabase/server";

import { forwardMessagesHandler } from "./_handler";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const supabase = await createClient();

  // Encaminhar é ENVIAR: agent+ (viewer é read-only), como o envio comum.
  const authz = await requireRole("agent", { requestId, resource: "messages" });
  if (!authz.ok) return authz.response;

  let input;
  try {
    input = await validateRequest(forwardMessagesSchema, req);
  } catch (err) {
    if (err instanceof ApiError) {
      return fail(err.code, err.message, err.status, {
        details: err.details as Record<string, unknown> | undefined,
        requestId,
      });
    }
    throw err;
  }

  try {
    const resultado = await forwardMessagesHandler(
      supabase,
      {
        organization_id: authz.org.orgId,
        actor: { type: "user", id: authz.user.id },
        requestId,
      },
      input as ForwardMessagesInput,
    );
    return ok(resultado, { status: 200, requestId });
  } catch (err) {
    if (err instanceof ApiError) {
      return fail(err.code, err.message, err.status, { requestId });
    }
    throw err;
  }
}
