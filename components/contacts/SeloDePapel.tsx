"use client";

import { Badge } from "@/components/ui/badge";
import { useT } from "@/hooks/i18n/useT";
import { ehPapelInterno } from "@/lib/bastidor/papeis";
import { cn } from "@/lib/utils";

/**
 * O selo do papel na equipe: "Secretaria" ou "Marketing". Só ocupa lugar quando o contato tem papel (devolve
 * `null` senão), então pode ser posto em qualquer linha sem decidir antes.
 */
export function SeloDePapel({ papel, className }: { papel: string | null | undefined; className?: string }) {
  const t = useT();
  if (!ehPapelInterno(papel)) return null;
  return (
    <Badge variant="info" data-testid="selo-de-papel" className={cn("shrink-0", className)}>
      {papel === "secretaria" ? t("Secretaria") : t("Marketing")}
    </Badge>
  );
}
