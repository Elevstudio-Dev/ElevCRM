import Link from "next/link";
import { redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { traduzir } from "@/lib/i18n/dicionario";
import { QrCode } from "@/lib/ui/icons";

import { RelatoriosClient } from "./_components/RelatoriosClient";

export const dynamic = "force-dynamic";

export default async function RelatoriosPage() {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  // Relatório é de gestor+ (decisão do dono). Quem atende nem vê a aba; chegando pelo endereço, volta ao Inbox.
  const podeVer = user.is_platform_admin || (!!activeOrg && ROLE_RANK[activeOrg.role] >= ROLE_RANK.manager);
  if (!podeVer) redirect("/app/inbox");
  const idioma = user.idioma;

  return (
    <div className="flex h-full flex-col gap-6 overflow-y-auto p-4 sm:p-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{traduzir("Relatórios", idioma)}</h1>
          <p className="text-sm text-text-muted">
            {traduzir("De onde vêm os leads e quantos viram venda.", idioma)}
          </p>
        </div>
        <Link
          href="/app/relatorios/qr-codes"
          className="inline-flex h-11 items-center gap-2 rounded-md border border-border px-4 text-sm text-text transition-colors hover:border-accent hover:text-accent lg:h-9"
        >
          <QrCode size={16} aria-hidden />
          {traduzir("QR codes", idioma)}
        </Link>
      </header>
      <RelatoriosClient />
    </div>
  );
}
