"use client";
import { useState } from "react";
import { useHotkeys } from "react-hotkeys-hook";
import { MagnifyingGlass } from "@/lib/ui/icons";
import { Button } from "@/components/ui/button";
import { useT } from "@/hooks/i18n/useT";
import { CommandPalette } from "@/components/shell/CommandPalette";

export function SearchTrigger() {
  const t = useT();
  const [open, setOpen] = useState(false);

  // `enableOnFormTags`: o atalho precisa funcionar com o cursor dentro do
  // composer do inbox, que é onde o operador passa o dia.
  useHotkeys("mod+k", () => setOpen(true), { preventDefault: true, enableOnFormTags: true });

  return (
    <>
      {/* Só o ícone, nos dois formatos da casca (barra no celular, coluna no desktop). O texto e o
          atalho continuam acessíveis: `sr-only` e `title`. */}
      <Button
        variant="ghost"
        size="sm"
        className="gap-2 text-muted-foreground md:h-11 md:w-11 md:rounded-full md:p-0"
        title={`${t("Buscar...")} (⌘K)`}
        onClick={() => setOpen(true)}
      >
        <MagnifyingGlass size={18} aria-hidden />
        <span className="sr-only">{t("Buscar...")}</span>
      </Button>
      <CommandPalette open={open} onOpenChange={setOpen} />
    </>
  );
}
