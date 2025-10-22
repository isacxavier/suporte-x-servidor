# Suporte X – Backend de Sinalização

Este diretório contém o servidor Node.js responsável por intermediar a sinalização entre cliente e técnico usando Socket.IO.

## Scripts

```bash
npm install   # instala dependências
npm start     # inicia em modo produção (PORT=3000 por padrão)
npm run dev   # alias para npm start
```

O servidor expõe os arquivos estáticos do painel a partir de `../web/public`.
