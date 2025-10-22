# Suporte X Monorepo

Este repositório concentra tudo o que é necessário para as plataformas Android e Web do Suporte X, bem como o backend de sinalização e a documentação compartilhada.

```
suportex/
├── android/   # projeto Android (appId com.suportex.app)
├── web/       # painel "Central do Técnico" e assets WebRTC
├── server/    # sinalização Socket.IO / backend Render
└── docs/      # diagramas, decisões (ADR), manuais
```

Cada diretório é versionado de forma independente, mas permanece no mesmo repositório para simplificar a colaboração entre as equipes mobile e web.

## Estrutura

### `android/`
Espaço reservado para o aplicativo Android nativo. Adicione aqui o projeto do Android Studio (`app/`, `build.gradle`, etc.).

### `web/`
Contém os arquivos estáticos utilizados pelo painel web e pela captura de tela do cliente (`public/`). O HTML/JS continua leve e sem build steps para facilitar ajustes rápidos.

### `server/`
Servidor Node.js responsável pela sinalização WebRTC com Socket.IO. Ele serve os arquivos estáticos diretamente de `../web/public` e expõe a API usada pelo painel.

Para rodar localmente:

```bash
cd server
npm install
npm start
```

O servidor roda em `http://localhost:3000`.

### `docs/`
Área para documentação compartilhada (diagramas, ADRs, manuais internos, etc.).

## Próximos passos
- [ ] Adicionar o projeto Android dentro de `android/`.
- [ ] Evoluir o front-end em `web/` conforme necessário.
- [ ] Documentar decisões relevantes em `docs/`.

Sinta-se à vontade para ajustar esta estrutura à medida que o projeto evoluir.
