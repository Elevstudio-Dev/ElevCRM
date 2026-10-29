"use client";

import Link from "next/link";
import { useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  useCriarTipoForaDoFunil,
  useEditarTipoForaDoFunil,
  useTiposForaDoFunil,
} from "@/hooks/contatos/useForaDoFunil";
import { useT } from "@/hooks/i18n/useT";
import type { TipoForaDoFunil } from "@/lib/schemas/fora-do-funil";

function LinhaDoTipo({ tipo }: { tipo: TipoForaDoFunil }) {
  const t = useT();
  const editar = useEditarTipoForaDoFunil();
  const [editando, setEditando] = useState(false);
  const [nome, setNome] = useState(tipo.nome);
  const arquivado = tipo.arquivado_em !== null;

  const salvar = async () => {
    const novo = nome.trim();
    if (!novo || novo === tipo.nome) {
      setEditando(false);
      setNome(tipo.nome);
      return;
    }
    try {
      await editar.mutateAsync({ id: tipo.id, nome: novo });
      setEditando(false);
    } catch {
      // `onError` já mostrou o motivo (ex.: nome repetido); a linha fica em edição.
    }
  };

  return (
    <li
      data-testid="tipo-fora-do-funil"
      className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-surface px-3 py-2"
    >
      {editando ? (
        <Input
          aria-label={t("Nome do tipo")}
          value={nome}
          maxLength={40}
          autoFocus
          className="h-9 max-w-xs"
          onChange={(e) => setNome(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void salvar();
            if (e.key === "Escape") {
              setEditando(false);
              setNome(tipo.nome);
            }
          }}
        />
      ) : (
        <span className={arquivado ? "text-text-muted line-through" : "font-medium"}>{tipo.nome}</span>
      )}
      {arquivado && <Badge variant="neutral">{t("Arquivado")}</Badge>}
      <span className="ml-auto flex items-center gap-1">
        {editando ? (
          <>
            <Button size="sm" onClick={() => void salvar()} disabled={editar.isPending}>
              {t("Salvar")}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setEditando(false);
                setNome(tipo.nome);
              }}
            >
              {t("Cancelar")}
            </Button>
          </>
        ) : (
          <>
            {!arquivado && (
              <Button size="sm" variant="outline" onClick={() => setEditando(true)}>
                {t("Renomear")}
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost"
              disabled={editar.isPending}
              onClick={() => editar.mutate({ id: tipo.id, arquivado: !arquivado })}
            >
              {arquivado ? t("Reativar") : t("Arquivar")}
            </Button>
          </>
        )}
      </span>
    </li>
  );
}

export function ForaDoFunilClient() {
  const t = useT();
  const tipos = useTiposForaDoFunil({ arquivados: true });
  const criar = useCriarTipoForaDoFunil();
  const [nome, setNome] = useState("");

  const adicionar = async () => {
    const limpo = nome.trim();
    if (!limpo) return;
    try {
      await criar.mutateAsync(limpo);
      setNome("");
    } catch {
      // `onError` já mostrou o motivo (ex.: já existe um tipo com esse nome).
    }
  };

  const ativos = (tipos.data ?? []).filter((x) => x.arquivado_em === null);
  const arquivados = (tipos.data ?? []).filter((x) => x.arquivado_em !== null);

  return (
    <div className="flex max-w-2xl flex-col gap-6">
      <section className="flex flex-col gap-2">
        <label htmlFor="novo-tipo" className="text-sm font-medium">
          {t("Novo tipo")}
        </label>
        <div className="flex gap-2">
          <Input
            id="novo-tipo"
            value={nome}
            maxLength={40}
            placeholder={t("Ex.: Equipe, Contador, Dentista parceiro")}
            onChange={(e) => setNome(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void adicionar();
            }}
          />
          <Button onClick={() => void adicionar()} disabled={!nome.trim() || criar.isPending}>
            {t("Criar tipo")}
          </Button>
        </div>
      </section>

      {tipos.isPending ? (
        <div className="flex flex-col gap-2" aria-busy="true">
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
        </div>
      ) : tipos.isError ? (
        <div className="flex flex-col items-start gap-2 rounded-md border border-border p-4">
          <p className="text-sm">{t("Não foi possível carregar os tipos.")}</p>
          <Button variant="outline" onClick={() => void tipos.refetch()}>
            {t("Tentar de novo")}
          </Button>
        </div>
      ) : (
        <>
          <section className="flex flex-col gap-2">
            <h2 className="text-sm font-medium text-text-muted">{t("Tipos em uso")}</h2>
            {ativos.length === 0 ? (
              <p className="rounded-md border border-dashed border-border p-4 text-sm text-text-muted">
                {t("Nenhum tipo ainda. Sem tipo, o contato continua podendo ser marcado como fora do funil.")}
              </p>
            ) : (
              <ul className="flex flex-col gap-2">
                {ativos.map((tp) => (
                  <LinhaDoTipo key={tp.id} tipo={tp} />
                ))}
              </ul>
            )}
          </section>
          {arquivados.length > 0 && (
            <section className="flex flex-col gap-2">
              <h2 className="text-sm font-medium text-text-muted">{t("Arquivados")}</h2>
              <ul className="flex flex-col gap-2">
                {arquivados.map((tp) => (
                  <LinhaDoTipo key={tp.id} tipo={tp} />
                ))}
              </ul>
            </section>
          )}
        </>
      )}

      <p className="text-sm text-text-muted">
        {t("Para marcar uma pessoa, abra a ficha dela ou a conversa e use")}{" "}
        <strong>{t("Marcar como fora do funil")}</strong>. {t("Para ver quem já está marcado, filtre a lista de")}{" "}
        <Link href="/app/contacts" className="text-accent underline underline-offset-2">
          {t("Contatos")}
        </Link>
        .
      </p>
    </div>
  );
}
