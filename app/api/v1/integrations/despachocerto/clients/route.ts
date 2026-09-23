/**
 * POST /api/v1/integrations/despachocerto/clients — o botão "Cadastrar".
 *
 * O caminho inteiro de um clique, nesta ordem e sem atalho:
 *
 *   1. procura no Despacho Certo por telefone (e documento, se houver);
 *   2. não achou → cria lá com os dados do diálogo;
 *   3. grava o VÍNCULO aqui (`integration_contact_links`);
 *   4. devolve à tela quem é o cliente e se ele já existia.
 *
 * ─── Por que procurar antes ─────────────────────────────────────────────────
 *
 * Decisão do dono: telefone que já é cliente lá deve VINCULAR, não duplicar.
 * Cadastro duplicado faria a OS cair num dos dois, sorteado, e a tag apareceria
 * na conversa errada.
 *
 * ─── Por que o vínculo é gravado aqui, e não confiado ao outro lado ─────────
 *
 * O vínculo é o que faz a OS achar a conversa depois. Se ele dependesse de o
 * Despacho Certo chamar de volta, uma falha de rede entre os dois deixaria o
 * cadastro feito lá e invisível aqui — e o operador clicaria "Cadastrar" de
 * novo, agora recebendo "já existe" para sempre, sem nunca ver o vínculo.
 *
 * ─── O que acontece se o vínculo já existir ─────────────────────────────────
 *
 * `upsert` pela unicidade `(org, provider, contact_id)`: cadastrar duas vezes
 * o mesmo contato atualiza o vínculo em vez de estourar. O caso real é o
 * operador clicando duas vezes no botão.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { buscarCliente, criarCliente, FalhaDoDespachoCerto } from "@/lib/integrations/despachocerto/cliente";
import { clienteParaCadastrarSchema, PROVEDOR } from "@/lib/integrations/despachocerto/contrato";
import { lerCredenciais, registrarSaude } from "@/lib/integrations/despachocerto/estado";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const pedidoSchema = clienteParaCadastrarSchema.extend({
  contact_id: z.string().uuid(),
});

export async function POST(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  // `agent`: quem atende é quem cadastra — é o clique do dia a dia, ao lado de
  // "Assumir". Configurar a integração é que é de admin.
  const authz = await requireRole("agent", { requestId, resource: "integrations" });
  if (!authz.ok) return authz.response;
  const { user, org } = authz;

  const parsed = pedidoSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("validation_failed", parsed.error.issues[0]?.message ?? "Dados inválidos.", 422, {
      requestId,
    });
  }
  const { contact_id: contactId, ...dados } = parsed.data;

  const cred = await lerCredenciais(org.orgId);
  if (!cred) {
    return fail(
      "integration_not_configured",
      "A integração com o Despacho Certo não está configurada.",
      409,
      { requestId },
    );
  }

  // O contato é DESTA organização? A pergunta vai ao banco pelo client de
  // sessão (RLS), e não ao corpo do pedido.
  const supabase = await createClient();
  const { data: contato } = await supabase
    .from("contacts")
    .select("id")
    .eq("organization_id", org.orgId)
    .eq("id", contactId)
    .maybeSingle();
  if (!contato) return fail("not_found", "Contato não encontrado.", 404, { requestId });

  let cliente;
  let existente = false;
  try {
    const achado = await buscarCliente(cred, {
      phone: dados.phone,
      document: dados.document || undefined,
    });
    if (achado) {
      cliente = achado;
      existente = true;
    } else {
      const criado = await criarCliente(cred, dados);
      cliente = criado.cliente;
      existente = criado.existente;
    }
    await registrarSaude(org.orgId, { ok: true });
  } catch (err) {
    const falha = err instanceof FalhaDoDespachoCerto ? err : null;
    const motivo = falha?.message ?? (err instanceof Error ? err.message : "erro desconhecido");
    await registrarSaude(org.orgId, { ok: false, motivo });
    // 502: o erro não é do pedido de quem clicou — é do outro sistema. Dizer
    // isso evita que o operador fique corrigindo o formulário sem motivo.
    return fail("upstream_error", motivo, 502, { requestId });
  }

  const admin = createAdminClient();
  const { error: erroDoVinculo } = await admin.from("integration_contact_links").upsert(
    {
      organization_id: org.orgId,
      provider: PROVEDOR,
      contact_id: contactId,
      external_id: cliente.id,
      external_metadata: {
        name: cliente.name,
        url: cliente.url ?? null,
        plates: cliente.plates ?? [],
      },
      updated_at: new Date().toISOString(),
    },
    { onConflict: "organization_id,provider,contact_id" },
  );
  if (erroDoVinculo) {
    // 23505 aqui só pode ser a OUTRA unicidade: este cadastro do Despacho
    // Certo já está ligado a um contato DIFERENTE. Não é erro do servidor, é
    // uma decisão que a tela precisa apresentar a uma pessoa.
    if (erroDoVinculo.code === "23505") {
      return fail(
        "already_linked",
        "Este cliente do Despacho Certo já está vinculado a outro contato deste CRM.",
        409,
        { requestId },
      );
    }
    return fail("internal_error", erroDoVinculo.message, 500, { requestId });
  }

  await audit({
    organizationId: org.orgId,
    actorUserId: user.id,
    action: "despachocerto.client_linked",
    resourceType: "contact",
    resourceId: contactId,
    metadata: { external_id: cliente.id, existente },
    requestId,
  });

  return ok({ cliente, existente }, { requestId });
}
