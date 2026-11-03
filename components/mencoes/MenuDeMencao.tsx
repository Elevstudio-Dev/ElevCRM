"use client";
import { useEffect, useRef } from "react";

import { useT } from "@/hooks/i18n/useT";
import type { CandidatoDeMencao } from "@/lib/mencoes/tipos";
import { UsersThree } from "@/lib/ui/icons";
import { cn } from "@/lib/utils";

interface Props {
  aberto: boolean;
  itens: ReadonlyArray<CandidatoDeMencao>;
  ativo: number;
  onEscolher: (c: CandidatoDeMencao) => void;
  onHover: (i: number) => void;
  /** Texto pequeno da linha do `@todos` — varia com o lugar (canal, conversa, grupo). */
  detalheDeTodos: string;
  /** Posição: o mesmo canto que o menu de mensagens prontas usa por padrão. */
  className?: string;
}

function iniciais(nome: string): string {
  return nome
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((p) => p[0] ?? "")
    .join("")
    .toUpperCase();
}

/**
 * A lista que abre ao digitar `@` — as pessoas que podem ser marcadas ali.
 *
 * É um `listbox` de verdade (o foco continua no campo; a linha ativa vai em
 * `aria-activedescendant` de quem a usa, e aqui em `aria-selected`). O clique usa
 * `onMouseDown` com `preventDefault` para NÃO tirar o foco do campo: sem isso, o
 * clique fecha a lista antes de escolher e o cursor vai embora do texto.
 */
export function MenuDeMencao({ aberto, itens, ativo, onEscolher, onHover, detalheDeTodos, className }: Props) {
  const t = useT();
  const ativoRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    ativoRef.current?.scrollIntoView({ block: "nearest" });
  }, [ativo, aberto]);

  if (!aberto) return null;
  return (
    <div
      role="listbox"
      aria-label={t("Marcar alguém")}
      data-testid="menu-de-mencao"
      className={cn(
        "absolute bottom-14 left-3 z-20 max-h-56 w-72 overflow-y-auto rounded-lg border border-border bg-popover p-1 shadow-lg",
        className,
      )}
    >
      {itens.map((c, i) => (
        <button
          key={c.id}
          ref={i === ativo ? ativoRef : undefined}
          type="button"
          role="option"
          aria-selected={i === ativo}
          data-testid="opcao-de-mencao"
          data-nome={c.nome}
          onMouseDown={(e) => {
            e.preventDefault();
            onEscolher(c);
          }}
          onMouseEnter={() => onHover(i)}
          className={cn(
            "flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left",
            i === ativo ? "bg-accent text-accent-foreground" : "hover:bg-muted",
          )}
        >
          <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-semibold">
            {c.todos ? <UsersThree size={16} aria-hidden /> : iniciais(c.nome)}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium">{c.todos ? `@${c.nome}` : c.nome}</span>
            <span className="block truncate text-xs text-muted-foreground">
              {c.todos ? detalheDeTodos : c.detalhe}
            </span>
          </span>
        </button>
      ))}
    </div>
  );
}
