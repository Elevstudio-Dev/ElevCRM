"use client";
import { useTransition } from "react";
import { useUser, useAuth } from "@/hooks/auth/AuthProvider";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { ThemeToggle } from "@/components/theme/theme-toggle";
import { PreferenciasNoMenu } from "@/components/shell/PreferenciasNoMenu";
import { PontoDeVersaoNova, VersaoNoMenu } from "@/components/shell/VersaoNoMenu";
import { useT } from "@/hooks/i18n/useT";
import { useNaColunaLateral } from "@/hooks/shell/useNaColunaLateral";
import { SignOut } from "@/lib/ui/icons";

function initials(name: string | null, email: string): string {
  if (name && name.trim()) {
    return name.trim().split(/\s+/).slice(0, 2).map((p) => p[0]).join("").toUpperCase();
  }
  return email.slice(0, 2).toUpperCase();
}

export function UserMenu() {
  const t = useT();
  const user = useUser();
  const { signOut } = useAuth();
  const [isPending, startTransition] = useTransition();

  const naColuna = useNaColunaLateral();

  return (
    <div className="flex items-center gap-2">
      {/* Idioma e tema moram DENTRO do menu abaixo (`PreferenciasNoMenu`) em toda largura: a coluna
          lateral tem 64px e não comporta botões soltos, e o celular não comportava antes. O
          `ThemeToggle` continua montado, escondido: é ele quem registra o atalho Cmd+Shift+L, que
          não deve sumir junto com o botão. O `SeletorDeIdioma` ficou sem lugar na barra — a troca
          de idioma é a do menu. */}
      <div className="hidden" aria-hidden>
        <ThemeToggle />
      </div>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" className="relative rounded-full md:h-11 md:w-11" aria-label={t("Menu do usuário")} data-testid="menu-do-usuario">
            <Avatar className="h-8 w-8">
              {user.avatar_url && <AvatarImage src={user.avatar_url} alt="" />}
              <AvatarFallback>{initials(user.full_name, user.email)}</AvatarFallback>
            </Avatar>
            <PontoDeVersaoNova />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          // Na coluna lateral o menu abre PARA O LADO, com a borda de baixo alinhada à do avatar
          // (cresce para cima, como o do WhatsApp); no celular, para baixo, como sempre foi.
          side={naColuna ? "right" : "bottom"}
          // 16px: a coluna tem 64px e o avatar fica a 16 da borda esquerda dela; com o respiro de
          // sempre (4px) o menu nascia por cima da coluna.
          sideOffset={naColuna ? 16 : 4}
          align="end"
          className="min-w-[220px]"
        >
          <DropdownMenuLabel>
            <div className="flex flex-col">
              <span className="text-sm font-medium">{user.full_name ?? user.email}</span>
              <span className="truncate text-xs text-muted-foreground">{user.email}</span>
            </div>
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          <PreferenciasNoMenu />
          <DropdownMenuItem disabled={isPending} onClick={() => startTransition(async () => { await signOut(); })}>
            <SignOut size={16} className="mr-2" aria-hidden />
            {t("Sair")}
          </DropdownMenuItem>
          {/* A versão instalada fecha o menu — era o rodapé do menu lateral. */}
          <VersaoNoMenu />
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
