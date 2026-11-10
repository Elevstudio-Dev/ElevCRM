"use client";

import { format } from "date-fns";
import { useState } from "react";
import { toast } from "sonner";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { useT } from "@/hooks/i18n/useT";
import {
  useAtualizarMetaAds,
  useConectarMetaAds,
  useConexaoMetaAds,
  useDesconectarMetaAds,
} from "@/hooks/meta-ads/useMetaAds";
import type { EstadoDaConexaoMeta } from "@/lib/schemas/meta-ads";
import { ArrowsClockwise, CheckCircle, Warning } from "@/lib/ui/icons";

function dataHora(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : format(d, "dd/MM/yy HH:mm");
}

function ComoGerarAChave() {
  const t = useT();
  return (
    <details className="rounded-md border border-border p-3 text-sm">
      <summary className="cursor-pointer font-medium">{t("Como gerar a chave de acesso")}</summary>
      <ol className="mt-3 list-decimal space-y-2 pl-5 text-text-muted">
        <li>{t("Entre no Gerenciador de Negócios da Meta e abra as Configurações do negócio.")}</li>
        <li>{t("Em Usuários, escolha Usuários do sistema e crie um. A função de funcionário basta.")}</li>
        <li>
          {t(
            "Em Contas, escolha Contas de anúncios e adicione esse usuário à conta, só com a permissão de ver o desempenho.",
          )}
        </li>
        <li>
          {t(
            "No usuário do sistema, clique em Gerar novo token, escolha o app do seu negócio e marque somente a permissão ads_read.",
          )}
        </li>
        <li>{t("Copie o token e cole abaixo, junto com o ID da conta de anúncios (aparece no Gerenciador de Anúncios).")}</li>
      </ol>
      <p className="mt-3 text-xs text-text-muted">
        {t("Os nomes dos menus da Meta mudam de vez em quando. A chave é só de leitura: o sistema nunca altera os seus anúncios.")}
      </p>
    </details>
  );
}

function Formulario({ onPronto, onCancelar }: { onPronto: () => void; onCancelar?: () => void }) {
  const t = useT();
  const conectar = useConectarMetaAds();
  const atualizar = useAtualizarMetaAds();
  const [conta, setConta] = useState("");
  const [chave, setChave] = useState("");

  const podeEnviar = conta.trim() !== "" && chave.trim() !== "" && !conectar.isPending;

  async function enviar(e: React.FormEvent) {
    e.preventDefault();
    if (!podeEnviar) return;
    try {
      await conectar.mutateAsync({ ad_account_id: conta, token: chave });
    } catch {
      // O aviso já saiu (`showApiError`); a chave continua no campo para o usuário corrigir.
      return;
    }
    // A chave não fica em memória depois de guardada: nem no campo, nem no cache da mutação.
    setChave("");
    setConta("");
    conectar.reset();
    toast.success(t("Conta conectada. Buscando o gasto dos últimos 90 dias…"));
    atualizar.mutate(undefined, {
      onSuccess: (r) => {
        if (r.mensagem) toast.error(r.mensagem);
        else toast.success(t("Gasto atualizado."));
      },
    });
    onPronto();
  }

  return (
    <form onSubmit={(e) => void enviar(e)} className="flex flex-col gap-4" autoComplete="off">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="meta-conta">{t("ID da conta de anúncios")}</Label>
        <Input
          id="meta-conta"
          name="meta-conta"
          inputMode="numeric"
          placeholder="123456789012345"
          value={conta}
          onChange={(e) => setConta(e.target.value)}
          autoComplete="off"
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="meta-chave">{t("Chave de acesso (somente leitura)")}</Label>
        <Input
          id="meta-chave"
          name="meta-chave"
          type="password"
          value={chave}
          onChange={(e) => setChave(e.target.value)}
          autoComplete="new-password"
          spellCheck={false}
          data-lpignore="true"
        />
        <p className="text-xs text-text-muted">
          {t("A chave é guardada cifrada e nunca volta a aparecer na tela. Para trocá-la, cole outra.")}
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={!podeEnviar}>
          {conectar.isPending ? t("Conferindo na Meta…") : t("Conectar")}
        </Button>
        {onCancelar && (
          <Button type="button" variant="ghost" onClick={onCancelar}>
            {t("Cancelar")}
          </Button>
        )}
      </div>
    </form>
  );
}

function Conectada({ estado, onTrocar }: { estado: EstadoDaConexaoMeta; onTrocar: () => void }) {
  const t = useT();
  const atualizar = useAtualizarMetaAds();
  const desconectar = useDesconectarMetaAds();
  const ultima = dataHora(estado.last_synced_at);
  const comProblema = estado.status !== "conectada";

  return (
    <Card className="flex flex-col gap-4 p-4" data-testid="meta-conectada">
      <div className="flex flex-wrap items-center gap-2">
        {comProblema ? (
          <Warning size={18} aria-hidden className="text-warning" />
        ) : (
          <CheckCircle size={18} aria-hidden className="text-success" />
        )}
        <span className="font-medium">{estado.account_name ?? t("Conta de anúncios")}</span>
        <Badge variant="secondary" className="px-1.5 text-[10px]">
          {estado.ad_account_id}
        </Badge>
        {estado.currency && (
          <Badge variant="outline" className="px-1.5 text-[10px]">
            {estado.currency}
          </Badge>
        )}
      </div>

      {comProblema && estado.last_error && (
        <p className="rounded-md border border-border p-3 text-sm" role="alert">
          {estado.last_error}
        </p>
      )}

      <p className="text-sm text-text-muted">
        {ultima ? `${t("Gasto atualizado em")} ${ultima}.` : t("O gasto ainda não foi atualizado.")}{" "}
        {t("O sistema atualiza sozinho de hora em hora.")}
      </p>

      {estado.currency && estado.currency !== "BRL" && (
        <p className="text-xs text-text-muted">
          {t("A conta de anúncios não está em reais: o gasto aparece na moeda dela e o retorno não é calculado.")}
        </p>
      )}

      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          disabled={atualizar.isPending}
          onClick={() =>
            atualizar.mutate(undefined, {
              onSuccess: (r) => {
                if (r.mensagem) toast.error(r.mensagem);
                else if (r.jaAtualizado) toast.message(t("Já foi atualizado há pouco. Tente de novo em instantes."));
                else toast.success(t("Gasto atualizado."));
              },
            })
          }
        >
          <ArrowsClockwise size={14} aria-hidden className="mr-1.5" />
          {atualizar.isPending ? t("Atualizando…") : t("Atualizar agora")}
        </Button>
        <Button variant="ghost" onClick={onTrocar}>
          {comProblema ? t("Conectar de novo") : t("Trocar a chave")}
        </Button>
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button variant="ghost" disabled={desconectar.isPending}>
              {t("Desconectar")}
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{t("Desconectar a conta de anúncios?")}</AlertDialogTitle>
              <AlertDialogDescription>
                {t(
                  "A chave é apagada e o gasto deixa de ser atualizado. O que já foi trazido da Meta continua nos relatórios.",
                )}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>{t("Cancelar")}</AlertDialogCancel>
              <AlertDialogAction
                onClick={() =>
                  desconectar.mutate(undefined, { onSuccess: () => toast.success(t("Conta desconectada.")) })
                }
              >
                {t("Desconectar")}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </Card>
  );
}

export function MetaAdsClient() {
  const t = useT();
  const conexao = useConexaoMetaAds();
  const [trocando, setTrocando] = useState(false);

  if (conexao.isPending) return <Skeleton className="h-40 w-full max-w-xl" aria-busy="true" />;
  if (conexao.isError) {
    return (
      <div className="flex max-w-xl flex-col items-start gap-3 rounded-md border border-border p-4">
        <p className="text-sm">{t("Não foi possível ler a conexão com a Meta.")}</p>
        <Button variant="outline" onClick={() => void conexao.refetch()}>
          {t("Tentar de novo")}
        </Button>
      </div>
    );
  }

  const estado = conexao.data;
  return (
    <div className="flex max-w-xl flex-col gap-4">
      {estado.conectada && !trocando ? (
        <Conectada estado={estado} onTrocar={() => setTrocando(true)} />
      ) : (
        <Card className="p-4">
          <Formulario onPronto={() => setTrocando(false)} onCancelar={estado.conectada ? () => setTrocando(false) : undefined} />
        </Card>
      )}
      <ComoGerarAChave />
    </div>
  );
}
