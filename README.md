# fantasy_installer

Repositório de build e distribuição do instalador Windows do Neverending Fantasy Map Studio.

## Fluxo

1. O repositório da aplicação (`Horodrigo/neverending_story`) dispara `repository_dispatch` para este repositório quando há push na `main`.
2. Este workflow baixa a versão correspondente do código-fonte.
3. Gera o build web e empacota o app host em `.exe` (NSIS).
4. Publica artefato e release.
