import { redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { traduzir } from "@/lib/i18n/dicionario";

import { ForaDoFunilClient } from "./_client";

export const dynamic = "force-dynamic";

/**
 * Os tipos de contato "fora do funil" — equipe, prestador, parceiro: gente que escreve no WhatsApp e não é
 * cliente. `manager`: quem define o vocabulário da operação responde por ela (mesma régua dos Marcadores). Marcar
 * um contato, esse sim, é de qualquer atendente — o tipo é só a etiqueta para achar a pessoa depois.
 */
export default async function ForaDoFunilPage() {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) redirect("/app");
  if (!user.is_platform_admin && ROLE_RANK[activeOrg.role] < ROLE_RANK.manager) {
    redirect("/403");
  }
  const idioma = user.idioma;

  return (
    <div className="flex h-full flex-col gap-6 overflow-y-auto p-4 sm:p-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">{traduzir("Contatos fora do funil", idioma)}</h1>
        <p className="max-w-2xl text-sm text-text-muted">
          {traduzir(
            "Equipe, prestadores e parceiros escrevem no WhatsApp mas não são clientes. Marque o contato como fora do funil: a IA se cala, nenhum negócio nasce e eles saem do funil e do relatório. Aqui você cadastra os tipos para achar essas pessoas depois.",
            idioma,
          )}
        </p>
      </header>
      <ForaDoFunilClient />
    </div>
  );
}
