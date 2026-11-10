import Link from "next/link";
import { redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { traduzir } from "@/lib/i18n/dicionario";
import { ArrowLeft } from "@/lib/ui/icons";

import { MetaAdsClient } from "./_components/MetaAdsClient";

export const dynamic = "force-dynamic";

export default async function MetaAdsPage() {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  // Dono e gerente: a chave dá acesso aos números de investimento da empresa. Quem atende não tem esta tela.
  const podeVer = user.is_platform_admin || (!!activeOrg && ROLE_RANK[activeOrg.role] >= ROLE_RANK.manager);
  if (!podeVer) redirect("/app/inbox");
  const idioma = user.idioma;

  return (
    <div className="flex h-full flex-col gap-6 overflow-y-auto p-4 sm:p-6">
      <header className="flex flex-col gap-2">
        <Link
          href="/app/relatorios"
          className="inline-flex w-fit items-center gap-1.5 text-sm text-text-muted transition-colors hover:text-accent"
        >
          <ArrowLeft size={14} aria-hidden />
          {traduzir("Relatórios", idioma)}
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">{traduzir("Meta Ads", idioma)}</h1>
        <p className="text-sm text-text-muted">
          {traduzir(
            "Traga da Meta quanto cada anúncio gastou para ver o custo por contato e o retorno nos relatórios.",
            idioma,
          )}
        </p>
      </header>
      <MetaAdsClient />
    </div>
  );
}
