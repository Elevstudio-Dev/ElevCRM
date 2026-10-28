"use client";
import {
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { useT } from "@/hooks/i18n/useT";
import { IDIOMAS } from "@/lib/i18n/idiomas";
import { Check } from "@/lib/ui/icons";
import { useTheme, type Theme } from "@/lib/theme";

import { NOME_DO_IDIOMA, useTrocarDeIdioma } from "./SeletorDeIdioma";

/**
 * Idioma e tema DENTRO do menu do usuário — a versão deles para onde a barra não comporta
 * os botões (abaixo de `lg`, que é onde o resto da casca já troca "mouse" por "toque").
 *
 * Por que existe: no celular a barra tem 351px úteis (375 − respiro), e os dois botões
 * custavam 96 deles. Com eles ali a esquerda ficava com 45px: o hambúrguer era amassado
 * para 16px, o nome da marca nunca aparecia e o seletor de organização passava por cima de
 * Buscar, Chat e Avisos. O orçamento inteiro está no comentário do `TopBar`.
 *
 * Não é um terceiro lugar para manter: a troca de idioma é a MESMA (`useTrocarDeIdioma`,
 * com a recarga que o `SeletorDeIdioma` explica) e o tema vai pelo mesmo `setTheme` do
 * `ThemeToggle`. Só o desenho muda.
 *
 * `lg:hidden` e não "não renderiza": de `lg` em diante os botões da barra aparecem e esta
 * seção some, sem depender de medir a tela em JavaScript — o que daria divergência entre o
 * HTML do servidor e o do cliente.
 */
export function PreferenciasNoMenu() {
  const t = useT();
  const { idioma, escolher, salvando } = useTrocarDeIdioma();
  const { theme, setTheme } = useTheme();

  const temas: { valor: Theme; rotulo: string }[] = [
    { valor: "light", rotulo: t("Claro") },
    { valor: "dark", rotulo: t("Escuro") },
    { valor: "system", rotulo: t("Sistema") },
  ];

  return (
    <div className="lg:hidden" data-testid="preferencias-no-menu">
      <DropdownMenuLabel>{t("Idioma")}</DropdownMenuLabel>
      {IDIOMAS.map((codigo) => (
        <DropdownMenuItem
          key={codigo}
          disabled={salvando}
          onSelect={() => escolher(codigo)}
          data-testid={`menu-idioma-${codigo}`}
          aria-current={codigo === idioma}
        >
          <Check size={16} className={`mr-2 ${codigo === idioma ? "" : "invisible"}`} aria-hidden />
          {NOME_DO_IDIOMA[codigo].completo}
        </DropdownMenuItem>
      ))}
      <DropdownMenuSeparator />
      <DropdownMenuLabel>{t("Tema")}</DropdownMenuLabel>
      {temas.map(({ valor, rotulo }) => (
        <DropdownMenuItem
          key={valor}
          onSelect={() => setTheme(valor)}
          data-testid={`menu-tema-${valor}`}
          aria-current={valor === theme}
        >
          <Check size={16} className={`mr-2 ${valor === theme ? "" : "invisible"}`} aria-hidden />
          {rotulo}
        </DropdownMenuItem>
      ))}
      <DropdownMenuSeparator />
    </div>
  );
}
