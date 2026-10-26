/**
 * A plataforma convida o DONO de uma organização de cliente.
 *
 * É o único caminho que dá acesso a um cliente novo quando o cadastro público está
 * fechado (`CADASTRO_PUBLICO=false`): o dono recebe um convite de `admin`, cria a conta
 * por ele e entra na organização que a plataforma abriu — sem nunca ter aberto uma
 * própria. Quem chama já provou ser admin de plataforma (`requirePlatformAdmin`); aqui
 * não se autoriza nada.
 *
 * O papel é fixo em `admin`: "dono" não é um papel a escolher, e deixar o corpo da
 * requisição decidir transformaria esta função em "convide qualquer um para qualquer papel".
 */
import type { User } from "@supabase/supabase-js";

import { marcaDaSaida } from "@/lib/branding/saida";
import { emitirConvite, type ConviteEmitido } from "@/lib/team/emitir-convite";

export interface ConvidarDonoEntrada {
  email: string;
  organizationId: string;
  orgName: string;
  /** O admin de plataforma que está operando. */
  plataforma: Pick<User, "id" | "email" | "user_metadata">;
  requestId: string;
}

export async function convidarDonoDaOrganizacao(entrada: ConvidarDonoEntrada): Promise<ConviteEmitido> {
  // Marca resolvida pela organização-alvo: a organização nova ainda não configurou a
  // sua, então cai na da instalação — que é a que o cliente deve ver no primeiro e-mail.
  const marca = await marcaDaSaida(entrada.organizationId);
  const nomeNoMetadata = entrada.plataforma.user_metadata?.["full_name"];
  const inviterName =
    (typeof nomeNoMetadata === "string" ? nomeNoMetadata.trim() : "") || marca.nome;

  return emitirConvite({
    email: entrada.email,
    role: "admin",
    organizationId: entrada.organizationId,
    orgName: entrada.orgName,
    inviterName,
    marca,
    actorUserId: entrada.plataforma.id,
    requestId: entrada.requestId,
    porAdminDePlataforma: true,
  });
}
