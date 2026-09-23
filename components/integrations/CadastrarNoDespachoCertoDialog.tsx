"use client";

import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useT } from "@/hooks/i18n/useT";
import { useCadastrarNoDespachoCerto } from "@/hooks/integrations/useDespachoCerto";

/**
 * O FORMULÁRIO DE CLIENTE DO DESPACHO CERTO, dentro do Elev CRM.
 *
 * Os campos são os DELE, não os daqui — é o que o dono pediu: "os dados que vão
 * pedir nessa janelinha vão ser os mesmos que são para cadastrar lá". Nome e
 * telefone obrigatórios; documento, e-mail, observações e placa opcionais;
 * pessoa física ou jurídica. Qualquer campo a mais aqui seria um campo que o
 * outro sistema descarta em silêncio.
 *
 * Nome e telefone chegam PREENCHIDOS com o que o WhatsApp já sabe: é a metade
 * do formulário que o atendente não precisa digitar com o cliente esperando.
 *
 * A placa entra no cadastro de propósito, mesmo sendo opcional lá: é ela que
 * vira tag quando a OS chegar, e pedi-la agora evita uma segunda ida ao outro
 * sistema depois.
 */
export interface Props {
  contactId: string;
  nomeSugerido: string;
  telefoneSugerido: string;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}

export function CadastrarNoDespachoCertoDialog({
  contactId,
  nomeSugerido,
  telefoneSugerido,
  open,
  onOpenChange,
}: Props) {
  const t = useT();
  const cadastrar = useCadastrarNoDespachoCerto();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        {/* `key` remonta o formulário a cada abertura: sem isso, abrir noutro
            contato traria os dados digitados no anterior — o mesmo padrão do
            diálogo de parâmetros das mensagens prontas. */}
        <Formulario
          key={`${contactId}-${open}`}
          contactId={contactId}
          nomeSugerido={nomeSugerido}
          telefoneSugerido={telefoneSugerido}
          t={t}
          pendente={cadastrar.isPending}
          onCancelar={() => onOpenChange(false)}
          onEnviar={(dados) => {
            cadastrar.mutate(dados, {
              onSuccess: (r) => {
                toast.success(
                  r.existente
                    ? t("Este telefone já era cliente: vinculado a {nome}.").replace(
                        "{nome}",
                        r.cliente.name,
                      )
                    : t("Cliente cadastrado no Despacho Certo."),
                );
                onOpenChange(false);
              },
              onError: (e) => toast.error(e.message),
            });
          }}
        />
      </DialogContent>
    </Dialog>
  );
}

function Formulario({
  contactId,
  nomeSugerido,
  telefoneSugerido,
  t,
  pendente,
  onCancelar,
  onEnviar,
}: {
  contactId: string;
  nomeSugerido: string;
  telefoneSugerido: string;
  t: (s: string) => string;
  pendente: boolean;
  onCancelar: () => void;
  onEnviar: (dados: {
    contact_id: string;
    name: string;
    phone: string;
    document?: string;
    email?: string;
    notes?: string;
    plate?: string;
    type: "pessoa_fisica" | "pessoa_juridica";
  }) => void;
}) {
  const [name, setName] = useState(nomeSugerido);
  const [phone, setPhone] = useState(telefoneSugerido);
  const [document, setDocument] = useState("");
  const [email, setEmail] = useState("");
  const [plate, setPlate] = useState("");
  const [notes, setNotes] = useState("");
  const [type, setType] = useState<"pessoa_fisica" | "pessoa_juridica">("pessoa_fisica");

  const podeEnviar = name.trim().length >= 2 && phone.trim().length >= 8 && !pendente;

  return (
    <>
      <DialogHeader>
        <DialogTitle>{t("Cadastrar no Despacho Certo")}</DialogTitle>
        <DialogDescription>
          {t("Os mesmos dados que o Despacho Certo pede. O cadastro nasce lá.")}
        </DialogDescription>
      </DialogHeader>

      <div className="grid gap-3 py-2">
        <div className="grid gap-1.5">
          <Label htmlFor="dc-nome">{t("Nome")}</Label>
          <Input
            id="dc-nome"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t("Nome do cliente")}
          />
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="grid gap-1.5">
            <Label htmlFor="dc-telefone">{t("Telefone")}</Label>
            <Input id="dc-telefone" value={phone} onChange={(e) => setPhone(e.target.value)} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="dc-tipo">{t("Tipo")}</Label>
            <Select value={type} onValueChange={(v) => setType(v as typeof type)}>
              <SelectTrigger id="dc-tipo">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="pessoa_fisica">{t("Pessoa física")}</SelectItem>
                <SelectItem value="pessoa_juridica">{t("Pessoa jurídica")}</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="grid gap-1.5">
            <Label htmlFor="dc-documento">
              {type === "pessoa_juridica" ? t("CNPJ") : t("CPF")}
            </Label>
            <Input
              id="dc-documento"
              value={document}
              onChange={(e) => setDocument(e.target.value)}
              placeholder={t("Opcional")}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="dc-placa">{t("Placa do veículo")}</Label>
            <Input
              id="dc-placa"
              value={plate}
              onChange={(e) => setPlate(e.target.value.toUpperCase())}
              placeholder={t("Opcional")}
            />
          </div>
        </div>

        <div className="grid gap-1.5">
          <Label htmlFor="dc-email">{t("E-mail")}</Label>
          <Input
            id="dc-email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder={t("Opcional")}
          />
        </div>

        <div className="grid gap-1.5">
          <Label htmlFor="dc-obs">{t("Observações")}</Label>
          <Textarea
            id="dc-obs"
            rows={2}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder={t("Opcional")}
          />
        </div>
      </div>

      <DialogFooter>
        <Button type="button" variant="outline" onClick={onCancelar} disabled={pendente}>
          {t("Cancelar")}
        </Button>
        <Button
          type="button"
          disabled={!podeEnviar}
          onClick={() =>
            onEnviar({
              contact_id: contactId,
              name: name.trim(),
              phone: phone.trim(),
              document: document.trim() || undefined,
              email: email.trim() || undefined,
              notes: notes.trim() || undefined,
              plate: plate.trim() || undefined,
              type,
            })
          }
        >
          {pendente ? t("Cadastrando...") : t("Cadastrar")}
        </Button>
      </DialogFooter>
    </>
  );
}
