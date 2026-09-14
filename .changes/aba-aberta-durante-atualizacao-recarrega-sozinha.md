---
impacto: nada_mudou
secao: corrigido
titulo: Aba aberta durante uma atualização se recupera sozinha — e a tela de erro diz o que aconteceu
---

Quando o sistema é atualizado com uma aba aberta, o próximo clique nessa aba
pedia um pedaço de código que não existe mais e caía em "Algo deu errado", com
um ID de suporte que, numa instalação sem Sentry, não leva a nada — e "Tentar
de novo" não resolvia. Agora a aba reconhece o caso e recarrega sozinha (no
máximo uma vez por minuto, para nunca entrar em laço); se ainda assim voltar, a
tela explica que o sistema foi atualizado e oferece "Recarregar". Nada do que
você fez se perde: é o mesmo F5 de sempre.

E a tela de erro genérica passou a mostrar, além do ID, a mensagem do erro —
para quem opera a instalação saber o que aconteceu sem depender de um serviço
externo.
