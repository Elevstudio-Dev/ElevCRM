/**
 * GET  /api/v1/integrations/despachocerto — a integração está ligada?
 * PUT  /api/v1/integrations/despachocerto — liga (ou reconfigura).
 *
 * O GET é o interruptor que a TELA lê: sem integração, o inbox não mostra o
 * botão "Cadastrar". Por isso ele é aberto a `agent` — quem atende precisa
 * saber se tem o botão —, enquanto configurar é de `admin`: a chave de
 * integração dá acesso ao cadastro de clientes do outro sistema.
 *
 * O GET nunca devolve segredo: só se ele EXISTE. O PUT devolve o segredo do
 * webhook UMA vez, no momento em que o gera — é o padrão de `api-tokens` e de
 * `webhook-sources`, e é o que permite colar o valor no Despacho Certo sem
 * deixá-lo legível para sempre numa tela.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { conectar, lerIntegracao } from "@/lib/integrations/despachocerto/estado";

export const dynamic = "force-dynamic";

const conexaoSchema = z.object({
  base_url: z.string().trim().url("Informe a URL do Despacho Certo (ex.: https://app.despachocerto.com.br)."),
  chave: z.string().trim().min(8, "A chave de integração parece curta demais."),
  rotacionar_segredo: z.boolean().optional(),
});

/** A URL que o Despacho Certo precisa chamar — montada com o host do pedido. */
function urlDoWebhook(req: NextRequest, pathToken: string): string {
  const base = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "") || new URL(req.url).origin;
  return `${base}/api/v1/webhooks/despachocerto/${pathToken}`;
}

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "integrations" });
  if (!authz.ok) return authz.response;

  const integracao = await lerIntegracao(authz.org.orgId);
  if (!integracao) return ok({ conectado: false }, { requestId });

  return ok(
    {
      conectado: integracao.status !== "disconnected" && integracao.temChave,
      status: integracao.status,
      status_reason: integracao.statusReason,
      base_url: integracao.baseUrl,
      webhook_url: urlDoWebhook(req, integracao.webhookPathToken),
      tem_segredo: integracao.temSegredoDeWebhook,
      last_health_check_at: integracao.lastHealthCheckAt,
    },
    { requestId },
  );
}

export async function PUT(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "integrations" });
  if (!authz.ok) return authz.response;
  const { user, org } = authz;

  const raw = await req.json().catch(() => null);
  const parsed = conexaoSchema.safeParse(raw);
  if (!parsed.success) {
    return fail("validation_failed", parsed.error.issues[0]?.message ?? "Dados inválidos.", 422, {
      requestId,
    });
  }

  const { integracao, segredoEmClaro } = await conectar(org.orgId, {
    baseUrl: parsed.data.base_url,
    chave: parsed.data.chave,
    rotacionarSegredo: parsed.data.rotacionar_segredo,
  });

  await audit({
    organizationId: org.orgId,
    actorUserId: user.id,
    action: "despachocerto.connected",
    resourceType: "tenant_integration",
    resourceId: integracao.id,
    // A chave NÃO entra no audit — nem os quatro últimos. O que interessa a
    // quem investiga é quem ligou, quando e para qual endereço.
    metadata: { provider: "despachocerto", base_url: integracao.baseUrl },
    requestId,
  });

  return ok(
    {
      conectado: true,
      base_url: integracao.baseUrl,
      webhook_url: urlDoWebhook(req, integracao.webhookPathToken),
      /** Aparece UMA vez. Cole no Despacho Certo agora. */
      webhook_secret: segredoEmClaro,
    },
    { requestId },
  );
}
