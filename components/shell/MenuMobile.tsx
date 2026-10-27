"use client";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { useT } from "@/hooks/i18n/useT";
import { MenuCompleto } from "@/components/shell/MenuCompleto";
import { List } from "@/lib/ui/icons";

/**
 * Navegação mobile do app autenticado: uma gaveta com o inventário inteiro.
 *
 * No desktop as abas cabem na barra e o resto mora em Configurações. Abaixo de
 * `md` não cabe aba nenhuma, então a gaveta traz TUDO — é a única porta que o
 * celular tem além da busca.
 */
export function MenuMobile() {
  const t = useT();
  const [open, setOpen] = useState(false);

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-11 w-11 shrink-0 md:hidden"
          aria-label={t("Abrir navegação")}
        >
          <List size={22} aria-hidden />
        </Button>
      </SheetTrigger>
      <SheetContent
        side="left"
        className="flex w-72 max-w-[calc(100vw-2rem)] flex-col gap-0 p-0 sm:max-w-xs"
      >
        <SheetTitle className="sr-only">{t("Todas as telas")}</SheetTitle>
        <MenuCompleto onNavigate={() => setOpen(false)} />
      </SheetContent>
    </Sheet>
  );
}
