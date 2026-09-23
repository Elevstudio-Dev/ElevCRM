"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useT } from "@/hooks/i18n/useT";
import { apiClient } from "@/lib/api/client";
import { CHAVE_DA_INTEGRACAO, useDespachoCerto } from "@/hooks/integrations/useDespachoCerto";

interface RespostaDeConexao {
  conectado: boolean;
  base_url: string;
  webhook_url: string;
  webhook_secret: string | null;
}

/**
 * A tela de conexão, inteira.
 *
 * O SEGREDO DO WEBHOOK aparece UMA vez — no momento em que é gerado. É o padrão
 * dos tokens de API desta base, e a razão é a mesma: um segredo legível para
 * sempre numa tela é um segredo que vaza pelo print de quem estava mostrando
 * outra coisa. Quem perder, gera outro.
 */
export function TelaDaIntegracao() {
  const t = useT();
  const estado = useDespachoCerto();
  const qc = useQueryClient();
  const [baseUrl, setBaseUrl] = useState("");
  const [chave, setChave] = useState("");
  const [segredoNovo, setSegredoNovo] = useState<string | null>(null);

  const conectar = useMutation<RespostaDeConexao, Error, { base_url: string; chave: string }>({
    mutationFn: (dados) =>
      apiClient.put<RespostaDeConexao>("/api/v1/integrations/despachocerto", dados),
    onSuccess: (r) => {
      setSegredoNovo(r.webhook_secret);
      setChave("");
      void qc.invalidateQueries({ queryKey: CHAVE_DA_INTEGRACAO });
      toast.success(t("Integração salva."));
    },
    onError: (e) => toast.error(e.message),
  });

  const atual = estado.data;
  const ligada = atual?.conectado === true;
  const urlPreenchida = baseUrl || atual?.base_url || "";

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Despacho Certo</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {t(
            "Cadastre o cliente sem sair da conversa, e receba a OS e a placa como marcadores.",
          )}
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("Como funciona")}</CardTitle>
          <CardDescription>
            {t(
              "Com a integração ligada, o cabeçalho de cada conversa ganha um botão Cadastrar, ao lado de Assumir. Ele abre o formulário de cliente do Despacho Certo já preenchido com o nome e o telefone de quem está falando — e o cadastro nasce lá. Depois, quando uma OS for aberta para esse cliente, a conversa e o contato recebem os marcadores da OS e da placa.",
            )}
          </CardDescription>
        </CardHeader>

        <CardContent>
          <div className="flex flex-col gap-5">
            <div className="flex items-center gap-2">
              <span className="text-sm text-muted-foreground">{t("Situação:")}</span>
              {estado.isLoading ? (
                <Badge variant="neutral">{t("verificando...")}</Badge>
              ) : ligada ? (
                <Badge variant="success">{t("conectado")}</Badge>
              ) : (
                <Badge variant="neutral">{t("não conectado")}</Badge>
              )}
              {atual?.status_reason ? (
                <span className="text-xs text-warning-fg">{atual.status_reason}</span>
              ) : null}
            </div>

            {/* ── 1. o CRM fala com o Despacho Certo ────────────────────── */}
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="grid gap-1.5">
                <Label htmlFor="dc-url">{t("Endereço do Despacho Certo")}</Label>
                <Input
                  id="dc-url"
                  value={urlPreenchida}
                  onChange={(e) => setBaseUrl(e.target.value)}
                  placeholder="https://app.despachocerto.com.br"
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="dc-chave">{t("Chave de integração")}</Label>
                <Input
                  id="dc-chave"
                  type="password"
                  value={chave}
                  onChange={(e) => setChave(e.target.value)}
                  placeholder={ligada ? "••••••••" : t("cole a chave gerada lá")}
                />
              </div>
            </div>

            <div>
              <Button
                type="button"
                disabled={conectar.isPending || urlPreenchida.length < 8 || chave.trim().length < 8}
                onClick={() => conectar.mutate({ base_url: urlPreenchida.trim(), chave: chave.trim() })}
              >
                {conectar.isPending
                  ? t("Salvando...")
                  : ligada
                    ? t("Salvar e gerar segredo novo")
                    : t("Conectar")}
              </Button>
              {ligada ? (
                <p className="mt-2 text-xs text-muted-foreground">
                  {t("Salvar de novo gera um segredo de webhook novo — o anterior deixa de valer.")}
                </p>
              ) : null}
            </div>

            {/* ── 2. o Despacho Certo avisa o CRM ───────────────────────── */}
            {atual?.webhook_url ? (
              <div className="rounded-md border border-border bg-surface-sunken p-4">
                <p className="text-sm font-medium">{t("Cole isto no Despacho Certo")}</p>
                <div className="mt-3 grid gap-3">
                  <div className="grid gap-1">
                    <span className="text-xs text-muted-foreground">{t("URL do webhook")}</span>
                    <code className="break-all rounded-md bg-muted px-2 py-1 text-xs">
                      {atual.webhook_url}
                    </code>
                  </div>
                  <div className="grid gap-1">
                    <span className="text-xs text-muted-foreground">
                      {t("Segredo da assinatura")}
                    </span>
                    {segredoNovo ? (
                      <code className="break-all rounded-md bg-muted px-2 py-1 text-xs">
                        {segredoNovo}
                      </code>
                    ) : (
                      <span className="text-xs text-muted-foreground">
                        {atual.tem_segredo
                          ? t(
                              "Já existe um segredo. Ele aparece só no momento em que é gerado — salve de novo para criar outro.",
                            )
                          : t("Nenhum segredo ainda. Salve para gerar.")}
                      </span>
                    )}
                  </div>
                </div>
              </div>
            ) : null}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
