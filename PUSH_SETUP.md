# PWA e notificações push

## Configuração do servidor

Use Node.js e instale as dependências do projeto com `npm install`. Gere um par VAPID uma única vez:

```sh
npx web-push generate-vapid-keys
```

Configure as chaves no ambiente do processo que executa o servidor. Não coloque a chave privada no frontend nem em arquivos versionados:

```sh
export VAPID_PUBLIC_KEY='chave-publica-gerada'
export VAPID_PRIVATE_KEY='chave-privada-gerada'
export VAPID_SUBJECT='mailto:admin@seudominio.com'
export PUSH_ENCRYPTION_KEY="$(openssl rand -hex 32)"
npm start
```

Guarde os valores em um gerenciador de segredos no ambiente de produção. `PUSH_ENCRYPTION_KEY` cifra as inscrições no SQLite; se não for informada, a chave VAPID privada será usada como fonte da chave de cifragem. Mantenha os valores estáveis entre reinícios. Alterar a chave de cifragem impede a leitura das inscrições já armazenadas e exige que os dispositivos ativem push novamente. Alterar o par VAPID também exige reinscrição dos dispositivos.

O app pode ser usado em `http://localhost:3000` para desenvolvimento. Em dispositivos e em produção, publique o site em HTTPS, preservando o mesmo domínio e protocolo para frontend e API. O Service Worker, a instalação e a Web Push API exigem contexto seguro. Configure TLS no servidor/reverse proxy e encaminhe as requisições para a porta da aplicação.

## Testar

1. Inicie o servidor e entre com uma conta existente.
2. Na página de estoque, abra **Notificações** e ative **Receber alertas de estoque**. A permissão do navegador só será solicitada nessa ação.
3. Cadastre ou edite um produto para que a quantidade fique menor ou igual ao estoque mínimo. O alerta informa o nome e a quantidade atual.
4. Altere o produto para quantidade zero para receber o alerta separado de estoque zerado. Repor acima do mínimo e voltar à condição crítica permite um novo alerta.
5. Feche a página e teste novamente após uma alteração de estoque. Clique na notificação para abrir diretamente o estoque.

Inscrições, sessões e estado anti-duplicação são persistidos no `database.db`. A sessão do navegador é um cookie `HttpOnly` com `SameSite=Lax`; em produção, defina `NODE_ENV=production` para habilitar `Secure` (e sirva sempre por HTTPS). No SQLite ficam apenas o hash do token de sessão, o hash do endpoint push e a inscrição cifrada. Cada inscrição pertence ao usuário autenticado e ao grupo dele; endpoints expirados (HTTP 404/410) são removidos automaticamente. Cada usuário pode manter vários dispositivos e desativá-los individualmente.

## Instalação

- **Android:** abra o endereço HTTPS no Chrome, entre na conta e use **Instalar app** ou **Adicionar à tela inicial** no menu. Abra o app instalado antes de ativar as notificações.
- **iPhone/iPad:** no iOS/iPadOS 16.4 ou posterior, abra o endereço no Safari, use **Compartilhar > Adicionar à Tela de Início**, abra o ícone instalado e ative as notificações nas configurações do estoque. Web Push não é habilitado para a aba comum do Safari no iOS.

## Produção

Use HTTPS válido, proteja as variáveis secretas e faça backup do SQLite. O serviço de push do navegador/OS entrega as mensagens, mas o projeto não depende de um provedor comercial; a entrega pode atrasar ou ser limitada pelo sistema operacional. A aplicação atual mantém a autenticação legada por grupo nas demais rotas de estoque; as rotas de inscrição push usam token de sessão emitido pelo login para associar com segurança usuário e grupo. Planeje migrar também as demais rotas para autenticação no servidor antes de expor o sistema publicamente.