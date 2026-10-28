"use client";
import { useTransition } from "react";
import { CaretDown, Storefront } from "@/lib/ui/icons";
import { useUser, useActiveOrg } from "@/hooks/auth/AuthProvider";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { setActiveOrg } from "@/app/actions/shell/setActiveOrg";

/**
 * O seletor só existe para quem pertence a mais de uma organização. A condição
 * mora aqui, numa definição só, porque a barra precisa saber se ele está lá
 * para decidir o que ceder a ele (ver `TopBar`).
 */
export function useTemSeletorDeOrganizacao(): boolean {
  return useUser().organizations.length > 1;
}

export function TenantSwitcher() {
  const user = useUser();
  const active = useActiveOrg();
  const [isPending, startTransition] = useTransition();
  const temSeletor = useTemSeletorDeOrganizacao();

  if (!temSeletor) return null;

  return (
    <DropdownMenu>
      {/*
        O rótulo é o que cede. Um item de flex tem `min-width: auto` = o conteúdo, e o conteúdo
        aqui é o nome INTEIRO da organização (o `truncate` do `span` não conta para quem está
        fora): sem `min-w-*` o botão se recusava a encolher e passava por cima da busca
        (medido: 126px onde sobravam 109, em 375px). O piso é ícone + seta + respiro; o
        `span` trunca no que sobrar. Compacto no celular, o respiro de sempre de `md:` em diante.
        (O comentário fica ACIMA do gatilho de propósito: `controle-decorativo.test.ts` reconhece o
        botão de `<…Trigger asChild>` olhando as duas linhas antes dele.)
      */}
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          disabled={isPending}
          className="min-w-14 gap-1.5 px-2 md:min-w-[4.25rem] md:gap-2 md:px-3"
          data-testid="tenant-switcher"
        >
          <Storefront size={16} weight="duotone" aria-hidden />
          <span className="max-w-[160px] truncate">{active?.name ?? "Selecionar org"}</span>
          <CaretDown size={12} aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-[220px]">
        {user.organizations.map((org) => (
          <DropdownMenuItem
            key={org.organization_id}
            data-testid={`tenant-switcher-item-${org.organization_id}`}
            onClick={() => startTransition(async () => { await setActiveOrg(org.organization_id); })}
            className="flex items-center justify-between"
          >
            <span className="truncate">{org.organization_name}</span>
            {active?.orgId === org.organization_id && <span className="text-xs text-muted-foreground">✓</span>}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
