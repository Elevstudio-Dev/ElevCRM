"use client";

import { Badge } from "@/components/ui/badge";
import { useT } from "@/hooks/i18n/useT";
import { useTiposForaDoFunil } from "@/hooks/contatos/useForaDoFunil";
import { cn } from "@/lib/utils";

/**
 * O selo "Fora do funil" (+ o tipo, quando há): equipe, prestador ou parceiro — não é cliente.
 *
 * Só ocupa lugar quando a pessoa está marcada (devolve `null` senão), então pode ser posto em qualquer linha
 * sem decidir antes. O nome do tipo vem da lista da organização (uma consulta só, compartilhada por todos os
 * selos da tela); quem não pode ler a lista vê o selo sem o nome do tipo, nunca um erro.
 */
export function SeloForaDoFunil({
  foraDoFunilEm,
  tipoId,
  className,
}: {
  foraDoFunilEm: string | null | undefined;
  tipoId?: string | null;
  className?: string;
}) {
  const t = useT();
  const tipos = useTiposForaDoFunil({ arquivados: true, enabled: !!foraDoFunilEm && !!tipoId });
  if (!foraDoFunilEm) return null;
  const tipo = tipoId ? tipos.data?.find((x) => x.id === tipoId)?.nome : undefined;
  return (
    <Badge variant="neutral" data-testid="selo-fora-do-funil" className={cn("shrink-0", className)}>
      {t("Fora do funil")}
      {tipo ? ` · ${tipo}` : ""}
    </Badge>
  );
}
