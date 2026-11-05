"use client";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useAuth } from "@/hooks/auth/AuthProvider";
import { useT } from "@/hooks/i18n/useT";
import { useMarcaDaInstalacao } from "@/lib/branding/contexto";
import { Check, DotsThreeVertical, Plus } from "@/lib/ui/icons";

interface Props {
  /**
   * Há filtro de número, setor ou tag para mostrar? Sem isso o menu ⋮ não teria o que oferecer, e
   * controle que não faz nada não entra (é a regra de `controle-decorativo.test.ts`).
   */
  temFiltros: boolean;
  filtrosAbertos: boolean;
  onAlternarFiltros: () => void;
}

/**
 * O topo do painel da lista — o do WhatsApp Web: o NOME do produto em destaque, o nome da EMPRESA que
 * está usando o sistema logo abaixo, menor, e à direita o menu ⋮ e o "+" redondo.
 *
 * - O título é o nome da INSTALAÇÃO (`useMarcaDaInstalacao`), não um texto fixo: numa revenda com marca
 *   própria ele mostra a marca do revendedor, que é o que a regra de marca branca promete.
 * - A empresa é a organização ativa — a do cliente que está logado, não a do produto. Quem pertence a
 *   mais de uma vê aqui, o tempo todo, em qual delas está.
 * - O "+" é "nova conversa": o CRM começa conversa a partir de um contato (a lista de Contatos tem
 *   "Iniciar conversa no Inbox"), então ele leva para lá. Não inventa uma tela nova.
 * - O ⋮ guarda os filtros secundários (número, setor, tag): fora do caminho enquanto não se usa, e
 *   abertos sozinhos quando algum está ligado — filtro ativo nunca fica escondido.
 */
export function CabecalhoDaLista({ temFiltros, filtrosAbertos, onAlternarFiltros }: Props) {
  const t = useT();
  const marca = useMarcaDaInstalacao();
  const { activeOrg } = useAuth();
  const empresa = activeOrg?.marca?.nome ?? activeOrg?.name ?? null;

  return (
    <div className="flex items-start justify-between gap-2" data-testid="cabecalho-da-lista">
      <div className="min-w-0">
        <h1 className="truncate font-heading text-[22px] font-bold leading-7 tracking-tight">{marca.name}</h1>
        {empresa ? (
          <p className="truncate text-xs leading-4 text-muted-foreground" data-testid="empresa-da-lista">
            {empresa}
          </p>
        ) : null}
      </div>

      <div className="flex shrink-0 items-center gap-1">
        {temFiltros ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-10 w-10 rounded-full text-muted-foreground"
                aria-label={t("Mais opções da lista")}
                data-testid="menu-da-lista"
              >
                <DotsThreeVertical size={22} weight="bold" aria-hidden />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-[220px]">
              <DropdownMenuItem onClick={onAlternarFiltros} data-testid="alternar-filtros">
                <Check size={16} className={`mr-2 ${filtrosAbertos ? "" : "invisible"}`} aria-hidden />
                {t("Filtrar por número, setor e tag")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
        <Button
          asChild
          variant="ghost"
          size="icon"
          className="h-10 w-10 rounded-full bg-primary text-primary-foreground hover:bg-primary/90 hover:text-primary-foreground"
        >
          <Link href="/app/contacts" title={t("Nova conversa")} aria-label={t("Nova conversa")} data-testid="nova-conversa">
            <Plus size={20} weight="bold" aria-hidden />
          </Link>
        </Button>
      </div>
    </div>
  );
}
