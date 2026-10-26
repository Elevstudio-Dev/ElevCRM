---
impacto: capacidade_nova
secao: adicionado
titulo: Uma instalação pode atender vários clientes — você abre cada um com o convite do dono, e o cadastro público fica fechado
---

Até aqui o `/signup` abria uma empresa nova para **qualquer pessoa** que
confirmasse um e-mail. Numa instalação que atende vários clientes (uma VPS, um
banco, cada cliente isolado dentro dela), isso é uma porta aberta: um estranho
abre uma organização, gasta a cota de e-mail e de IA e pode conectar números de
WhatsApp. E a criação de cliente pelo painel da plataforma (`/admin/tenants`)
abria a organização **vazia**: o e-mail do responsável era descartado, e não
havia como entregar o acesso sem mexer no banco.

**Fechar o cadastro.** Ponha `CADASTRO_PUBLICO=false` no `.env` e reinicie o app
(sem rebuild). Com ele, a tela `/signup` só aparece para quem chega por um
convite, o link "Criar conta" some do login, e quem tentar criar conta por fora
da tela (direto no Auth do Supabase) confirma o e-mail e
**não ganha organização nenhuma**, caindo numa mensagem que explica o motivo.
Quem já é membro de uma organização não é afetado: troca de e-mail e links de
confirmação seguem como sempre. O padrão **não muda nada** para quem já instalou: sem a variável (ou com
`true`), o cadastro continua aberto. Qualquer valor que não seja `true` ou vazio
também fecha — errar a grafia (`falso`) não deixa o cadastro aberto em silêncio.

**Abrir um cliente.** Em `/admin/tenants/new`, o e-mail do responsável agora
gera um convite de **administrador** para a organização recém-criada. O e-mail
sai pela marca da instalação; se o envio de e-mail não estiver configurado, a
tela mostra o link para você entregar pelo canal que o cliente usa (o WhatsApp,
por exemplo). O responsável cria a senha pelo link, com aquele mesmo e-mail, e
entra direto na organização dele — sem nunca ter aberto uma própria.

**O convite vale 24 horas.** Se o cliente demorou ou perdeu o e-mail, a ficha do
tenant ganhou o botão **Convidar responsável**, que gera um convite novo. Ele só
funciona para organizações ativas e o papel é sempre administrador.

Se a criação do tenant der certo e o convite falhar, o tenant continua criado e a
tela avisa — não é preciso (nem possível) criá-lo de novo.
