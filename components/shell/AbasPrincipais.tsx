"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";

import { ConnectionHealthDot } from "@/components/connections/ConnectionHealthDot";
import { useAuth } from "@/hooks/auth/AuthProvider";
import { useT } from "@/hooks/i18n/useT";
import { abasPrincipais } from "@/lib/navigation/registry";
import { cn } from "@/lib/utils";

/**
 * As abas da coluna lateral — a navegação de uso diário.
 *
 * Não decide nada: `abasPrincipais()` (lib/navigation/registry.ts) resolve
 * quais abas este papel vê e em que ordem; isto desenha. Cinco abas e não
 * vinte: o que não está aqui está em Configurações, que é o inventário.
 *
 * Só ícones, em coluna (a coluna do WhatsApp): o nome fica no `title` e num
 * `sr-only`. Larga ela não precisa ser — 64px — e é isso que devolve a largura
 * ao inbox, que foi o motivo de o menu lateral antigo (240px) ter saído.
 */
export function AbasPrincipais({ className }: { className?: string }) {
  const t = useT();
  const pathname = usePathname();
  const { user, activeOrg } = useAuth();
  const abas = abasPrincipais(user.is_platform_admin, activeOrg?.role ?? null);

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
              // Só o ícone, num círculo — como a coluna do WhatsApp. O nome vai no `title` (dica ao
              // passar o mouse) e no `sr-only` (leitor de tela).
              "relative flex h-11 w-11 items-center justify-center rounded-full transition-colors",
              ativa
                ? "bg-accent text-accent-foreground"
                : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
            )}
          >
            <Icon size={22} weight={ativa ? "fill" : "regular"} aria-hidden />
            <span className="sr-only">{t(aba.label)}</span>
            {aba.healthDot && <ConnectionHealthDot className="absolute right-1 top-1" />}
          </Link>
        );
      })}
    </nav>
  );
}
