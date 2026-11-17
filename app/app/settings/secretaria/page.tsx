/**
 * Configurações → Agenda da secretaria.
 *
 * A IA não enxerga a agenda real da clínica (ela vive no sistema da franquia). Quem sabe é a secretaria: a IA lhe
 * PERGUNTA como está o dia, em horários fixos, e só oferece horário aos pacientes se a agenda foi conferida há pouco.
 * Esta tela liga isso e responde às duas perguntas de quem opera: "quem é a secretaria?" e "a IA consegue falar com
 * ela?". Sem tela, a única forma de ligar era editar o banco à mão.
 *
 * Gate = gerente ou mais: ligar a secretaria muda quando a IA oferece horário e quando escreve à equipe.
 */
import { redirect } from "next/navigation";

import { lerSituacaoDaSecretaria } from "@/lib/agenda/secretaria/situacao";
import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { traduzir } from "@/lib/i18n/dicionario";
import { createClient } from "@/lib/supabase/server";

import { SecretariaForm } from "./_form";

export const dynamic = "force-dynamic";

export default async function SecretariaSettingsPage() {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) redirect("/app");
  if (!user.is_platform_admin && ROLE_RANK[activeOrg.role] < ROLE_RANK.manager) {
    redirect("/403");
  }

  const { config, secretarias } = await lerSituacaoDaSecretaria(await createClient(), activeOrg.orgId);
  const idioma = user.idioma;

  return (
    <div className="flex h-full flex-col gap-6 overflow-y-auto p-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">{traduzir("Agenda da secretaria", idioma)}</h1>
        <p className="max-w-2xl text-sm text-muted-foreground">
          {traduzir(
            "A agenda real da clínica fica no sistema da franquia, e quem sabe como ela está é a secretaria. A IA pergunta a ela, pelo WhatsApp, em horários fixos, e só oferece horário aos pacientes se a agenda foi conferida há pouco.",
            idioma,
          )}
        </p>
      </header>

      <SecretariaForm initial={config} secretarias={secretarias} />
    </div>
  );
}
