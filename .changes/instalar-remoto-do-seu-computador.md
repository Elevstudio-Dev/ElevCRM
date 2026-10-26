---
impacto: capacidade_nova
secao: adicionado
titulo: Instale o CRM numa VPS a partir do seu computador, sem colar chaves em chat nem no histórico do servidor
---

Novo `hostgator-setup-kit/instalar-remoto.sh`: roda na **sua máquina**, pergunta a
chave e a senha sem eco e as envia à VPS pela entrada padrão do SSH. O segredo não
vira argumento de comando (então não aparece em `ps`), não vai para o histórico do
shell e não passa por ninguém.

Ele fecha o cadastro público (`CADASTRO_PUBLICO=false`), liga a telemetria em `off`,
confere se o nome do CRM aponta para a VPS (sem isso o certificado HTTPS não sai) e
**recusa sobrescrever um `.env` que já existe** — ele guarda as chaves que cifram
dados do banco. Depois acompanha o `install.sh` até o fim, apaga `OWNER_PASSWORD` do
`.env` da VPS e confere o endereço por HTTPS.

`--ensaio` valida tudo o que você digitou e mostra o que seria enviado (chaves
mascaradas) sem conectar em nada. Veja `docs/runbooks/operacao-24h.md`.
