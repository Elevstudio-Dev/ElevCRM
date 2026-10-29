"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";

import { ConnectionHealthDot } from "@/components/connections/ConnectionHealthDot";
import { useAuth } from "@/hooks/auth/AuthProvider";
import { useT } from "@/hooks/i18n/useT";
import { abasPrincipais } from "@/lib/navigation/registry";
import { cn } from "@/lib/utils";

/**
 * As abas da barra superior — a navegação de uso diário, ao lado da busca.
 *
 * Não decide nada: `abasPrincipais()` (lib/navigation/registry.ts) resolve
 * quais abas este papel vê e em que ordem; isto desenha. Cinco abas e não
 * vinte: o que não está aqui está em Configurações, que é o inventário.
 *
 * Abaixo de `lg` (1024px) o rótulo some e fica o ícone com `title` — cinco
 * abas com texto, a marca, a busca e três ícones não cabem em 768px, e uma
 * barra que rola de lado é o menu lateral de novo, deitado.
 */
export function AbasPrincipais({ className }: { className?: string }) {
  const t = useT();
  const pathname = usePathname();
  const { user, activeOrg } = useAuth();
  const abas = abasPrincipais(user.is_platform_admin, activeOrg?.role ?? null);
  // Com a sexta aba (Relatórios, gestor+) os rótulos só cabem de `xl`: a 1024px, ao lado do seletor de
  // organização, seis rótulos passavam por cima dele (47px medidos). Cinco abas seguem com rótulo de `lg`.
  const rotuloDeLg = abas.length <= 5;

  return (
    <nav aria-label={t("Navegação principal")} className={cn("flex items-center gap-1", className)}>
      {abas.map((aba) => {
        const ativa = pathname === aba.href || pathname.startsWith(aba.href + "/");
        const Icon = aba.icon;
        return (
          <Link
            key={aba.href}
            href={aba.href}
            title={t(aba.label)}
            aria-current={ativa ? "page" : undefined}
            className={cn(
              "relative flex h-9 items-center gap-2 rounded-md px-2.5 text-sm transition-colors lg:px-3",
              ativa
                ? "bg-accent font-medium text-accent-foreground"
                : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
            )}
          >
            <Icon size={18} weight={ativa ? "fill" : "regular"} aria-hidden />
            <span className={rotuloDeLg ? "hidden lg:inline" : "hidden xl:inline"}>{t(aba.label)}</span>
            {aba.healthDot && <ConnectionHealthDot className="absolute right-1 top-1" />}
          </Link>
        );
      })}
    </nav>
  );
}
