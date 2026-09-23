/**
 * A INTEGRAÇÃO, POR ORGANIZAÇÃO — ligada ou não, e com que credenciais.
 *
 * Uma linha em `tenant_integrations` com `provider = 'despachocerto'` é o
 * interruptor: enquanto ela não existe, o Elev CRM não sabe que o Despacho
 * Certo existe, e o botão "Cadastrar" do inbox não aparece. É o que faz a
 * integração ser plugin e não feature — o CRM se vende para loja, clínica e
 * escritório, e nenhum deles pode ver um botão de despachante.
 *
 * O que a linha guarda:
 *   - `store_metadata.base_url` — onde o Despacho Certo atende (público).
 *   - `oauth_access_token_encrypted` — a chave com que o CRM fala com ele.
 *   - `webhook_path_token` — a identidade PÚBLICA da URL que o Despacho Certo
 *     chama para avisar de uma OS. Não é segredo: é a mesma ideia do token de
 *     caminho que o webhook per-tenant do canal já usa.
 *   - `webhook_secret_encrypted` — o segredo do HMAC do corpo, esse sim.
 */
import { randomUUID } from "node:crypto";

import { byteaToBuffer, bufToBytea } from "@/lib/crypto/aes_gcm";
import { createAdminClient } from "@/lib/supabase/admin";
import { PROVEDOR } from "./contrato";
import { desempacotarSegredo, empacotarSegredo } from "./segredo";

export interface IntegracaoDoDespacho {
  id: string;
  organizationId: string;
  baseUrl: string;
  status: string;
  statusReason: string | null;
  webhookPathToken: string;
  /** Só o que a tela pode mostrar: se existe chave, não qual é. */
  temChave: boolean;
  temSegredoDeWebhook: boolean;
  lastHealthCheckAt: string | null;
}

interface LinhaCrua {
  id: string;
  organization_id: string;
  status: string;
  status_reason: string | null;
  store_metadata: Record<string, unknown> | null;
  webhook_path_token: string | null;
  oauth_access_token_encrypted: unknown;
  webhook_secret_encrypted: unknown;
  last_health_check_at: string | null;
}

const COLS =
  "id, organization_id, status, status_reason, store_metadata, webhook_path_token, oauth_access_token_encrypted, webhook_secret_encrypted, last_health_check_at";

function projetar(l: LinhaCrua): IntegracaoDoDespacho {
  const meta = (l.store_metadata ?? {}) as { base_url?: unknown };
  return {
    id: l.id,
    organizationId: l.organization_id,
    baseUrl: typeof meta.base_url === "string" ? meta.base_url : "",
    status: l.status,
    statusReason: l.status_reason,
    webhookPathToken: l.webhook_path_token ?? "",
    temChave: Boolean(l.oauth_access_token_encrypted),
    temSegredoDeWebhook: Boolean(l.webhook_secret_encrypted),
    lastHealthCheckAt: l.last_health_check_at,
  };
}

/** A integração desta organização, ou `null` quando ninguém ligou. */
export async function lerIntegracao(organizationId: string): Promise<IntegracaoDoDespacho | null> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("tenant_integrations")
    .select(COLS)
    .eq("organization_id", organizationId)
    .eq("provider", PROVEDOR)
    .maybeSingle();
  return data ? projetar(data as unknown as LinhaCrua) : null;
}

/** As credenciais para FALAR com o Despacho Certo. Nunca vão para a tela. */
export async function lerCredenciais(
  organizationId: string,
): Promise<{ baseUrl: string; chave: string } | null> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("tenant_integrations")
    .select("store_metadata, oauth_access_token_encrypted, status")
    .eq("organization_id", organizationId)
    .eq("provider", PROVEDOR)
    .maybeSingle();
  if (!data) return null;
  const meta = (data.store_metadata ?? {}) as { base_url?: unknown };
  const baseUrl = typeof meta.base_url === "string" ? meta.base_url : "";
  const chave = desempacotarSegredo(byteaToBuffer(data.oauth_access_token_encrypted));
  if (!baseUrl || !chave) return null;
  return { baseUrl, chave };
}

/** O segredo do HMAC de quem chega pelo webhook — resolvido PELO token do caminho. */
export async function lerSegredoDoWebhook(
  pathToken: string,
): Promise<{ organizationId: string; segredo: string | null } | null> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("tenant_integrations")
    .select("organization_id, webhook_secret_encrypted")
    .eq("provider", PROVEDOR)
    .eq("webhook_path_token", pathToken)
    .maybeSingle();
  if (!data) return null;
  return {
    organizationId: data.organization_id as string,
    segredo: desempacotarSegredo(byteaToBuffer(data.webhook_secret_encrypted)),
  };
}

export interface ConexaoPedida {
  baseUrl: string;
  chave: string;
  /** Gerar um segredo de webhook novo? (a tela mostra o valor uma única vez) */
  rotacionarSegredo?: boolean;
}

/**
 * Liga (ou reconfigura) a integração. Devolve o que a tela precisa mostrar
 * UMA vez: a URL do webhook e o segredo em claro.
 *
 * O `path_token` NÃO é rotacionado a cada salvamento: ele já está colado no
 * outro sistema, e trocá-lo por causa de uma correção de URL desligaria a
 * integração sem ninguém pedir.
 */
export async function conectar(
  organizationId: string,
  pedido: ConexaoPedida,
): Promise<{ integracao: IntegracaoDoDespacho; segredoEmClaro: string | null }> {
  const admin = createAdminClient();
  const atual = await lerIntegracao(organizationId);

  const pathToken = atual?.webhookPathToken || randomUUID().replace(/-/g, "");
  const precisaSegredo = pedido.rotacionarSegredo === true || !atual?.temSegredoDeWebhook;
  const segredoEmClaro = precisaSegredo ? randomUUID().replace(/-/g, "") : null;

  const patch: Record<string, unknown> = {
    organization_id: organizationId,
    provider: PROVEDOR,
    status: "healthy",
    status_reason: null,
    store_metadata: { base_url: pedido.baseUrl.replace(/\/$/, "") },
    webhook_path_token: pathToken,
    oauth_access_token_encrypted: bufToBytea(empacotarSegredo(pedido.chave)),
    updated_at: new Date().toISOString(),
  };
  if (segredoEmClaro) {
    patch.webhook_secret_encrypted = bufToBytea(empacotarSegredo(segredoEmClaro));
  }

  // UPDATE quando a linha existe; INSERT quando não existe. NÃO um `upsert`.
  //
  // `webhook_secret_encrypted` é NOT NULL, e quem salva só para corrigir a URL
  // não rotaciona o segredo — então a coluna fica fora do `patch`. Num
  // `upsert`, o Postgres monta a tupla do INSERT e valida o NOT NULL ANTES de
  // detectar o conflito: a linha existia, o caminho seria de update, e ainda
  // assim a gravação reprovava com "null value in column
  // webhook_secret_encrypted". Medido na primeira conexão real, 23/09.
  //
  // Repetir o segredo cifrado no patch resolveria o sintoma relendo e
  // regravando bytes que ninguém pediu para mudar. Separar as duas operações
  // diz o que cada uma é: corrigir o que mudou, ou criar o que não existe.
  const escrita = atual
    ? admin
        .from("tenant_integrations")
        .update(patch)
        .eq("organization_id", organizationId)
        .eq("provider", PROVEDOR)
    : admin.from("tenant_integrations").insert(patch);

  const { data, error } = await escrita.select(COLS).single();
  if (error) throw new Error(`não consegui gravar a integração: ${error.message}`);

  return { integracao: projetar(data as unknown as LinhaCrua), segredoEmClaro };
}

/** Marca o que o outro lado respondeu na última conversa — saúde honesta. */
export async function registrarSaude(
  organizationId: string,
  resultado: { ok: boolean; motivo?: string },
): Promise<void> {
  const admin = createAdminClient();
  await admin
    .from("tenant_integrations")
    .update({
      status: resultado.ok ? "healthy" : "error",
      status_reason: resultado.ok ? null : (resultado.motivo ?? "erro"),
      last_health_check_at: new Date().toISOString(),
    })
    .eq("organization_id", organizationId)
    .eq("provider", PROVEDOR);
}
